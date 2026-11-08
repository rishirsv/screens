// Local library: one JSON document per Screen plus a content store of immutable files named by hash.
// Each Screen document is its only commit point: content first (flushed), then temp file, flush, rename.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { catalogHashes, checkScreen, emptyScreen, referencedHashes, syncScreen, type CatalogChange, type LibraryCatalog, type ScreenDoc, type ScreenId } from "@screens/core";
import { openCatalogStore, readCatalogFiles, type StoredReceipt } from "./catalog.ts";

export type { StoredReceipt } from "./catalog.ts";
/** Receipts kept in each Screen file, newest last. */
const DOC_RECEIPTS = 32;

export interface Library {
  readonly root: string;
  /** Unreadable documents are retained in place; collection is suspended until they are repaired. */
  /** Dev fault only, called by the service after authenticating its dev secret. */
  corruptDocument(id: ScreenId, kind: "json" | "schema" | "threads"): void;
  read(id: ScreenId): ScreenDoc | null;
  /** Atomic: after a crash the Screen is at the old or the new revision. Then the catalog takes the document's facts
   *  (an unsynced log line: a crash only means the next load re-derives them). Returns the catalog changes to broadcast.
   *  receipt is written in the same file, so a commit and its receipt land together. */
  write(doc: ScreenDoc, receipt?: StoredReceipt): readonly CatalogChange[];
  /** Permanent delete of a Screen document. The unlink is the commit point. Idempotent. */
  remove(id: ScreenId): void;
  /** The current catalog. Loaded once: snapshot, log replay, then only documents whose file stamp changed are parsed. */
  catalog(): LibraryCatalog;
  /** Applies and appends one change set. durable fsyncs before returning (library operations). receipt rides the same line. */
  commitCatalog(changes: readonly CatalogChange[], durable: boolean, receipt?: StoredReceipt): LibraryCatalog;
  /** Receipts of committed operations found on disk: the last few per Screen file and in the catalog. Complete after recover(). */
  receipts(): readonly StoredReceipt[];
  /** Derived thumbnail cache, keyed by the source hash. Never referenced by a document. */
  readThumb(hash: string): Buffer | null;
  putThumb(hash: string, bytes: Uint8Array): void;
  /** Screen documents parsed since open: listing and searching must not add to it. */
  readonly docReads: number;
  /** Stores bytes once, by hash. Safe to call twice. */
  putContent(bytes: Uint8Array, kind?: "content" | "poster"): string;
  readContent(hash: string): Buffer | null;
  hasContent(hash: string): boolean;
  /** A new, empty staging file. Under staging/, so recover() deletes it at the next start. */
  openStaging(name: string): StagingFile;
  /** Startup recovery: clear staging, delete content no document or Media entry references, and thumbnails whose source is gone. */
  recover(extraRoots?: ReadonlySet<string>): { staging: number; content: number; thumbs: number };
}

/** One file being uploaded. Holds no policy: the caller checks offsets and hashes. */
export interface StagingFile {
  readonly size: number;
  append(bytes: Uint8Array): void;
  /** Flush, rename to content/<hash>, flush the dir. The caller has verified the hash. */
  promote(hash: string): void;
  discard(): void;
}

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export type CommitStep = "after-content-flush" | "after-temp-write" | "after-temp-flush" | "after-rename";
export interface StorageHooks {
  readonly step?: (step: CommitStep) => void;
  readonly writing?: (kind: "content" | "poster" | "document") => void;
}

