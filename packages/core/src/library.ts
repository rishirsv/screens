// The library catalog: folders, per-Screen library state and the Media collection. Pure.
// Facts about a Screen (title, cover, counts) are derived from its document by screenFacts() and never edited by an
// operation. Folder, archive and last-opened state, and all of Media, are written only by library operations here.

import type { Author, CanvasItem, ItemId, PagedLayout, ScreenDoc, ScreenId, Revision } from "./model.ts";
import { pageOrder } from "./pages.ts";
import type { OperationError } from "./operations.ts";
import type { ImageInfo, ImageType } from "./image.ts";
import { CLIENT_ID, FOLDERS_MAX, MEDIA_DESCRIPTION_MAX, MEDIA_FIELD_MAX, MEDIA_MAX, MEDIA_SOURCE_MAX, MEDIA_TAGS_MAX, MEDIA_TAG_MAX, TITLE_MAX } from "./limits.ts";

export type FolderId = string;
export type MediaId = string;

export interface FolderEntry { readonly id: FolderId; readonly name: string; readonly createdAt: number; readonly archivedAt: number | null; readonly revision: Revision }

/** Derived from the Screen document only. */
export interface ScreenFacts {
  readonly title: string; readonly createdAt: number; readonly updatedAt: number; readonly docRevision: Revision; readonly itemCount: number;
  /** The tile image: the poster of the top-left object, else the top-left reference image. On a Presentation or
   *  Document: the first page's poster or image. */
  readonly cover: string | null;
  /** No stored poster to show (objects saved without a load check): the tile asks for this object's poster, at its
   *  size. The first page of a Presentation or Document, else the top-left object of a canvas. */
  readonly coverObject?: { readonly itemId: ItemId; readonly contentVersion: string; readonly width: number; readonly height: number };
  /** Absent on a canvas, so facts written before layouts existed stay correct. */
  readonly layout?: PagedLayout;
  /** Reference-image asset hashes, for "Used in". */
  readonly imageHashes: readonly string[];
}

export interface ScreenEntry {
  /** Storage recovery diagnostic; an unreadable document is retained in place. */
  readonly damaged?: boolean;
  readonly id: ScreenId;
  readonly folderId: FolderId | null;
  /** Archived on its own. A Screen in an archived folder also counts as archived (isScreenArchived). */
  readonly archivedAt: number | null;
  /** View state: written by noteOpened, never by an operation or an undo. */
  readonly lastOpenedAt: number | null;
  readonly revision: Revision;
  readonly facts: ScreenFacts;
}

export interface MediaMeta {
  readonly description: string; readonly app: string; readonly platform: string; readonly screenType: string;
  /** Lower-cased, trimmed, unique. */
  readonly tags: readonly string[];
  readonly source: string;
  readonly capturedAt: number | null;
}

/** An image in the Media collection. Type and size come from the bytes (LibraryContext.images), never from a client. */
export interface MediaEntry {
  readonly id: MediaId; readonly title: string;
  readonly assetHash: string; readonly mediaType: ImageType; readonly width: number; readonly height: number;
  readonly meta: MediaMeta;
  readonly addedAt: number; readonly addedBy: Author;
  readonly archivedAt: number | null;
  readonly revision: Revision;
}

export interface LibraryCatalog {
  readonly schemaVersion: 1;
  /** Bumps once per applied change set. */
  readonly version: number;
  readonly folders: Readonly<Record<FolderId, FolderEntry>>;
  readonly screens: Readonly<Record<ScreenId, ScreenEntry>>;
  readonly media: Readonly<Record<MediaId, MediaEntry>>;
}

/** Whole-record upsert (entry) or removal (null). The one change shape for the log, the broadcast and the client. Idempotent. */
export type CatalogChange =
  | { readonly k: "folder"; readonly id: FolderId; readonly entry: FolderEntry | null }
  | { readonly k: "screen"; readonly id: ScreenId; readonly entry: ScreenEntry | null }
  | { readonly k: "media"; readonly id: MediaId; readonly entry: MediaEntry | null };

