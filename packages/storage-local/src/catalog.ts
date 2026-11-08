// The library catalog on disk: catalog.json { seq, catalog, stamps } plus catalog.log, one JSON line { seq, changes, stamps? }
// per change set. Internal to storage-local. A torn last line is ignored: nothing was acknowledged before its fsync.
// stamps: ScreenId → "mtimeMs:size" of the document file the facts came from, so a load re-reads only changed documents.
// receipt: the library operation the line commits, so its outcome survives a crash between the append and the answer.

import fs from "node:fs";
import path from "node:path";
import { applyChanges, emptyCatalog, type CatalogChange, type LibraryCatalog } from "@screens/core";

const COMPACT_LINES = 2000, COMPACT_BYTES = 2e6, RECEIPTS = 256;

/** A committed operation's receipt as storage keeps it. payload is the service's digest of the request; outcome is opaque here. */
export interface StoredReceipt { readonly opId: string; readonly screenId: string; readonly payload: string; readonly outcome: unknown }

interface Snapshot { readonly seq: number; readonly catalog: LibraryCatalog; readonly stamps: Record<string, string>; readonly receipts?: readonly StoredReceipt[] }
interface Line { readonly seq: number; readonly changes: readonly CatalogChange[]; readonly stamps?: Record<string, string | null>; readonly receipt?: StoredReceipt }

export interface CatalogFiles { readonly catalog: LibraryCatalog; readonly stamps: Record<string, string>; readonly receipts: readonly StoredReceipt[]; readonly logLines: number; readonly logBytes: number }

/** Reads snapshot plus log without writing anything. Safe while the service is down. */
export function readCatalogFiles(dir: string): CatalogFiles {
  let snap: Snapshot = { seq: 0, catalog: emptyCatalog(), stamps: {} };
  try { snap = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json"), "utf8")) as Snapshot; } catch { /* first run */ }
  let catalog = snap.catalog;
  const stamps = { ...snap.stamps };
  const receipts = [...(snap.receipts ?? [])];
  let text = "";
  try { text = fs.readFileSync(path.join(dir, "catalog.log"), "utf8"); } catch { /* none */ }
  let logLines = 0;
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    let line: Line;
    try { line = JSON.parse(raw) as Line; } catch { break; } // torn tail
    logLines++;
    // Before the seq check: a line already in the snapshot repeats a receipt the snapshot holds, which is harmless.
    if (line.receipt) receipts.push(line.receipt);
    if (line.seq <= catalog.version) continue;
    catalog = { ...applyChanges(catalog, line.changes), version: line.seq };
    for (const [id, s] of Object.entries(line.stamps ?? {})) { if (s === null) delete stamps[id]; else stamps[id] = s; }
  }
  return { catalog, stamps, receipts: receipts.slice(-RECEIPTS), logLines, logBytes: Buffer.byteLength(text) };
}

export interface CatalogStore {
  get(): LibraryCatalog;
  /** Applies one change set and appends it. durable fsyncs before returning. */
  commit(changes: readonly CatalogChange[], durable: boolean, stamps?: Record<string, string | null>, receipt?: StoredReceipt): LibraryCatalog;
  stamp(id: string): string | undefined;
  /** Receipts of the latest library operations, newest last. */
  receipts(): readonly StoredReceipt[];
}

export function openCatalogStore(dir: string): CatalogStore {
  const logPath = path.join(dir, "catalog.log"), snapPath = path.join(dir, "catalog.json");
  const loaded = readCatalogFiles(dir);
  let catalog = loaded.catalog, lines = loaded.logLines, bytes = loaded.logBytes;
  const stamps = loaded.stamps;
  let receipts = loaded.receipts;
  // Keep only the replayable prefix, one record per line, so the next append starts on a clean line.
  // That also repairs a complete last record whose newline never reached the disk.
  if (fs.existsSync(logPath)) {
    const text = fs.readFileSync(logPath, "utf8");
    const keep: string[] = [];
    for (const l of text.split("\n")) { if (!l) continue; try { JSON.parse(l); keep.push(l); } catch { break; } }
    const clean = keep.map((l) => l + "\n").join("");
    if (clean !== text) { writeDurably(logPath, clean); bytes = Buffer.byteLength(clean); }
  }
  let fd = fs.openSync(logPath, "a");
  /** Set when an fsync failed: the line may or may not be on disk, so this process stops writing until a restart replays the truth. */
  let broken: Error | null = null;

  const compact = () => {
    const tmp = `${snapPath}.${process.pid}.tmp`;
    writeDurably(tmp, JSON.stringify({ seq: catalog.version, catalog, stamps, receipts } satisfies Snapshot));
    fs.renameSync(tmp, snapPath);
    // The rename must be durable before the log it replaces is emptied.
    syncDir(dir);
    // A crash before truncation is harmless: replay skips lines with seq <= the snapshot's.
    fs.closeSync(fd); writeDurably(logPath, ""); fd = fs.openSync(logPath, "a");
    lines = 0; bytes = 0;
  };

  return {
    get: () => catalog,
    stamp: (id) => stamps[id],
    receipts: () => receipts,
    commit(changes, durable, st, receipt) {
      if (broken) throw new Error(`the library catalog stopped accepting writes after a failed flush: ${broken.message}`);
      if (changes.length === 0 && !st && !receipt) return catalog;
      // Stage, write, then install: a failed append leaves memory as it was on disk.
      const next = applyChanges(catalog, changes);
      const line = JSON.stringify({ seq: next.version, changes, ...(st ? { stamps: st } : {}), ...(receipt ? { receipt } : {}) } satisfies Line) + "\n";
      fs.writeSync(fd, line);
      if (durable) { try { fs.fsyncSync(fd); } catch (e) { broken = e as Error; throw e; } }
      catalog = next;
      if (receipt) receipts = [...receipts, receipt].slice(-RECEIPTS);
      for (const [id, s] of Object.entries(st ?? {})) { if (s === null) delete stamps[id]; else stamps[id] = s; }
      lines++; bytes += line.length;
      if (lines > COMPACT_LINES || bytes > COMPACT_BYTES) { try { compact(); } catch { /* the log still holds every line; compaction retries on the next commit */ } }
      return catalog;
    },
  };
}

function writeDurably(file: string, data: string): void {
  const f = fs.openSync(file, "w");
  try { fs.writeSync(f, data); fs.fsyncSync(f); } finally { fs.closeSync(f); }
}
function syncDir(dir: string): void {
  const d = fs.openSync(dir, "r");
  try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
}