export function openLibrary(root: string, hooks: StorageHooks = {}): Library {
  const screens = path.join(root, "screens"), content = path.join(root, "content"), staging = path.join(root, "staging"), thumbs = path.join(root, "thumbs");
  for (const d of [screens, content, staging, thumbs]) fs.mkdirSync(d, { recursive: true });
  let docReads = 0;
  const damaged = new Set<string>();

  const fsyncWrite = (file: string, data: string | Uint8Array, kind: "content" | "document") => {
    const fd = fs.openSync(file, "w");
    try {
      hooks.writing?.(kind);
      fs.writeFileSync(fd, data);
      if (kind === "document") hooks.step?.("after-temp-write");
      fs.fsyncSync(fd);
      if (kind === "document") hooks.step?.("after-temp-flush");
    } finally { fs.closeSync(fd); }
  };
  const docPath = (id: ScreenId) => {
    if (!ID.test(id)) throw new Error(`bad screen id ${id}`);
    return path.join(screens, `${id}.json`);
  };

  /** Receipts stored beside each document, by Screen ID. Filled whenever a file is parsed, so a write appends to them. */
  const kept = new Map<ScreenId, readonly StoredReceipt[]>();
  const readFile = (id: ScreenId): ScreenDoc | null => {
    const file = docPath(id);
    try {
      const { receipts, ...raw } = JSON.parse(fs.readFileSync(file, "utf8")) as { receipts?: StoredReceipt[] };
      const checked = checkScreen(raw); docReads++;
      if (receipts !== undefined && !Array.isArray(receipts)) throw new Error("invalid operation receipts");
      if (!checked.ok || checked.doc.id !== id) throw new Error("invalid Screen document");
      kept.set(id, receipts ?? []);
      damaged.delete(id);
      return checked.doc;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") { damaged.delete(id); return null; }
      damaged.add(id);
      // Neither parser excerpts nor filesystem paths belong in a diagnostic sent to clients.
      console.error(`Screen ${id} is damaged: ${(e as Error).message}`);
      throw Object.assign(new Error("This Screen is damaged and could not be opened. Its files have been kept. Other Screens are available in the Library."), { code: "corrupt" });
    }
  };
  const stampOf = (id: ScreenId): string | null => { try { const st = fs.statSync(docPath(id)); return `${st.mtimeMs}:${st.size}`; } catch { return null; } };
  const ids = () => fs.readdirSync(screens).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((id) => ID.test(id));

  // Load the catalog and reconcile it with the documents on disk by file stamp.
  const store = openCatalogStore(root);
  {
    const changes: CatalogChange[] = [], stamps: Record<string, string | null> = {};
    let cat = store.get();
    const present = new Set(ids());
    for (const id of present) {
      const st = stampOf(id);
      // Facts with items but nothing to show predate the poster fallback for unchecked objects: derive them again.
      const f = cat.screens[id]?.facts, stale = !!f && f.cover === null && f.itemCount > 0 && !f.coverObject?.width;
      if (st && st === store.stamp(id) && cat.screens[id] && !stale) continue;
      let doc: ScreenDoc | null = null;
      try { doc = readFile(id); } catch {
        if (!cat.screens[id]) {
          const c = syncScreen(cat, emptyScreen(id, "Damaged Screen", 0));
          if (c) { changes.push(c); cat = { ...cat, screens: { ...cat.screens, [id]: c.entry! } } as LibraryCatalog; }
        }
        continue;
      }
      if (!doc) continue;
      const c = syncScreen(cat, doc);
      if (c) { changes.push(c); cat = { ...cat, screens: { ...cat.screens, [id]: c.entry! } } as LibraryCatalog; }
      stamps[id] = st;
    }
    for (const id of Object.keys(cat.screens)) if (!present.has(id)) { changes.push({ k: "screen", id, entry: null }); stamps[id] = null; }
    if (changes.length || Object.keys(stamps).length) store.commit(changes, true, stamps);
  }

  const catalog = (): LibraryCatalog => {
    const cat = store.get();
    if (!damaged.size && !Object.values(cat.screens).some((e) => e.damaged)) return cat;
    return { ...cat, screens: Object.fromEntries(Object.entries(cat.screens).map(([id, e]) => {
      const { damaged: _diagnostic, ...entry } = e;
      return [id, damaged.has(id) ? { ...entry, damaged: true } : entry];
    })) };
  };

  return {
    root,
    get docReads() { return docReads; },
    corruptDocument(id, kind) {
      const file = docPath(id);
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, kind === "json" ? "{broken" : JSON.stringify({ ...doc, ...(kind === "threads" ? { threads: null } : { items: null }) }));
    },
    catalog,
    commitCatalog: (changes, durable, receipt) => { store.commit(changes, durable, undefined, receipt); return catalog(); },
    receipts: () => [...[...kept.values()].flat(), ...store.receipts()],
    read: readFile,
    write(doc, receipt) {
      // Every referenced byte was already flushed by upload/poster storage before entering this commit.
      hooks.step?.("after-content-flush");
      const target = docPath(doc.id);
      const tmp = path.join(staging, `${doc.id}.${process.pid}.${Date.now()}.json`);
      if (!kept.has(doc.id) && fs.existsSync(target)) readFile(doc.id);
      const receipts = receipt ? [...(kept.get(doc.id) ?? []), receipt].slice(-DOC_RECEIPTS) : kept.get(doc.id) ?? [];
      try { fsyncWrite(tmp, JSON.stringify(receipts.length ? { ...doc, receipts } : doc), "document"); fs.renameSync(tmp, target); }
      catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* startup recovery retries cleanup */ } throw e; }
      hooks.step?.("after-rename");
      kept.set(doc.id, receipts);
      // The rename is the commit point. A failed directory flush after it must not report the commit as failed.
      try { const dir = fs.openSync(screens, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* committed */ }
      // The rename above committed the Screen. The catalog only derives from it, so a failed append must not fail the
      // Screen: without the new stamp, the next load re-reads this document and derives its facts again.
      try {
        const c = syncScreen(store.get(), doc);
        store.commit(c ? [c] : [], false, { [doc.id]: stampOf(doc.id) });
        return c ? [c] : [];
      } catch (e) {
        console.error(`library catalog: facts for ${doc.id} not recorded: ${(e as Error).message}`);
        return [];
      }
    },
    remove(id) {
      fs.rmSync(docPath(id), { force: true }); damaged.delete(id); kept.delete(id);
      try { const dir = fs.openSync(screens, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* removed */ }
    },
    readThumb(hash) {
      if (!HASH.test(hash)) return null;
      try { return fs.readFileSync(path.join(thumbs, `${hash}.jpg`)); } catch { return null; }
    },
    putThumb(hash, bytes) {
      if (!HASH.test(hash)) return;
      const tmp = path.join(staging, `thumb.${hash}.${crypto.randomUUID()}`);
      fs.writeFileSync(tmp, bytes); fs.renameSync(tmp, path.join(thumbs, `${hash}.jpg`));
    },
    putContent(bytes, kind = "content") {
      const hash = crypto.createHash("sha256").update(bytes).digest("hex");
      const target = path.join(content, hash);
      if (!fs.existsSync(target)) {
        const tmp = path.join(staging, `${hash}.${process.pid}.${crypto.randomUUID()}`);
        try { if (kind === "poster") hooks.writing?.("poster"); fsyncWrite(tmp, bytes, "content"); fs.renameSync(tmp, target); }
        finally { fs.rmSync(tmp, { force: true }); }
        // Flush the directory so a committed document never references a content file a power loss dropped.
        const dir = fs.openSync(content, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
      return hash;
    },
    readContent(hash) {
      if (!HASH.test(hash)) return null;
      try { return fs.readFileSync(path.join(content, hash)); } catch { return null; }
    },
    hasContent(hash) { return HASH.test(hash) && fs.existsSync(path.join(content, hash)); },
    openStaging(name) {
      if (!/^[\w.-]{1,120}$/.test(name)) throw new Error(`bad staging name ${name}`);
      const file = path.join(staging, `upload.${name}.${process.pid}.${crypto.randomUUID()}`);
      const fd = fs.openSync(file, "w");
      let size = 0, open = true;
      const close = () => { if (open) { open = false; fs.closeSync(fd); } };
      return {
        get size() { return size; },
        append(bytes) { hooks.writing?.("content"); fs.writeFileSync(fd, bytes); size += bytes.length; },
        promote(hash) {
          if (!HASH.test(hash)) throw new Error(`bad hash ${hash}`);
          fs.fsyncSync(fd); close();
          fs.renameSync(file, path.join(content, hash));
          const dir = fs.openSync(content, "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        },
        discard() { close(); fs.rmSync(file, { force: true }); },
      };
    },
    recover(extraRoots = new Set()) {
      let stagingCount = 0, contentCount = 0, thumbCount = 0;
      for (const f of fs.readdirSync(staging)) { fs.rmSync(path.join(staging, f), { force: true }); stagingCount++; }
      const keep = new Set([...extraRoots, ...catalogHashes(store.get())]);
      for (const id of ids()) {
        try { const doc = readFile(id); if (doc) for (const h of referencedHashes(doc)) keep.add(h); } catch { /* retained, collection suspended below */ }
      }
      if (damaged.size) return { staging: stagingCount, content: 0, thumbs: 0 };
      for (const f of fs.readdirSync(content)) if (!keep.has(f)) { fs.rmSync(path.join(content, f), { force: true }); contentCount++; }
      for (const f of fs.readdirSync(thumbs)) if (!keep.has(f.replace(/\.jpg$/, ""))) { fs.rmSync(path.join(thumbs, f), { force: true }); thumbCount++; }
      return { staging: stagingCount, content: contentCount, thumbs: thumbCount };
    },
  };
}

export interface LibraryStats {
  readonly screens: readonly { readonly id: ScreenId; readonly revision: number; readonly bytes: number; readonly doc: ScreenDoc }[];
  readonly content: { readonly files: number; readonly bytes: number; readonly hashes: readonly string[] };
  readonly thumbs: { readonly files: number; readonly hashes: readonly string[] };
  /** Files left in staging: non-zero only between a crash and the next recovery. */
  readonly staging: number;
  readonly damaged: number;
  readonly collectionSuspended: boolean;
  /** Content files no Screen or Media entry references; null while damaged documents make references unknown. */
  readonly orphans: number | null;
  readonly catalog: { readonly version: number; readonly logLines: number; readonly folders: number; readonly screens: number; readonly media: number; readonly archived: number };
}

/** Read-only statistics for screens-cli. Creates nothing and writes nothing, so it is safe while the service is down. */
export function inspectLibrary(root: string): LibraryStats {
  const dir = (d: string) => { try { return fs.readdirSync(path.join(root, d)); } catch { return []; } };
  const size = (f: string) => { try { return fs.statSync(path.join(root, f)).size; } catch { return 0; } };
  const files = readCatalogFiles(root);
  const keep = catalogHashes(files.catalog);
  let damagedCount = 0;
  const screens = dir("screens").filter((f) => f.endsWith(".json")).flatMap((f) => {
    try {
      const { receipts: _receipts, ...raw } = JSON.parse(fs.readFileSync(path.join(root, "screens", f), "utf8"));
      const checked = checkScreen(raw);
      if (!checked.ok || checked.doc.id !== f.slice(0, -5)) throw new Error("damaged");
      const doc = checked.doc;
      for (const h of referencedHashes(doc)) keep.add(h);
      return [{ id: doc.id, revision: doc.revision, bytes: size(path.join("screens", f)), doc }];
    } catch { damagedCount++; return []; }
  });
  const content = dir("content");
  return {
    screens,
    content: { files: content.length, bytes: content.reduce((n, f) => n + size(path.join("content", f)), 0), hashes: [...content].sort() },
    thumbs: { files: dir("thumbs").length, hashes: dir("thumbs").sort() },
    staging: dir("staging").length,
    damaged: damagedCount, collectionSuspended: damagedCount > 0,
    orphans: damagedCount ? null : content.filter((f) => !keep.has(f)).length,
    catalog: { version: files.catalog.version, logLines: files.logLines, folders: Object.keys(files.catalog.folders).length, screens: Object.keys(files.catalog.screens).length,
      media: Object.keys(files.catalog.media).length,
      archived: [...Object.values(files.catalog.folders), ...Object.values(files.catalog.screens), ...Object.values(files.catalog.media)].filter((e) => e.archivedAt !== null).length },
  };
}