export type LibraryRef = { readonly kind: "screen" | "folder" | "media"; readonly id: string };
export interface NewMedia { readonly id: MediaId; readonly assetHash: string; readonly title: string; readonly meta?: Partial<MediaMeta> }
export type MediaPatch = Partial<MediaMeta> & { readonly title?: string };

export type LibraryOperation =
  | { readonly type: "createFolder"; readonly folder: { readonly id: FolderId; readonly name: string } }
  | { readonly type: "renameFolder"; readonly folderId: FolderId; readonly name: string }
  /** folderId null takes Screens out of their folder. */
  | { readonly type: "moveScreens"; readonly screenIds: readonly ScreenId[]; readonly folderId: FolderId | null }
  /** Archiving a folder writes one mark: its Screens count as archived through it. */
  | { readonly type: "archive"; readonly targets: readonly LibraryRef[] }
  /** Restoring a Screen whose folder is still archived takes it out of that folder. */
  | { readonly type: "restore"; readonly targets: readonly LibraryRef[] }
  | { readonly type: "addMedia"; readonly media: NewMedia }
  | { readonly type: "updateMedia"; readonly mediaId: MediaId; readonly patch: MediaPatch; readonly expectedRevision?: Revision }
  | { readonly type: "batch"; readonly ops: readonly LibraryOperation[] };

export interface LibraryContext {
  readonly now: number;
  readonly author: Author;
  /** hash → what the service read from the bytes. addMedia refuses a hash missing here. */
  readonly images: ReadonlyMap<string, ImageInfo>;
}

type AnyEntry = FolderEntry | ScreenEntry | MediaEntry;
/** Restoring `before` happens only if the record's owned fields still equal `after`. */
export interface LibraryInverse { readonly entries: readonly { readonly k: CatalogChange["k"]; readonly id: string; readonly before: AnyEntry | null; readonly after: AnyEntry | null }[] }

export type LibraryTransition =
  | { readonly ok: false; readonly error: OperationError }
  | { readonly ok: true; readonly catalog: LibraryCatalog; readonly changes: readonly CatalogChange[]; readonly inverse: LibraryInverse };

export function emptyCatalog(): LibraryCatalog { return { schemaVersion: 1, version: 0, folders: {}, screens: {}, media: {} }; }

/** The one reducer for change sets: storage replay, the service and the client all use it. */
export function applyChanges(cat: LibraryCatalog, changes: readonly CatalogChange[]): LibraryCatalog {
  if (changes.length === 0) return cat;
  // Copy only the collections a change touches: a Screen commit must not copy every Media entry.
  const copies: Partial<Record<CatalogChange["k"], Record<string, AnyEntry>>> = {};
  const src = { folder: cat.folders, screen: cat.screens, media: cat.media } as Record<CatalogChange["k"], Readonly<Record<string, AnyEntry>>>;
  for (const c of changes) {
    const map = (copies[c.k] ??= { ...src[c.k] });
    if (c.entry) map[c.id] = c.entry; else delete map[c.id];
  }
  return { ...cat, version: cat.version + 1, folders: (copies.folder ?? cat.folders) as LibraryCatalog["folders"], screens: (copies.screen ?? cat.screens) as LibraryCatalog["screens"], media: (copies.media ?? cat.media) as LibraryCatalog["media"] };
}

// ── Facts ──

export function screenFacts(doc: ScreenDoc): ScreenFacts {
  const items = Object.values(doc.items);
  if (doc.layout) {
    const first = pageOrder(items)[0];
    const cover = !first ? null : first.kind === "reference-image" ? first.assetHash : first.posterHash;
    const coverObject = first?.kind === "html-snapshot" && !first.posterHash ? { itemId: first.id, contentVersion: first.contentVersion, width: first.width, height: first.height } : undefined;
    return { title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt, docRevision: doc.revision, itemCount: items.length, cover, ...(coverObject ? { coverObject } : {}),
      imageHashes: imageHashesOf(items), layout: doc.layout };
  }
  const byPlace = (a: { x: number; y: number }, b: { x: number; y: number }) => a.y - b.y || a.x - b.x;
  const poster = items.filter((i) => i.kind === "html-snapshot" && i.posterHash).sort(byPlace)[0];
  const image = items.filter((i) => i.kind === "reference-image").sort(byPlace)[0];
  const cover = poster?.kind === "html-snapshot" ? poster.posterHash : image?.kind === "reference-image" ? image.assetHash : null;
  const unchecked = cover ? undefined : items.filter((i) => i.kind === "html-snapshot").sort(byPlace)[0];
  const coverObject = unchecked?.kind === "html-snapshot" ? { itemId: unchecked.id, contentVersion: unchecked.contentVersion, width: unchecked.width, height: unchecked.height } : undefined;
  const imageHashes = imageHashesOf(items);
  return { title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt, docRevision: doc.revision, itemCount: items.length, cover, ...(coverObject ? { coverObject } : {}), imageHashes };
}

/** After a Screen commit or a reconcile: the entry with new facts and its owned fields kept. null when nothing changed. */
const imageHashesOf = (items: readonly CanvasItem[]) => [...new Set(items.flatMap((i) => (i.kind === "reference-image" ? [i.assetHash] : [])))].sort();

export function syncScreen(cat: LibraryCatalog, doc: ScreenDoc): CatalogChange | null {
  const facts = screenFacts(doc), cur = cat.screens[doc.id];
  if (cur && same(cur.facts, facts)) return null;
  const entry: ScreenEntry = cur ? { ...cur, facts } : { id: doc.id, folderId: null, archivedAt: null, lastOpenedAt: null, revision: cat.version + 1, facts };
  return { k: "screen", id: doc.id, entry };
}

export const OPENED_RESOLUTION_MS = 60_000;
/** View state. null when unchanged within OPENED_RESOLUTION_MS, or the Screen is unknown. */
export function noteOpened(cat: LibraryCatalog, id: ScreenId, now: number): CatalogChange | null {
  const cur = cat.screens[id];
  if (!cur || (cur.lastOpenedAt !== null && now - cur.lastOpenedAt < OPENED_RESOLUTION_MS)) return null;
  return { k: "screen", id, entry: { ...cur, lastOpenedAt: now } };
}

/** Every content hash the catalog keeps alive: all media, archived or not. Screens count through their own documents. */
export function catalogHashes(cat: LibraryCatalog): Set<string> {
  return new Set(Object.values(cat.media).map((m) => m.assetHash));
}

export function isScreenArchived(cat: LibraryCatalog, id: ScreenId): boolean {
  const s = cat.screens[id]; if (!s) return false;
  return s.archivedAt !== null || (s.folderId !== null && (cat.folders[s.folderId]?.archivedAt ?? null) !== null);
}

/** What a permanent delete removes. Only archived things qualify; a folder takes its Screens with it.
 *  "all" means everything in Archive. The service removes the Screen files first, then commits `changes`. */
export function purgePlan(cat: LibraryCatalog, targets: readonly LibraryRef[] | "all"): { readonly screens: readonly ScreenId[]; readonly changes: readonly CatalogChange[] } | OperationError {
  const refs: LibraryRef[] = targets === "all"
    ? [...Object.values(cat.folders).filter((f) => f.archivedAt !== null).map((f) => ({ kind: "folder" as const, id: f.id })),
       ...Object.keys(cat.screens).filter((id) => isScreenArchived(cat, id)).map((id) => ({ kind: "screen" as const, id })),
       ...Object.values(cat.media).filter((m) => m.archivedAt !== null).map((m) => ({ kind: "media" as const, id: m.id }))]
    : [...targets];
  const screens = new Set<ScreenId>(), changes = new Map<string, CatalogChange>();
  for (const r of refs) {
    if (r.kind === "media") {
      const m = cat.media[r.id]; if (!m) return { code: "not-found", message: `media ${r.id} not found` };
      if (m.archivedAt === null) return { code: "invalid", message: `media ${r.id} is not archived` };
      changes.set(`m:${r.id}`, { k: "media", id: r.id, entry: null });
    } else if (r.kind === "folder") {
      const f = cat.folders[r.id]; if (!f) return { code: "not-found", message: `folder ${r.id} not found` };
      if (f.archivedAt === null) return { code: "invalid", message: `folder ${r.id} is not archived` };
      changes.set(`f:${r.id}`, { k: "folder", id: r.id, entry: null });
      for (const s of Object.values(cat.screens)) if (s.folderId === r.id) { screens.add(s.id); changes.set(`s:${s.id}`, { k: "screen", id: s.id, entry: null }); }
    } else {
      if (!cat.screens[r.id]) return { code: "not-found", message: `Screen ${r.id} not found` };
      if (!isScreenArchived(cat, r.id)) return { code: "invalid", message: `Screen ${r.id} is not archived` };
      screens.add(r.id); changes.set(`s:${r.id}`, { k: "screen", id: r.id, entry: null });
    }
  }
  if (changes.size === 0) return { code: "invalid", message: "nothing to delete" };
  return { screens: [...screens], changes: [...changes.values()] };
}

// ── Operations ──

class Fail extends Error {
  readonly code: OperationError["code"];
  constructor(code: OperationError["code"], message: string) { super(message); this.code = code; }
}
const fail = (code: OperationError["code"], message: string): never => { throw new Fail(code, message); };

interface Draft { folders: Record<string, FolderEntry>; screens: Record<string, ScreenEntry>; media: Record<string, MediaEntry>; version: number; entries: { k: CatalogChange["k"]; id: string; before: AnyEntry | null; after: AnyEntry | null }[] }
const draftOf = (cat: LibraryCatalog): Draft => ({ folders: { ...cat.folders }, screens: { ...cat.screens }, media: { ...cat.media }, version: cat.version + 1, entries: [] });
const mapOf = (d: Draft, k: CatalogChange["k"]) => (k === "folder" ? d.folders : k === "screen" ? d.screens : d.media) as Record<string, AnyEntry>;

function put(d: Draft, k: CatalogChange["k"], id: string, next: AnyEntry | null): void {
  const map = mapOf(d, k), before = map[id] ?? null;
  if (next) map[id] = next; else delete map[id];
  d.entries.push({ k, id, before, after: next });
}

function finish(cat: LibraryCatalog, d: Draft): LibraryTransition {
  if (d.entries.length === 0) return { ok: false, error: { code: "invalid", message: "operation changes nothing" } };
  // One change per record: the last write wins, in first-touch order.
  const last = new Map<string, CatalogChange>();
  for (const e of d.entries) last.set(`${e.k}:${e.id}`, { k: e.k, id: e.id, entry: (mapOf(d, e.k)[e.id] ?? null) } as CatalogChange);
  const changes = [...last.values()];
  return { ok: true, catalog: { ...cat, version: d.version, folders: d.folders, screens: d.screens, media: d.media }, changes, inverse: { entries: d.entries } };
}

export function applyLibraryOperation(cat: LibraryCatalog, op: LibraryOperation, ctx: LibraryContext): LibraryTransition {
  const d = draftOf(cat);
  try { apply(d, op, ctx); }
  catch (e) { if (e instanceof Fail) return { ok: false, error: { code: e.code, message: e.message } }; throw e; }
  return finish(cat, d);
}

/** Applies an inverse through the same guarded path. The returned inverse re-applies the original (redo). */
export function applyLibraryInverse(cat: LibraryCatalog, inv: LibraryInverse): LibraryTransition {
  const d = draftOf(cat);
  try {
    for (const e of [...inv.entries].reverse()) {
      const cur = mapOf(d, e.k)[e.id] ?? null;
      if (!sameOwned(e.k, cur, e.after)) fail("conflict", `${e.k} ${e.id} changed since this edit`);
      if (e.before === null) put(d, e.k, e.id, null);
      else if (cur && e.k === "screen") {
        // Facts and last-opened move on independently: restore only the owned fields.
        const b = e.before as ScreenEntry;
        put(d, e.k, e.id, { ...(cur as ScreenEntry), folderId: b.folderId, archivedAt: b.archivedAt, revision: d.version });
      } else put(d, e.k, e.id, { ...e.before, revision: d.version } as AnyEntry);
    }
    // Undo never strands a Screen in a folder that no longer exists (say, undoing a folder's creation after someone filed into it).
    for (const sc of Object.values(d.screens)) if (sc.folderId !== null && !d.folders[sc.folderId]) fail("conflict", `folder ${sc.folderId} holds Screens since this edit`);
    if (Object.keys(d.folders).length > FOLDERS_MAX) fail("conflict", "the library's folder capacity was used since this edit");
    if (Object.keys(d.media).length > MEDIA_MAX) fail("conflict", "the library's Media capacity was used since this edit");
  } catch (e) { if (e instanceof Fail) return { ok: false, error: { code: e.code, message: e.message } }; throw e; }
  return finish(cat, d);
}

function apply(d: Draft, op: LibraryOperation, ctx: LibraryContext): void {
  switch (op.type) {
    case "batch":
      if (op.ops.length === 0) fail("invalid", "empty batch");
      for (const inner of op.ops) apply(d, inner, ctx);
      return;
    case "createFolder": {
      const { id } = op.folder;
      if (!CLIENT_ID.test(id)) fail("invalid", "folder id must be 8-32 lower-case letters or digits");
      if (d.folders[id]) fail("conflict", `folder ${id} already exists`);
      if (Object.keys(d.folders).length >= FOLDERS_MAX) fail("limit", `a library holds at most ${FOLDERS_MAX} folders`);
      put(d, "folder", id, { id, name: name(op.folder.name), createdAt: ctx.now, archivedAt: null, revision: d.version });
      return;
    }
    case "renameFolder": {
      const cur = d.folders[op.folderId] ?? fail("not-found", `folder ${op.folderId} not found`);
      const n = name(op.name);
      if (n !== cur.name) put(d, "folder", cur.id, { ...cur, name: n, revision: d.version });
      return;
    }
    case "moveScreens": {
      if (op.screenIds.length === 0) fail("invalid", "no Screens");
      if (op.folderId !== null) {
        const f = d.folders[op.folderId] ?? fail("not-found", `folder ${op.folderId} not found`);
        if (f.archivedAt !== null) fail("invalid", `folder ${f.name} is archived`);
      }
      for (const id of op.screenIds) {
        const cur = d.screens[id] ?? fail("not-found", `Screen ${id} not found`);
        if (cur.folderId !== op.folderId) put(d, "screen", id, { ...cur, folderId: op.folderId, revision: d.version });
      }
      return;
    }
    case "archive":
    case "restore": {
      if (op.targets.length === 0) fail("invalid", "nothing to " + op.type);
      const at = op.type === "archive" ? ctx.now : null;
      for (const r of op.targets) {
        if (r.kind === "folder") {
          const cur = d.folders[r.id] ?? fail("not-found", `folder ${r.id} not found`);
          if ((cur.archivedAt === null) !== (at === null)) put(d, "folder", r.id, { ...cur, archivedAt: at, revision: d.version });
        } else if (r.kind === "media") {
          const cur = d.media[r.id] ?? fail("not-found", `media ${r.id} not found`);
          if ((cur.archivedAt === null) !== (at === null)) put(d, "media", r.id, { ...cur, archivedAt: at, revision: d.version });
        } else {
          const cur = d.screens[r.id] ?? fail("not-found", `Screen ${r.id} not found`);
          const folderGone = cur.folderId !== null && (d.folders[cur.folderId]?.archivedAt ?? null) !== null;
          const next = at !== null ? { ...cur, archivedAt: cur.archivedAt ?? at } : { ...cur, archivedAt: null, folderId: folderGone ? null : cur.folderId };
          if (next.archivedAt !== cur.archivedAt || next.folderId !== cur.folderId) put(d, "screen", r.id, { ...next, revision: d.version });
        }
      }
      return;
    }
    case "addMedia": {
      const m = op.media;
      if (!CLIENT_ID.test(m.id)) fail("invalid", "media id must be 8-32 lower-case letters or digits");
      if (d.media[m.id]) fail("conflict", `media ${m.id} already exists`);
      if (Object.keys(d.media).length >= MEDIA_MAX) fail("limit", `Media holds at most ${MEDIA_MAX} items`);
      const info = ctx.images.get(m.assetHash) ?? fail("invalid", "not a PNG, JPEG, WebP or GIF image");
      put(d, "media", m.id, { id: m.id, title: title(m.title), assetHash: m.assetHash, mediaType: info.mediaType, width: info.width, height: info.height,
        meta: meta({ description: "", app: "", platform: "", screenType: "", tags: [], source: "", capturedAt: null }, m.meta ?? {}),
        addedAt: ctx.now, addedBy: ctx.author, archivedAt: null, revision: d.version });
      return;
    }
    case "updateMedia": {
      const cur = d.media[op.mediaId] ?? fail("not-found", `media ${op.mediaId} not found`);
      if (op.expectedRevision !== undefined && op.expectedRevision !== cur.revision) fail("conflict", `media ${op.mediaId} is at revision ${cur.revision}, expected ${op.expectedRevision}`);
      const { title: t, ...rest } = op.patch;
      const next = { ...cur, title: t === undefined ? cur.title : title(t), meta: meta(cur.meta, rest) };
      if (!same(next.title, cur.title) || !same(next.meta, cur.meta)) put(d, "media", cur.id, { ...next, revision: d.version });
      return;
    }
    default: fail("invalid", "unknown library operation");
  }
}

function sameOwned(k: CatalogChange["k"], cur: AnyEntry | null, after: AnyEntry | null): boolean {
  if (cur === null || after === null) return cur === after;
  if (k === "screen") { const a = cur as ScreenEntry, b = after as ScreenEntry; return a.folderId === b.folderId && a.archivedAt === b.archivedAt; }
  const { revision: _a, ...x } = cur as FolderEntry; const { revision: _b, ...y } = after as FolderEntry;
  return same(x, y);
}

function name(n: unknown): string {
  const t = typeof n === "string" ? n.trim() : "";
  if (t.length === 0 || t.length > TITLE_MAX) fail("invalid", `names must be 1-${TITLE_MAX} characters`);
  return t;
}
const title = name;

function field(v: unknown, max: number, label: string): string {
  if (typeof v !== "string") fail("invalid", `${label} must be text`);
  const t = (v as string).trim();
  if (t.length > max) fail("invalid", `${label} is at most ${max} characters`);
  return t;
}

/** Normalizes and checks a metadata patch over `cur`. Tags are lower-cased, trimmed, unique and kept in order. */
function meta(cur: MediaMeta, p: Partial<MediaMeta>): MediaMeta {
  const out = { ...cur } as { -readonly [K in keyof MediaMeta]: MediaMeta[K] };
  if (p.description !== undefined) out.description = field(p.description, MEDIA_DESCRIPTION_MAX, "description");
  if (p.app !== undefined) out.app = field(p.app, MEDIA_FIELD_MAX, "app");
  if (p.platform !== undefined) out.platform = field(p.platform, MEDIA_FIELD_MAX, "platform");
  if (p.screenType !== undefined) out.screenType = field(p.screenType, MEDIA_FIELD_MAX, "screen type");
  if (p.source !== undefined) out.source = field(p.source, MEDIA_SOURCE_MAX, "source");
  if (p.capturedAt !== undefined) {
    if (p.capturedAt !== null && !Number.isFinite(p.capturedAt)) fail("invalid", "capturedAt must be a time or null");
    out.capturedAt = p.capturedAt;
  }
  if (p.tags !== undefined) {
    if (!Array.isArray(p.tags)) fail("invalid", "tags must be a list");
    const tags = [...new Set(p.tags.map((t) => field(t, MEDIA_TAG_MAX, "a tag").toLowerCase()).filter(Boolean))];
    if (tags.length > MEDIA_TAGS_MAX) fail("invalid", `at most ${MEDIA_TAGS_MAX} tags`);
    out.tags = tags;
  }
  return out;
}

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
