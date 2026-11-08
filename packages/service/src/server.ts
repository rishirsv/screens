// The local service: the only writer of Screens. Canvas, MCP adapter and CLI are clients over one WebSocket protocol.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { isPagedLayout, planMontage, posterPixelsOf, applyInverse, applyLibraryInverse, applyLibraryOperation, applyOperation, checkScreen, contentHashes, emptyScreen, imageInfo, isScreenArchived, noteOpened, parseQuery, purgePlan, referencedHashes, searchMedia, snapshotContents, sourcesNeeded,
  type Author, type CatalogChange, type Context, type GuardedInverse, type ImageInfo, type LibraryCatalog, type LibraryContext, type LibraryInverse, type LibraryOperation, type LibraryTransition, type Operation, type ScreenDoc, type Transition } from "@screens/core";
import type { Rect } from "@screens/core";
import { openLibrary, type Library } from "@screens/storage-local";
import { createFrameHandler, frameCapability } from "@screens/frames";
import { CHUNK_BYTES, PROTOCOL_VERSION, contentVersionOf, decodeChunk, parseArchiveHead, parseClientMessage, type ClientMessage, type ImportOutcome, type LibraryOpenResult, type MontageAnswer, type OpenResult, type Outcome, type PosterAnswer, type ScreenSummary, type ServerMessage, type SnapshotCheck, type ViewCommandOutcome, type ViewContext } from "@screens/protocol";
import { createValidator } from "@screens/validator";
import { registryPath, screensHome, defaultHome, type Registry } from "./registry.ts";
import { createDevControls, type DevControls } from "./dev.ts";
import { createUploads } from "./uploads.ts";
import { createPresence } from "./presence.ts";
import { bundle } from "./bundle.ts";
import { readOpeningConfig, openingConfigScript } from "./opening.ts";
import { strokePath } from "../../canvas/src/engine/stroke.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
/** Static canvas files: next to the bundle in the published package, in the packages of a checkout. */
const asset = (name: "tokens.css" | "components.css" | "app.css"): string =>
  bundle ? path.join(here, "ui", name) : name === "app.css" ? path.join(repo, "packages/canvas/src/shell/app.css") : path.join(repo, "packages/ui", name);
const UNDO_LIMIT = 50;
const IDLE_EXIT_MS = 5 * 60_000;
/** The library's commit queue key. Screen ids cannot contain "@". */
const LIBRARY = "@library";
const THUMB_EDGE = 384;

interface Conn { ws: WebSocket; sessionId: string; role: "canvas" | "agent"; app?: boolean; screens: Set<string>; library: boolean; authed: boolean }
/** payload is a digest of what the caller asked for (payloadKey), compared on every replay. */
interface Receipt { screenId: string; payload: string; outcome: Outcome | ImportOutcome }
const payloadKey = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** One identity policy for admission and receipts. A derived op compares the caller's original request. */
function operationPayload(m: ClientMessage): string | null {
  switch (m.t) {
    case "op": return payloadKey([m.screenId, m.request !== undefined ? { request: m.request } : m.op]);
    case "history": return payloadKey([m.screenId, "history", m.direction]);
    case "libraryOp": return payloadKey(["library", m.op]);
    case "libraryHistory": return payloadKey(["library-history", m.direction]);
    case "purge": return payloadKey(["purge", m.targets]);
    case "importScreen": return payloadKey(["import", m.head]);
    default: return null;
  }
}
/** What test-loading an operation's snapshots produced: posters for core, reports for the receipt, or a refusal. */
interface Checked { readonly posters: ReadonlyMap<string, string>; readonly checks: readonly SnapshotCheck[]; readonly refusal: Extract<Outcome, { status: "failed" }> | null;
  /** Object content a piece edit produced that was test-loaded before the queue: itemId → contentVersion. */
  readonly validated?: ReadonlyMap<string, string> }
const NOTHING_CHECKED: Checked = { posters: new Map(), checks: [], refusal: null };
/** SHA-256 of UTF-8 text, as the content store hashes bytes. */
const digest = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const POSTERS_CACHED = 500, STILLS_CACHED = 8;
interface Stack { undo: { opId: string; inverse: GuardedInverse }[]; redo: { opId: string; inverse: GuardedInverse }[] }
interface LibraryStack { undo: { opId: string; inverse: LibraryInverse }[]; redo: { opId: string; inverse: LibraryInverse }[] }

export interface ServeOptions { readonly idleExit?: boolean; readonly canvasPort?: number; readonly framePort?: number; readonly dev?: boolean; readonly idleMs?: number }

export async function serve(opts: ServeOptions = {}): Promise<Registry> {
  const openingConfig = readOpeningConfig();
  const home = screensHome();
  fs.mkdirSync(home, { recursive: true });
  if (!takeLock(path.join(home, "service.lock"))) { console.log("another Screens service is already running"); process.exit(0); }

  let dev: DevControls | null = null;
  const lib: Library = openLibrary(path.join(home, "library"), { step: (s) => dev?.step(s), writing: (k) => dev?.writing(k) });
  const recovered = lib.recover();
  const instanceId = crypto.randomUUID();
  const token = installToken(home);
  const secret = crypto.randomBytes(32);
  const docs = new Map<string, ScreenDoc>();
  // Committed receipts are stored with their commit (the Screen file or the catalog line), so op_status and replays
  // answer the same after a crash or restart. Failed receipts are kept in memory only: nothing was saved.
  const receipts = new Map<string, Receipt>(lib.receipts().map((r) => [r.opId, { screenId: r.screenId, payload: r.payload, outcome: r.outcome as Outcome | ImportOutcome }]));
  const uploads = createUploads(lib);
  setInterval(() => uploads.sweep(), 60_000).unref();
  const stacks = new Map<string, Stack>(); // `${sessionId}:${screenId}`
  const libStacks = new Map<string, LibraryStack>(); // sessionId
  /** Each canvas connection's view of each Screen. A browser tab and an MCP App view on one Screen keep separate entries. */
  type Viewed = ViewContext & { sessionId: string; at: number; app: boolean };
  const contexts = new Map<string, Map<string, Viewed>>();
  /** The most recently active view of a Screen; app limits it to MCP App views. */
  const latestView = (screenId: string, app?: boolean): Viewed | undefined =>
    [...(contexts.get(screenId)?.values() ?? [])].filter((x) => !app || x.app).sort((a, b) => b.at - a.at)[0];
  const dropView = (screenId: string, sessionId: string) => { const m = contexts.get(screenId); if (m?.delete(sessionId) && !m.size) contexts.delete(screenId); };
  const conns = new Set<Conn>();
  const pendingCommands = new Map<string, (o: ViewCommandOutcome) => void>();
  let canvasOrigin = "", frameOrigin = "", lastActivity = Date.now(), appJs = "", stopping = false;
  const startedAt = Date.now();
  /** Commits to one Screen run one at a time, so an awaited commit never interleaves with another writer there.
   *  An operation ID is reserved while its commit runs, so the same ID on another Screen waits and then meets
   *  the receipt. Shutdown waits for every queue. */
  const queues = new Map<string, Promise<unknown>>(), inflight = new Map<string, Promise<unknown>>();
  /** Snapshot checks still loading, before their commit enters a queue. */
  const checking = new Set<Promise<unknown>>();
  // Includes validation and time waiting in a queue, before serial() reserves the operation ID.
  const accepted = new Map<string, { readonly payload: string; count: number }>();
  const serial = <T>(screenId: string, opId: string, fn: () => Promise<T>): Promise<T> => {
    const run = async () => {
      while (inflight.has(opId)) await inflight.get(opId)!.catch(() => {});
      const p = fn(); inflight.set(opId, p);
      try { return await p; } finally { if (inflight.get(opId) === p) inflight.delete(opId); }
    };
    const next = (queues.get(screenId) ?? Promise.resolve()).then(run, run);
    const tail = next.catch(() => {}); queues.set(screenId, tail);
    void tail.then(() => { if (queues.get(screenId) === tail) queues.delete(screenId); });
    return next;
  };
  dev = opts.dev ? createDevControls({ home, defaultHome: defaultHome(), inspect: () => ({
    instanceId, uptimeMs: Date.now() - startedAt,
    conns: [...conns].filter((c) => c.authed).map((c) => ({ sessionId: c.sessionId, role: c.role, screens: [...c.screens] })),
    library: { docReads: lib.docReads, catalogVersion: lib.catalog().version, subscribers: [...conns].filter((c) => c.library).length },
    stacks: [...stacks].map(([k, st]) => { const i = k.indexOf(":"); return { sessionId: k.slice(0, i), screenId: k.slice(i + 1), undo: st.undo.map((e) => e.opId), redo: st.redo.map((e) => e.opId) }; }),
    receipts: { size: receipts.size, last: [...receipts].slice(-20).map(([opId, r]) => ({ opId, status: r.outcome.status })) },
    contexts: [...contexts].flatMap(([screenId, m]) => [...m.values()].map((x) => ({ screenId, sessionId: x.sessionId, selection: x.selection, focused: x.focused, busy: x.busy }))),
    pendingViewCommands: pendingCommands.size,
    uploads: uploads.inspect(),
  }) }) : null;
  const presence = createPresence({
    now: () => Date.now(), doc: (id) => getDoc(id),
    toCanvases: (screenId, m) => { let raw: string | null = null; for (const c of conns) if (c.role === "canvas" && c.screens.has(screenId) && c.ws.readyState === c.ws.OPEN) c.ws.send(raw ??= JSON.stringify(m)); },
  });
  const authorOf = (c: Conn, lane?: string): Author => (c.role === "agent" ? presence.author(c, lane) : { kind: "person" });
  const validator = createValidator({ refuseLaunch: () => dev?.takeNoBrowser() ?? false });

  const getDoc = (id: string): ScreenDoc | null => {
    let d = docs.get(id) ?? null;
    if (!d) { d = lib.read(id); if (d) docs.set(id, d); }
    return d;
  };
  const send = (c: Conn, m: ServerMessage) => { if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m)); };
  /** Serialized once for every recipient. */
  const broadcast = (screenId: string, m: ServerMessage, except?: Conn) => {
    let raw: string | null = null;
    for (const c of conns) if (c !== except && c.screens.has(screenId) && c.ws.readyState === c.ws.OPEN) c.ws.send(raw ??= JSON.stringify(m));
  };
  const stackOf = (sessionId: string, screenId: string): Stack => {
    const k = `${sessionId}:${screenId}`; let s = stacks.get(k);
    if (!s) { s = { undo: [], redo: [] }; stacks.set(k, s); }
    return s;
  };
  const sendHistory = (c: Conn, screenId: string) => { const s = stackOf(c.sessionId, screenId); send(c, { t: "history", screenId, canUndo: s.undo.length > 0, canRedo: s.redo.length > 0 }); };
  const libStackOf = (sessionId: string): LibraryStack => { let s = libStacks.get(sessionId); if (!s) { s = { undo: [], redo: [] }; libStacks.set(sessionId, s); } return s; };
  const sendLibraryHistory = (c: Conn) => { const s = libStackOf(c.sessionId); send(c, { t: "libraryHistory", canUndo: s.undo.length > 0, canRedo: s.redo.length > 0 }); };
  /** Catalog changes reach library subscribers only after storage has them. */
  const publishCatalog = (changes: readonly CatalogChange[], cat: LibraryCatalog, opId: string | null, sessionId: string | null) => {
    if (!changes.length) return;
    const m: ServerMessage = { t: "catalog", version: cat.version, changes, opId, sessionId };
    for (const c of conns) if (c.library) send(c, m);
  };
  const summaryOf = (cat: LibraryCatalog, id: string): ScreenSummary => {
    const s = cat.screens[id]!;
    return { id, damaged: s.damaged, title: s.facts.title, revision: s.facts.docRevision, createdAt: s.facts.createdAt, updatedAt: s.facts.updatedAt, itemCount: s.facts.itemCount,
      folderId: s.folderId, archived: isScreenArchived(cat, id), lastOpenedAt: s.lastOpenedAt, layout: s.facts.layout ?? "canvas" };
  };
  /** Image headers for every addMedia in an operation, read before the queue. */
  const imagesFor = (op: LibraryOperation): Map<string, ImageInfo> => {
    const out = new Map<string, ImageInfo>();
    const walk = (o: LibraryOperation): void => {
      if (o.type === "batch") { for (const x of o.ops) walk(x); return; }
      if (o.type === "addMedia" && !out.has(o.media.assetHash)) { const b = lib.readContent(o.media.assetHash); const info = b ? imageInfo(b) : null; if (info) out.set(o.media.assetHash, info); }
    };
    walk(op); return out;
  };

  /** The library's commit: receipt, transition, durable append, broadcast. Same rules as a Screen commit. */
  function commitLibrary(c: Conn, opId: string, payload: string, run: (cat: LibraryCatalog) => LibraryTransition): { outcome: Outcome; inverse?: LibraryInverse } {
    const prior = receipts.get(opId);
    // Library receipts only ever hold Outcomes; imports keep their own.
    if (prior) return prior.payload === payload ? { outcome: prior.outcome as Outcome } : { outcome: { status: "failed", error: { code: "invalid", message: "operation ID reused with a different payload" } } };
    const t = run(lib.catalog());
    let outcome: Outcome;
    if (!t.ok) outcome = { status: "failed", error: t.error };
    else {
      let cat: LibraryCatalog;
      const committed: Outcome = { status: "committed", revision: lib.catalog().version + (t.changes.length ? 1 : 0) };
      try { cat = lib.commitCatalog(t.changes, true, { opId, screenId: LIBRARY, payload, outcome: committed }); }
      catch (e) { outcome = { status: "failed", error: { code: "storage", message: storageError(e).message } }; remember(opId, { screenId: LIBRARY, payload, outcome }); return { outcome }; }
      outcome = { status: "committed", revision: cat.version };
      publishCatalog(t.changes, cat, opId, c.sessionId);
    }
    remember(opId, { screenId: LIBRARY, payload, outcome });
    return { outcome, inverse: t.ok ? t.inverse : undefined };
  }

  // Thumbnails: one per source hash, generated once in the shared Chrome, deduplicated while in flight.
  const thumbing = new Map<string, Promise<Buffer | null>>();
  const thumbnail = (hash: string): Promise<Buffer | null> => {
    const have = lib.readThumb(hash); if (have) return Promise.resolve(have);
    let p = thumbing.get(hash);
    if (!p) {
      p = (async () => {
        const src = lib.readContent(hash); if (!src) return null;
        const info = imageInfo(src); if (!info) return null;
        if (Math.max(info.width, info.height) <= THUMB_EDGE && info.mediaType === "image/jpeg") return src;
        const out = await validator.thumbnail(src, info.mediaType, info, THUMB_EDGE);
        if (!out) return null;
        lib.putThumb(hash, out);
        return Buffer.from(out);
      })().finally(() => thumbing.delete(hash));
      thumbing.set(hash, p);
    }
    return p;
  };

  /** Receipts are bounded: the oldest goes first. */
  const remember = (opId: string, r: Receipt) => { receipts.set(opId, r); if (receipts.size > 10_000) receipts.delete(receipts.keys().next().value!); };

  /** Test-loads every snapshot content an operation brings, before the Screen queue, so a page that never loads
   *  holds up no other write there. Posters are stored now; one orphaned by a refusal or conflict is collected by recover(). */
  async function checkSnapshots(screenId: string, op: Operation): Promise<Checked> {
    const doc = getDoc(screenId); if (!doc) return NOTHING_CHECKED;
    const targets = snapshotContents(doc, op); if (!targets.length) return NOTHING_CHECKED;
    for (const t of targets) if (await contentVersionOf(t.entry, t.manifest) !== t.contentVersion)
      return { ...NOTHING_CHECKED, refusal: { status: "failed", error: { code: "invalid", message: `contentVersion ${t.contentVersion} does not match the bundle for ${t.itemId}` } } };
    const posterPixels = posterPixelsOf(doc.layout);
    const results = await Promise.all(targets.map((t) => validator.check({ ...t, read: (h) => lib.readContent(h), ...(posterPixels ? { posterPixels } : {}) })));
    const posters = new Map<string, string>();
    const checks = targets.map((t, i): SnapshotCheck => {
      const r = results[i]!;
      const poster = r.status === "loaded" && r.poster ? { hash: lib.putContent(r.poster.bytes, "poster"), width: r.poster.width, height: r.poster.height } : null;
      // Keyed by item: targets are in order, so the last content an item gets decides its poster.
      if (poster) posters.set(t.itemId, poster.hash); else posters.delete(t.itemId);
      return { itemId: t.itemId, contentVersion: t.contentVersion, poster, warnings: r.warnings };
    });
    const failed = results.findIndex((r) => r.status === "not-loaded");
    if (failed < 0) return { posters, checks, refusal: null };
    const r = results[failed] as Extract<typeof results[number], { status: "not-loaded" }>;
    const kept = op.type === "updateSnapshot" ? "the previous version is still live" : "nothing was saved";
    return { posters, checks, refusal: { status: "failed", error: { code: "not-loaded", message: `${targets[failed]!.itemId}: ${r.reason}; ${kept}`, checks } } };
  }

  /** The text of every object file `op` (or an inverse) reads, for core. */
  const sourcesFor = (doc: ScreenDoc, op: Operation | GuardedInverse): Map<string, string> => {
    const out = new Map<string, string>();
    for (const h of sourcesNeeded(doc, op)) { const b = lib.readContent(h); if (b) out.set(h, b.toString("utf8")); }
    return out;
  };
  const withSources = (doc: ScreenDoc, op: Operation | GuardedInverse, ctx: Context, seed: string): Context => ({ ...ctx, sources: sourcesFor(doc, op), digest, seed });
  const hasPieceEdit = (op: Operation): boolean => op?.type === "editObject" || (op?.type === "batch" && Array.isArray(op.ops) && op.ops.some(hasPieceEdit));

  /** Piece edits on objects that can run code are test-loaded before the queue, like a whole-object update. The edit is
   *  applied to the current document to get that content; the commit re-applies it and refuses if it came out different. */
  async function checkObjects(c: Conn, screenId: string, op: Operation, opId: string): Promise<Checked> {
    const doc = getDoc(screenId); if (!doc || !hasPieceEdit(op)) return NOTHING_CHECKED;
    const ctx = withSources(doc, op, { now: Date.now(), author: authorOf(c), posters: new Map() }, opId);
    return checkProduced(applyOperation(doc, op, ctx), "the previous version is still live");
  }

  /** Test-loads the content a transition produced that can run code. Inert content needs no check. */
  async function checkProduced(spec: Transition, kept: string): Promise<Checked> {
    if (!spec.ok) return NOTHING_CHECKED;
    const targets = spec.contents.filter((x) => !x.inert);
    if (!targets.length) return NOTHING_CHECKED;
    const read = (h: string) => { const t = spec.produced.get(h); return t !== undefined ? new Uint8Array(Buffer.from(t, "utf8")) : lib.readContent(h); };
    const posterPixels = posterPixelsOf(spec.doc.layout);
    const results = await Promise.all(targets.map((t) => validator.check({ entry: t.entry, manifest: t.manifest, width: t.width, height: t.height, read, ...(posterPixels ? { posterPixels } : {}) })));
    const posters = new Map<string, string>(), validated = new Map<string, string>();
    const checks = targets.map((t, i): SnapshotCheck => {
      const r = results[i]!;
      const poster = r.status === "loaded" && r.poster ? { hash: lib.putContent(r.poster.bytes, "poster"), width: r.poster.width, height: r.poster.height } : null;
      if (poster) posters.set(t.itemId, poster.hash);
      validated.set(t.itemId, t.contentVersion);
      return { itemId: t.itemId, contentVersion: t.contentVersion, poster, warnings: r.warnings };
    });
    const failed = results.findIndex((r) => r.status === "not-loaded");
    if (failed < 0) return { posters, checks, refusal: null, validated };
    const r = results[failed] as Extract<typeof results[number], { status: "not-loaded" }>;
    return { posters, checks, validated, refusal: { status: "failed", error: { code: "not-loaded", message: `${targets[failed]!.itemId}: ${r.reason}; ${kept}`, checks } } };
  }
  const mergeChecked = (a: Checked, b: Checked): Checked => (b === NOTHING_CHECKED ? a : a === NOTHING_CHECKED ? b
    : { posters: new Map([...a.posters, ...b.posters]), checks: [...a.checks, ...b.checks], refusal: a.refusal ?? b.refusal, validated: b.validated });

  // Pictures of objects whose content was saved without a load check (piece edits on script-free objects), or crops.
  // Rendered on demand, keyed by content and size, and kept out of the document: a poster is never a new revision.
  const posterCache = new Map<string, Promise<PosterAnswer>>();
  function objectPoster(screenId: string, itemId: string, pieces: readonly string[] = [], contentVersion?: string): Promise<PosterAnswer> {
    const it = getDoc(screenId)?.items[itemId];
    if (!it || it.kind !== "html-snapshot") return Promise.reject(codeError("not-found", `${itemId} is not an object in Screen ${screenId}`));
    // A picture of exactly the version asked for, or none: never a later one under an earlier edit's result.
    if (contentVersion !== undefined && it.contentVersion !== contentVersion)
      return Promise.resolve({ itemId, contentVersion, hash: null, width: 0, height: 0, rect: null, warnings: [{ code: "poster", message: "the object changed since this version; get_poster shows the current one" }] });
    const clip = [...new Set(pieces)].filter((p) => /^[a-z][a-z0-9-]{0,23}$/.test(p)).sort();
    if (!clip.length && it.posterHash) return Promise.resolve({ itemId, contentVersion: it.contentVersion, hash: it.posterHash, width: it.width, height: it.height, rect: null, warnings: [] });
    // The pixel cap depends on the layout, so a slide never reuses a canvas object's smaller picture of the same content.
    const posterPixels = posterPixelsOf(getDoc(screenId)?.layout);
    const key = `${it.contentVersion}:${it.width}x${it.height}:${clip.join(",")}:${posterPixels ?? ""}`;
    let p = posterCache.get(key);
    if (!p) {
      const v = it.contentVersion;
      p = validator.check({ entry: it.entry, manifest: it.assetManifest, width: it.width, height: it.height, read: (h) => lib.readContent(h), ...(clip.length ? { clip } : {}), ...(posterPixels ? { posterPixels } : {}) }).then((r): PosterAnswer => {
        const poster = r.status === "loaded" ? r.poster : null;
        const hash = poster ? lib.putContent(poster.bytes, "poster") : null;
        const rect: Rect | null = poster?.rect ?? null;
        return { itemId, contentVersion: v, hash, width: poster?.width ?? 0, height: poster?.height ?? 0, rect, warnings: r.status === "not-loaded" ? [...r.warnings, { code: "poster", message: r.reason }] : r.warnings };
      });
      posterCache.set(key, p);
      // A failed render is not kept, so the next ask tries again.
      void p.then((a) => { if (!a.hash) posterCache.delete(key); }, () => posterCache.delete(key));
      if (posterCache.size > POSTERS_CACHED) posterCache.delete(posterCache.keys().next().value!);
    }
    return p;
  }

  // An overview from the pictures already stored: posters for objects (rendered first when missing), originals for images.
  // Composed in the shared Chrome, so no canvas needs to be open. Bytes stay in memory: a montage is never stored content.
  async function screenMontage(screenId: string, rect: Rect | undefined, maxSize: number | undefined, labels: boolean): Promise<MontageAnswer> {
    const doc = getDoc(screenId); if (!doc) throw codeError("not-found", `Screen ${screenId} not found`);
    if (rect && ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) throw codeError("invalid", "rect needs finite x, y, w and h");
    if (maxSize !== undefined && !Number.isFinite(maxSize)) throw codeError("invalid", "maxSize must be a number");
    const plan = planMontage(doc, { ...(rect ? { rect } : {}), ...(maxSize !== undefined ? { maxSize } : {}) });
    const empty = (warning: string): MontageAnswer => ({ image: null, width: 0, height: 0, scale: 0, world: rect ?? { x: 0, y: 0, w: 0, h: 0 }, items: [], strokes: 0, warnings: [warning] });
    if (!plan) return empty(rect ? "rect needs a positive w and h" : "this Screen has nothing on it");
    const { world, scale } = plan;
    if (!plan.items.length && !plan.strokes.length) return empty("nothing on this Screen intersects rect");
    const warnings: string[] = [];
    const paged = isPagedLayout(doc.layout);
    const images = await Promise.all(plan.items.map(async (m) => {
      const it = doc.items[m.id]!;
      const pos = { x: m.at.x, y: m.at.y, w: m.at.w, h: m.at.h };
      if (it.kind === "reference-image") return { ...pos, hash: it.assetHash, mediaType: it.mediaType, fit: paged ? "contain" as const : "cover" as const };
      const hash = it.posterHash ?? (await objectPoster(screenId, it.id).catch(() => null))?.hash ?? null;
      if (!hash) warnings.push(`${it.id} has no poster yet: drawn as a gray box`);
      return { ...pos, hash, mediaType: "image/jpeg", fit: "fill" as const };
    }));
    const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const clips = new Map<string, string>();
    const paths = plan.strokes.map((s) => {
      let clip = "";
      if (s.clip) {
        const id = `c${clips.size}`;
        clips.set(id, `<clipPath id="${id}"><rect x="${s.clip.x}" y="${s.clip.y}" width="${s.clip.w}" height="${s.clip.h}"/></clipPath>`);
        clip = ` clip-path="url(#${id})"`;
      }
      return `<g${clip}><path transform="translate(${s.origin.x} ${s.origin.y})" d="${strokePath(s.points, s.size)}" fill="${esc(s.color)}"/></g>`;
    });
    const svg = paths.length ? `<svg width="${plan.width}" height="${plan.height}" viewBox="${world.x} ${world.y} ${world.w} ${world.h}" preserveAspectRatio="none"><defs>${[...clips.values()].join("")}</defs>${paths.join("")}</svg>` : "";
    const shown = labels ? plan.items : [];
    const jpeg = await validator.montage({ width: plan.width, height: plan.height, images, svg, read: (h) => lib.readContent(h),
      labels: shown.map((m) => ({ x: m.visible.x, y: m.at.y, w: m.visible.w, text: m.title })) });
    if (!jpeg) warnings.push("Chrome is not available, so the montage could not be drawn");
    return { image: jpeg ? Buffer.from(jpeg).toString("base64") : null, width: plan.width, height: plan.height, scale: Math.round(scale * 10_000) / 10_000,
      world: { x: round(world.x), y: round(world.y), w: round(world.w), h: round(world.h) },
      items: plan.items.map((m) => ({ id: m.id, title: m.title, kind: m.kind, rect: m.visible, ...(m.partial ? { partial: true as const } : {}) })).reverse(),
      strokes: plan.strokes.length, warnings };
  }

  // Sharp PNGs for Copy as image, rendered on request at 2x. Bytes stay in memory: a copy is never stored content.
  const stills = new Map<string, Promise<Uint8Array | null>>();
  function designStill(screenId: string, itemId: string, contentVersion: string): Promise<Uint8Array | null> {
    const it = getDoc(screenId)?.items[itemId];
    if (!it || it.kind !== "html-snapshot" || it.contentVersion !== contentVersion) return Promise.resolve(null);
    const key = `${contentVersion}:${it.width}x${it.height}`;
    let p = stills.get(key);
    if (!p) {
      p = validator.check({ entry: it.entry, manifest: it.assetManifest, width: it.width, height: it.height, read: (h) => lib.readContent(h), still: 2 })
        .then((r) => (r.status === "loaded" && r.poster ? r.poster.bytes : null));
      stills.set(key, p);
      void p.then((b) => { if (!b) stills.delete(key); }, () => stills.delete(key));
      if (stills.size > STILLS_CACHED) stills.delete(stills.keys().next().value!);
    }
    return p;
  }

  /** Validate, write, then publish. Never publishes a revision that did not reach disk. */
  async function commit(c: Conn, screenId: string, opId: string, payload: string, run: (doc: ScreenDoc, ctx: Context) => Transition, checked: Checked = NOTHING_CHECKED, lane?: string, legacyPayload?: string): Promise<{ outcome: Outcome; inverse?: GuardedInverse }> {
    const prior = receipts.get(opId);
    // Older snapshot adapters stored operation-derived identity. Preserve it when the original op can be rebuilt.
    if (prior) return prior.payload === payload || prior.payload === legacyPayload ? { outcome: prior.outcome as Outcome } : { outcome: { status: "failed", error: { code: "invalid", message: "operation ID reused with a different payload" } } };
    if (checked.refusal) { remember(opId, { screenId, payload, outcome: checked.refusal }); return { outcome: checked.refusal }; }
    const doc = getDoc(screenId);
    if (!doc) return { outcome: { status: "failed", error: { code: "not-found", message: `Screen ${screenId} not found` } } };
    const t = run(doc, { now: Date.now(), author: authorOf(c, lane), posters: checked.posters });
    let outcome: Outcome;
    if (!t.ok) outcome = { status: "failed", error: t.error };
    else {
      const injected = dev ? await dev.beforeWrite() : null;
      if (injected) { outcome = { status: "failed", error: injected }; remember(opId, { screenId, payload, outcome }); return { outcome }; }
      let changes: readonly CatalogChange[];
      const committed: Outcome = { status: "committed", revision: t.doc.revision, ...(checked.checks.length ? { checks: checked.checks } : {}), ...(t.deltas.length ? { objects: t.deltas } : {}) };
      // Files a transition wrote (piece edits, stamped ids) reach the store before the document names them.
      try { for (const [h, text] of t.produced) if (lib.putContent(new Uint8Array(Buffer.from(text, "utf8"))) !== h) throw new Error("content hash mismatch"); changes = lib.write(t.doc, { opId, screenId, payload, outcome: committed }); dev?.afterWrite(); }
      catch (e) { outcome = { status: "failed", error: { code: "storage", message: storageError(e).message } }; remember(opId, { screenId, payload, outcome }); return { outcome }; }
      docs.set(screenId, t.doc);
      outcome = committed;
      broadcast(screenId, { t: "revision", screenId, doc: t.doc, opId, sessionId: c.sessionId });
      presence.revised(screenId);
      publishCatalog(changes, lib.catalog(), null, null);
    }
    remember(opId, { screenId, payload, outcome });
    return { outcome, inverse: t.ok ? t.inverse : undefined };
  }

  async function handle(c: Conn, m: ClientMessage): Promise<unknown> {
    switch (m.t) {
      case "list": {
        const cat = lib.catalog(), q = (m.query ?? "").trim().toLowerCase();
        return Object.keys(cat.screens).map((id) => summaryOf(cat, id))
          .filter((s) => s.archived === (m.archived ?? false) && (m.folderId === undefined || s.folderId === m.folderId) && (!q || s.title.toLowerCase().includes(q)))
          .sort((a, b) => b.updatedAt - a.updatedAt);
      }
      case "create": {
        const title = (m.title ?? "").trim() || "Untitled";
        if (m.layout !== undefined && m.layout !== "canvas" && !isPagedLayout(m.layout)) throw codeError("invalid", `layout must be canvas, slides or a4`);
        const doc = emptyScreen(crypto.randomUUID(), title.slice(0, 120), Date.now(), m.layout ?? "canvas");
        return serial(LIBRARY, crypto.randomUUID(), async () => {
          // Checked on the library queue, so an archive or delete queued ahead of this cannot strand the new Screen.
          if (m.folderId) { const f = lib.catalog().folders[m.folderId]; if (!f || f.archivedAt !== null) throw codeError("not-found", `folder ${m.folderId} not found`); }
          publishCatalog(lib.write(doc), lib.catalog(), null, c.sessionId); docs.set(doc.id, doc);
          if (m.folderId) {
            const t = applyLibraryOperation(lib.catalog(), { type: "moveScreens", screenIds: [doc.id], folderId: m.folderId }, { now: Date.now(), author: authorOf(c), images: new Map() });
            if (!t.ok) throw codeError(t.error.code, `the Screen was created but not filed: ${t.error.message}`);
            publishCatalog(t.changes, lib.commitCatalog(t.changes, true), null, c.sessionId);
          }
          return { id: doc.id, title: doc.title };
        });
      }
      case "openLibrary": {
        c.library = true;
        const s = libStackOf(c.sessionId);
        return { catalog: lib.catalog(), canUndo: s.undo.length > 0, canRedo: s.redo.length > 0 } satisfies LibraryOpenResult;
      }
      case "libraryOp": {
        const ctx: LibraryContext = { now: Date.now(), author: authorOf(c), images: imagesFor(m.op) };
        return serial(LIBRARY, m.opId, async () => {
          const { outcome, inverse } = commitLibrary(c, m.opId, operationPayload(m)!, (cat) => applyLibraryOperation(cat, m.op, ctx));
          if (inverse && c.role === "canvas") {
            const s = libStackOf(c.sessionId);
            s.undo.push({ opId: m.opId, inverse }); if (s.undo.length > UNDO_LIMIT) s.undo.shift();
            s.redo = []; sendLibraryHistory(c);
          }
          return outcome;
        });
      }
      case "libraryHistory": return serial(LIBRARY, m.opId, async () => {
        // A retried undo whose answer was lost meets its receipt before the stack, which has moved on since.
        const payload = operationPayload(m)!;
        const prior = receipts.get(m.opId);
        if (prior) return prior.payload === payload ? prior.outcome : ({ status: "failed", error: { code: "invalid", message: "operation ID reused with a different payload" } } satisfies Outcome);
        const s = libStackOf(c.sessionId);
        const from = m.direction === "undo" ? s.undo : s.redo, to = m.direction === "undo" ? s.redo : s.undo;
        const entry = from.at(-1);
        if (!entry) {
          const outcome: Outcome = { status: "failed", error: { code: "invalid", message: `nothing to ${m.direction}` } };
          remember(m.opId, { screenId: LIBRARY, payload, outcome });
          return outcome;
        }
        const { outcome, inverse } = commitLibrary(c, m.opId, payload, (cat) => applyLibraryInverse(cat, entry.inverse));
        if (outcome.status === "committed" && inverse) { from.pop(); to.push({ opId: entry.opId, inverse }); }
        else if (outcome.status === "failed" && outcome.error.code !== "storage") from.pop();
        sendLibraryHistory(c);
        return outcome;
      });
      case "purge": {
        if (c.role !== "canvas") throw codeError("forbidden", "only a person can delete permanently, from Archive");
        return serial(LIBRARY, m.opId, async () => {
          const payload = operationPayload(m)!;
          const prior = receipts.get(m.opId);
          if (prior) return prior.payload === payload ? prior.outcome : ({ status: "failed", error: { code: "invalid", message: "operation ID reused with a different payload" } } satisfies Outcome);
          const plan = purgePlan(lib.catalog(), m.targets);
          let outcome: Outcome;
          if ("code" in plan) outcome = { status: "failed", error: plan };
          else {
            try {
              // The document unlink is the commit point; the catalog follows. A crash between is reconciled on load.
              for (const id of plan.screens) { while (queues.has(id)) await queues.get(id); lib.remove(id); docs.delete(id); }
              const cat = lib.commitCatalog(plan.changes, true, { opId: m.opId, screenId: LIBRARY, payload, outcome: { status: "committed", revision: lib.catalog().version + (plan.changes.length ? 1 : 0) } });
              outcome = { status: "committed", revision: cat.version };
              publishCatalog(plan.changes, cat, m.opId, c.sessionId);
            } catch (e) { outcome = { status: "failed", error: { code: "storage", message: storageError(e).message } }; }
          }
          remember(m.opId, { screenId: LIBRARY, payload, outcome });
          return outcome;
        });
      }
      case "searchMedia": return searchMedia(lib.catalog(), parseQuery(m.query ?? ""), { sort: m.sort, archived: m.archived, offset: m.offset, limit: Math.min(200, m.limit ?? 50) });
      case "open": {
        const doc = getDoc(m.screenId); if (!doc) throw codeError("not-found", `Screen ${m.screenId} not found`);
        c.screens.add(m.screenId);
        if (c.role === "canvas") {
          presence.opened(m.screenId);
          // Last opened is view state: no revision, no undo, an unsynced line.
          const ch = noteOpened(lib.catalog(), m.screenId, Date.now());
          if (ch) publishCatalog([ch], lib.commitCatalog([ch], false), null, null);
        }
        const s = stackOf(c.sessionId, m.screenId);
        const r: OpenResult = { doc, frameOrigin, frameCapability: frameCapability(secret, m.screenId), canUndo: s.undo.length > 0, canRedo: s.redo.length > 0 };
        return r;
      }
      case "op": {
        // An op may name only content the store holds: upload first. Not remembered, so the same opId works once uploaded.
        if (!receipts.has(m.opId)) {
          const missing = safeContentHashes(m.op).filter((h) => !lib.hasContent(h));
          if (missing.length) return { status: "failed", error: { code: "missing-content", message: `${missing.length} file(s) the operation names were never uploaded`, hashes: missing } } satisfies Outcome;
        }
        // The agent's call shows on the canvas from now, through the page check, until it settles.
        const note = c.role === "agent" && getDoc(m.screenId) ? presence.opStarted(c, m.screenId, m.lane, m.opId, m.op, m.draftGeneration) : null;
        // A replay is answered by its receipt, so it never opens Chrome.
        // Shutdown waits for checks too: a received operation is finished, not dropped, while its page loads.
        const pending = receipts.has(m.opId) ? Promise.resolve(NOTHING_CHECKED)
          : Promise.all([checkSnapshots(m.screenId, m.op), checkObjects(c, m.screenId, m.op, m.opId)]).then(([a, b]) => mergeChecked(a, b)).catch((e: Error & { code?: string }): Checked => ({
            ...NOTHING_CHECKED,
            refusal: { status: "failed", error: e.code === "corrupt" ? { code: "corrupt", message: e.message } : storageError(e) },
          }));
        checking.add(pending); void pending.finally(() => checking.delete(pending)).catch(() => {});
        const checked = await pending.catch((e) => { if (c.role === "agent") presence.opSettled(c, m.screenId, m.lane, m.opId, { status: "unknown" }); throw e; });
        return serial(m.screenId, m.opId, async () => {
          // A request (the caller's own input) stands in for an op derived from state that may change before a retry.
          const payload = operationPayload(m)!;
          const { outcome, inverse } = await commit(c, m.screenId, m.opId, payload, (doc, ctx) => {
            // An agent's add without x/y lands in its reservation as it is now, inside the queue.
            const op = c.role === "agent" ? presence.place(c, m.screenId, m.lane, m.opId, m.op) : m.op;
            const t = applyOperation(doc, op, withSources(doc, op, ctx, m.opId));
            // Content that needs a load check must be exactly what was checked before the queue.
            if (t.ok) for (const x of t.contents) if (!x.inert && checked.validated?.get(x.itemId) !== x.contentVersion)
              return { ok: false, error: { code: "conflict", message: `${x.itemId} changed while its new version was being checked; try again` } };
            return t;
          }, checked, m.lane, m.request !== undefined ? payloadKey([m.screenId, m.op]) : undefined);
          // Stamping piece ids changes nothing a person sees, so it is not something to undo.
          const invisible = !!inverse && inverse.entries.every((e) => e.kind === "pieces" && e.steps.length === 0);
          if (inverse && c.role === "canvas" && !invisible) {
            const s = stackOf(c.sessionId, m.screenId);
            s.undo.push({ opId: m.opId, inverse }); if (s.undo.length > UNDO_LIMIT) s.undo.shift();
            s.redo = []; sendHistory(c, m.screenId);
          }
          if (c.role === "agent") presence.opSettled(c, m.screenId, m.lane, m.opId, outcome);
          return note && outcome.status === "committed" ? { ...outcome, note } : outcome;
        });
      }
      case "history": return serial(m.screenId, m.opId, async () => {
        // Replay before reading the stack: the first execution has already moved it, possibly emptied it.
        const payload = operationPayload(m)!;
        const prior = receipts.get(m.opId);
        if (prior) return prior.payload === payload ? prior.outcome : ({ status: "failed", error: { code: "invalid", message: "operation ID reused with a different payload" } } satisfies Outcome);
        const s = stackOf(c.sessionId, m.screenId);
        const from = m.direction === "undo" ? s.undo : s.redo, to = m.direction === "undo" ? s.redo : s.undo;
        const entry = from.at(-1);
        if (!entry) {
          const outcome: Outcome = { status: "failed", error: { code: "invalid", message: `nothing to ${m.direction}` } };
          remember(m.opId, { screenId: m.screenId, payload, outcome });
          return outcome;
        }
        // Undo can bring back a version of an object with scripts that no one checked in this state: check it first, inside
        // the queue, so the document cannot move on between the check and the commit.
        const doc = getDoc(m.screenId);
        const author = authorOf(c);
        const checked = doc && !receipts.has(m.opId)
          ? await checkProduced(applyInverse(doc, entry.inverse, withSources(doc, entry.inverse, { now: Date.now(), author, posters: new Map() }, m.opId)), "nothing was changed")
          : NOTHING_CHECKED;
        const { outcome, inverse } = await commit(c, m.screenId, m.opId, payload, (d, ctx) => applyInverse(d, entry.inverse, withSources(d, entry.inverse, ctx, m.opId)), checked);
        if (outcome.status === "committed" && inverse) { from.pop(); to.push({ opId: entry.opId, inverse }); }
        // A stale entry can never apply, so drop it. After a storage failure it may still apply: keep it for a retry.
        else if (outcome.status === "failed" && outcome.error.code !== "storage") from.pop();
        sendHistory(c, m.screenId);
        return outcome;
      });
      case "status": {
        const prior = receipts.get(m.opId);
        // A multipart final can replay before reconstructing its now-ephemeral bundle. Only exact caller identity
        // can take this shortcut; legacy operation-derived receipts still go through the ordinary commit check.
        if (m.identity) return prior?.payload === payloadKey([m.identity.screenId, { request: m.identity.request }])
          ? prior.outcome : { status: "unknown" } satisfies Outcome;
        return prior?.outcome ?? ({ status: accepted.has(m.opId) ? "accepted" : "unknown" } satisfies Outcome);
      }
      case "upload": return { held: uploads.held(m.hash, m.size) };
      case "importScreen": return importScreen(m.opId, m.head, operationPayload(m)!);
      case "readContent": {
        const b = lib.readContent(m.hash); if (!b) throw codeError("not-found", "no such content");
        return b.toString("base64");
      }
      case "poster": return objectPoster(m.screenId, m.itemId, m.pieces, m.contentVersion);
      case "montage": return screenMontage(m.screenId, m.rect, m.maxSize, m.labels ?? true);
      case "readContext": {
        const ctx = latestView(m.screenId, m.app), others = presence.others(m.screenId, c, m.lane);
        return ctx ? { view: ctx, open: true, others } : { view: null, open: false, others };
      }
      case "views": return [...contexts].flatMap(([screenId, m]) => [...m.values()].map((x) => ({ screenId, at: x.at, app: x.app }))).sort((a, b) => b.at - a.at);
      case "presence": {
        if (c.role !== "agent") throw codeError("forbidden", "only agents set a status");
        if (!getDoc(m.screenId)) throw codeError("not-found", `Screen ${m.screenId} not found`);
        c.screens.add(m.screenId);
        return presence.patch(c, m.screenId, m.lane, m.patch ?? {});
      }
      case "draft": {
        if (c.role !== "agent") throw codeError("forbidden", "only agents send drafts");
        if (!getDoc(m.screenId)) throw codeError("not-found", `Screen ${m.screenId} not found`);
        if (typeof m.text !== "string") throw codeError("invalid", "a draft part is text");
        c.screens.add(m.screenId);
        return presence.draft(c, m.screenId, m.lane, m.itemId ?? null, m.text, m.generation);
      }
      case "viewCommand": {
        const targets = [...conns].filter((x) => x.role === "canvas" && x.screens.has(m.screenId));
        if (targets.length === 0) return "no-view";
        const answer = new Promise<ViewCommandOutcome>((resolve) => {
          pendingCommands.set(m.command.id, resolve);
          setTimeout(() => { if (pendingCommands.delete(m.command.id)) resolve("dropped"); }, 3000);
        });
        for (const t of targets) send(t, { t: "viewCommand", screenId: m.screenId, command: m.command });
        return answer;
      }
      case "inspect": if (!dev?.secretOk(m.devSecret)) throw codeError("forbidden", "dev controls are off"); return dev.inspect();
      case "fault": {
        if (!dev?.secretOk(m.devSecret)) throw codeError("forbidden", "dev controls are off");
        if (m.fault.kind === "corrupt-document") {
          lib.corruptDocument(m.fault.screenId, m.fault.mode); docs.delete(m.fault.screenId);
          try { lib.read(m.fault.screenId); } catch { /* diagnostic now visible in catalog */ }
          return null;
        }
        if (m.fault.kind === "expire-uploads") { uploads.sweep(0); return null; }
        if (m.fault.kind === "expire-presence") { presence.expireAll(); return null; }
        if (m.fault.kind === "disconnect") { for (const x of conns) if (x.role === "canvas" && (m.fault.sessionId === null || x.sessionId === m.fault.sessionId)) x.ws.close(4000, "injected disconnect"); return null; }
        dev.fault(m.fault); return null;
      }
      default: throw codeError("invalid", "unknown request");
    }
  }

  /** Restores an exported Screen from its uploaded header and files, with every ID kept. Refuses a Screen ID the library has.
   *  The document rename is the only commit point: a crash before it leaves only content that recover() removes. */
  async function importScreen(opId: string, head: string, payload: string): Promise<ImportOutcome> {
    const answer = (screenId: string, outcome: ImportOutcome) => { remember(opId, { screenId, payload, outcome }); return outcome; };
    const prior = receipts.get(opId);
    if (prior) return prior.payload === payload ? prior.outcome as ImportOutcome : { status: "failed", error: { code: "invalid", message: "operation ID reused with a different payload" } };
    const bytes = lib.readContent(head);
    if (!bytes) return { status: "failed", error: { code: "missing-content", message: "upload the export header before importing" } };
    const parsed = parseArchiveHead(bytes);
    if ("error" in parsed) return answer("", { status: "failed", error: { code: parsed.error, message: parsed.message } });
    const checked = checkScreen(parsed.screen);
    if (!checked.ok) return answer("", { status: "failed", error: { code: checked.error.code === "limit" ? "limit" : "invalid", message: `the exported Screen is invalid: ${checked.error.message}` } });
    const doc = checked.doc;
    const listed = new Set(parsed.files.map((f) => f.hash)), needed = referencedHashes(doc);
    if (listed.size !== needed.size || [...needed].some((h) => !listed.has(h))) return answer(doc.id, { status: "failed", error: { code: "invalid", message: "the export's file list does not match the files its Screen references" } });
    const missing = [...needed].filter((h) => !lib.hasContent(h));
    if (missing.length) return { status: "failed", error: { code: "missing-content", message: `${missing.length} file(s) of the export were never uploaded` } };
    return serial(doc.id, opId, async () => {
      const again = receipts.get(opId);
      if (again) return again.payload === payload ? again.outcome as ImportOutcome : { status: "failed", error: { code: "invalid", message: "operation ID reused with a different payload" } };
      const existing = getDoc(doc.id);
      if (existing) return answer(doc.id, { status: "failed", error: { code: "exists", identical: canonical(existing) === canonical(doc),
        message: `Screen ${doc.id} already exists in this library; import never replaces or copies a Screen` } });
      // The storage error names library paths, which never reach a client: log it, answer plainly.
      const committed: ImportOutcome = { status: "committed", screenId: doc.id, title: doc.title, revision: doc.revision };
      try { publishCatalog(lib.write(doc, { opId, screenId: doc.id, payload, outcome: committed }), lib.catalog(), null, null); } catch (e) { console.log(`import ${doc.id}: ${(e as Error).message}`); return answer(doc.id, { status: "failed", error: { code: "storage", message: "the Screen could not be written to the library" } }); }
      docs.set(doc.id, doc);
      return answer(doc.id, committed);
    });
  }

  /** A binary frame is one upload chunk. Its answer is a text result, so the client's request map stays the one path. */
  function onChunk(c: Conn, data: Buffer) {
    lastActivity = Date.now();
    if (!c.authed) { c.ws.close(4401, "unauthorized"); return; }
    const ch = decodeChunk(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (!ch) return;
    const reply = (m: ServerMessage) => send(c, m);
    const { reqId, hash, size, offset } = ch.header;
    if (ch.bytes.length > 2 * CHUNK_BYTES) { reply({ t: "result", reqId, ok: false, error: { code: "limit", message: "chunk too large" } }); return; }
    const fault = dev?.chunkFault() ?? null;
    let bytes = ch.bytes;
    if (fault === "corrupt" && bytes.length) { bytes = Uint8Array.from(bytes); bytes[0] = bytes[0]! ^ 0xff; }
    try {
      if (fault === "fail") throw Object.assign(new Error("injected upload failure"), { code: "injected" });
      const held = uploads.write(hash, size, offset, bytes);
      // The chunk is accepted; the answer is lost with the socket.
      if (fault === "drop") { c.ws.terminate(); return; }
      reply({ t: "result", reqId, ok: true, value: { held } });
    } catch (e) {
      const err = e as Error & { code?: string };
      // Coded errors are the upload's own; anything else is storage, whose message names library paths.
      if (!err.code) console.log(`upload ${hash.slice(0, 12)}: ${err.message}`);
      reply({ t: "result", reqId, ok: false, error: ["invalid", "limit", "corrupt", "injected"].includes(err.code ?? "") ? { code: err.code!, message: err.message } : storageError(e) });
    }
  }

  function onMessage(c: Conn, raw: string) {
    lastActivity = Date.now();
    const m = parseClientMessage(raw);
    if (!m) return;
    if (!c.authed) {
      if (m.t !== "hello" || m.protocol !== PROTOCOL_VERSION || !safeEqual(m.token, token)) { c.ws.close(4401, "unauthorized"); return; }
      c.authed = true; c.role = m.role === "agent" ? "agent" : "canvas"; c.app = c.role === "canvas" && m.surface === "app";
      if (c.role === "agent") presence.hello(c, typeof m.name === "string" ? m.name : undefined);
      if (typeof m.sessionId === "string" && /^[\w-]{8,64}$/.test(m.sessionId)) c.sessionId = m.sessionId;
      send(c, { t: "welcome", instanceId, sessionId: c.sessionId, protocol: PROTOCOL_VERSION });
      return;
    }
    switch (m.t) {
      case "transient":
        if (!c.screens.has(m.screenId)) return;
        presence.personMoving(c, m.screenId, m.rects ? Object.keys(m.rects) : null);
        broadcast(m.screenId, { t: "transient", screenId: m.screenId, sessionId: c.sessionId, rects: m.rects }, c); return;
      case "context": if (c.role === "canvas" && c.screens.has(m.screenId)) { if (!contexts.has(m.screenId)) contexts.set(m.screenId, new Map()); contexts.get(m.screenId)!.set(c.sessionId, { ...m.context, sessionId: c.sessionId, at: Date.now(), app: !!c.app }); } return;
      case "leave": dropView(m.screenId, c.sessionId); return;
      case "viewCommandAnswer": { const r = pendingCommands.get(m.id); if (r) { pendingCommands.delete(m.id); r(m.outcome); } return; }
      case "hello": return;
    }
    const reqId = (m as { reqId: string }).reqId;
    if (stopping) { send(c, { t: "result", reqId, ok: false, error: { code: "storage", message: "Screens is shutting down; reconnect before saving" } }); return; }
    const opId = "opId" in m && m.t !== "status" ? m.opId : null;
    if (opId) {
      const payload = operationPayload(m)!, prior = accepted.get(opId);
      // Reject conflicting reuse before queueing. Otherwise purge can hold this ID while waiting for a Screen
      // queue whose next request waits for the same ID, deadlocking both queues and graceful shutdown.
      if (prior && prior.payload !== payload) {
        send(c, { t: "result", reqId, ok: true, value: { status: "failed", error: { code: "invalid", message: "operation ID reused with a different payload" } } });
        return;
      }
      accepted.set(opId, { payload, count: (prior?.count ?? 0) + 1 });
    }
    handle(c, m).then(
      (value) => { if ((m.t === "op" || m.t === "history") && dev?.dropResult()) return; send(c, { t: "result", reqId, ok: true, value }); },
      (e: Error & { code?: string }) => send(c, { t: "result", reqId, ok: false, error: publicError(e) }),
    ).finally(() => { if (opId) { const entry = accepted.get(opId); if (entry && --entry.count === 0) accepted.delete(opId); } });
  }

  // ── Canvas origin: app, design system, content, health, WebSocket ──
  const hostOk = (req: http.IncomingMessage, port: () => number) => {
    const h = req.headers.host ?? "";
    return h === `127.0.0.1:${port()}` || h === `localhost:${port()}`;
  };
  const static_ = (file: string, type: string) => (res: http.ServerResponse) => { res.setHeader("content-type", type); fs.createReadStream(file).pipe(res); };
  const routes: Record<string, (res: http.ServerResponse) => void> = {
    "/ui/tokens.css": static_(asset("tokens.css"), "text/css"),
    "/ui/components.css": static_(asset("components.css"), "text/css"),
    "/app.css": static_(asset("app.css"), "text/css"),
  };
  const appHtml = () => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Screens</title><link rel="stylesheet" href="/ui/tokens.css"><link rel="stylesheet" href="/ui/components.css"><link rel="stylesheet" href="/app.css">
<script>window.__SCREENS__=${JSON.stringify({ token, instanceId })};${openingConfigScript(openingConfig, appJs, { resourceUri: "/", serviceInstanceId: instanceId })}</script></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

  const canvasServer = http.createServer((req, res) => {
    lastActivity = Date.now();
    if (!hostOk(req, () => canvasPort)) { res.statusCode = 421; res.end("bad host"); return; }
    const url = new URL(req.url ?? "/", canvasOrigin);
    if (url.pathname === "/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ instanceId, protocol: PROTOCOL_VERSION })); return; }
    if (url.pathname === "/favicon.ico") { res.statusCode = 204; res.end(); return; }
    if (url.pathname === "/app.js") { res.setHeader("content-type", "text/javascript"); res.setHeader("cache-control", "no-store"); res.end(appJs); return; }
    const route = routes[url.pathname]; if (route) { route(res); return; }
    const content = url.pathname.match(/^\/content\/([0-9a-f]{64})$/);
    if (content) {
      const b = lib.readContent(content[1]!); if (!b) { res.statusCode = 404; res.end(); return; }
      res.setHeader("cache-control", "public, max-age=31536000, immutable"); res.end(b); return;
    }
    const poster = url.pathname.match(/^\/poster\/([\w-]+)\/([\w-]+)\/([0-9a-f]{24})$/);
    if (poster) {
      const it = getDoc(poster[1]!)?.items[poster[2]!];
      // The size is in the URL so a resized object gets a new address; the response is cached as immutable.
      if (!it || it.kind !== "html-snapshot" || it.contentVersion !== poster[3] || url.searchParams.get("s") !== `${it.width}x${it.height}`) { res.statusCode = 404; res.end(); return; }
      void objectPoster(poster[1]!, poster[2]!).then((a) => {
        const b = a.hash && a.contentVersion === poster[3] ? lib.readContent(a.hash) : null;
        if (!b) { res.statusCode = 404; res.end(); return; }
        res.setHeader("content-type", "image/jpeg"); res.setHeader("cache-control", "public, max-age=31536000, immutable"); res.end(b);
      }, () => { res.statusCode = 500; res.end(); });
      return;
    }
    const still = url.pathname.match(/^\/still\/([\w-]+)\/([\w-]+)\/([0-9a-f]{24})$/);
    if (still) {
      void designStill(still[1]!, still[2]!, still[3]!).then((b) => {
        if (!b) { res.statusCode = 404; res.end(); return; }
        res.setHeader("content-type", "image/png"); res.setHeader("cache-control", "no-store"); res.end(b);
      }, () => { res.statusCode = 500; res.end(); });
      return;
    }
    const thumb = url.pathname.match(/^\/thumb\/([0-9a-f]{64})$/);
    if (thumb) {
      void thumbnail(thumb[1]!).then((t) => {
        if (t) { res.setHeader("content-type", "image/jpeg"); res.setHeader("cache-control", "public, max-age=31536000, immutable"); res.end(t); return; }
        // No Chrome or not an image: the original, briefly cached so a later thumbnail can replace it.
        const b = lib.readContent(thumb[1]!); if (!b) { res.statusCode = 404; res.end(); return; }
        res.setHeader("cache-control", "max-age=60"); res.end(b);
      }, () => { res.statusCode = 500; res.end(); });
      return;
    }
    if (url.pathname === "/" || /^\/(s|f)\/[\w-]+$/.test(url.pathname) || url.pathname === "/media" || url.pathname === "/presentations" || url.pathname === "/documents" || url.pathname === "/archive" || url.pathname === "/bench") {
      res.setHeader("content-type", "text/html; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.end(appHtml()); return;
    }
    res.statusCode = 404; res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4e6 });
  canvasServer.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    if (!hostOk(req, () => canvasPort) || (origin !== undefined && origin !== canvasOrigin) || new URL(req.url ?? "/", canvasOrigin).pathname !== "/ws") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Conn = { ws, sessionId: crypto.randomUUID(), role: "canvas", screens: new Set(), library: false, authed: false };
      conns.add(c);
      // ws closes a connection on malformed or oversized frames, then emits error. Keep that failure local:
      // without a listener Node treats the socket error as an uncaught exception and exits the whole service.
      ws.on("error", () => {});
      ws.on("message", (d, isBinary) => { if (isBinary) onChunk(c, d as Buffer); else onMessage(c, d.toString()); });
      ws.on("close", () => {
        conns.delete(c); lastActivity = Date.now(); presence.leave(c);
        for (const s of c.screens) { broadcast(s, { t: "transient", screenId: s, sessionId: c.sessionId, rects: null }); dropView(s, c.sessionId); }
      });
    });
  });

  // ── Frame origin ──
  const frameServer = http.createServer((req, res) => {
    if (!hostOk(req, () => framePort)) { res.statusCode = 421; res.end("bad host"); return; }
    frameHandler(req, res);
  });
  const frameHandler = createFrameHandler({
    canvasOrigin: () => canvasOrigin, secret,
    resolve: (screenId, itemId, contentVersion) => {
      const it = getDoc(screenId)?.items[itemId];
      return it?.kind === "html-snapshot" && it.contentVersion === contentVersion ? { entry: it.entry, manifest: it.assetManifest } : null;
    },
    read: (h) => lib.readContent(h),
    onDiagnostics: (v, d) => console.log(`frames ${v}: ${d.join("; ")}`),
  });

  // The published package ships the canvas prebuilt, without the test hook; a checkout builds it now.
  appJs = bundle ? fs.readFileSync(path.join(here, "ui", "app.js"), "utf8") : await buildCanvas({ testHook: !!dev });
  // An explicit port is exact (screens-cli restarts on the same origins). Otherwise the ports this library last used come
  // first, so a canvas left open across a restart finds the service at the same origin; then the defaults, then any free port.
  const last = lastPorts(home);
  const canvasPort = await listen(canvasServer, opts.canvasPort !== undefined ? [opts.canvasPort] : [last?.canvas, 4980, 0]);
  const framePort = await listen(frameServer, opts.framePort !== undefined ? [opts.framePort] : [last?.frame, 4981, 0]);
  canvasOrigin = `http://127.0.0.1:${canvasPort}`; frameOrigin = `http://127.0.0.1:${framePort}`;
  try { fs.writeFileSync(path.join(home, "ports.json"), JSON.stringify({ canvas: canvasPort, frame: framePort })); } catch { /* only a preference */ }

  const reg: Registry = { pid: process.pid, instanceId, protocol: PROTOCOL_VERSION, token, canvasOrigin, frameOrigin, startedAt: new Date().toISOString(), dev: !!dev };
  const tmp = `${registryPath()}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 }); fs.renameSync(tmp, registryPath());
  console.log(`screens ready ${canvasOrigin} frames ${frameOrigin} (recovered: ${recovered.staging} staging, ${recovered.content} content files)`);

  const shutdown = async () => {
    if (stopping) return; stopping = true;
    // Finish accepted commits first (ARCHITECTURE: shutdown finishes accepted writes).
    while (checking.size || queues.size) await Promise.allSettled([...checking, ...queues.values()]);
    await validator.close();
    try { if (readRegistryPid() === process.pid) fs.rmSync(registryPath(), { force: true }); } catch { /* ignore */ }
    fs.rmSync(path.join(home, "service.lock"), { force: true });
    canvasServer.close(); frameServer.close(); process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown()); process.on("SIGINT", () => void shutdown());
  const idleMs = opts.dev && opts.idleMs !== undefined ? Math.max(100, opts.idleMs) : IDLE_EXIT_MS;
  if (opts.idleExit) setInterval(() => { if (conns.size === 0 && !queues.size && !checking.size && Date.now() - lastActivity > idleMs) void shutdown(); }, Math.min(10_000, idleMs)).unref();
  return reg;
}

/** The canvas script and styles for a page the service does not serve: an MCP App view. Prebuilt in the published package. */
export async function canvasAssets(o: { readonly testHook: boolean }): Promise<{ readonly js: string; readonly css: string }> {
  const js = bundle ? fs.readFileSync(path.join(here, "ui", "app.js"), "utf8") : await buildCanvas(o);
  const css = (["tokens.css", "components.css", "app.css"] as const).map((f) => fs.readFileSync(asset(f), "utf8")).join("\n");
  return { js, css };
}

/** testHook compiles in the read-only screens-cli hook (shell/testHook.ts). Production bundles never contain it. */
export async function buildCanvas(o: { readonly testHook: boolean }): Promise<string> {
  const esbuild = await import("esbuild");
  const r = await esbuild.build({
    entryPoints: [path.join(repo, "packages/canvas/src/shell/main.tsx")], bundle: true, write: false, format: "esm",
    target: "es2022", jsx: "automatic", minify: process.env.SCREENS_DEV ? false : true, sourcemap: process.env.SCREENS_DEV ? "inline" : false, logLevel: "warning",
    define: { "process.env.NODE_ENV": JSON.stringify(process.env.SCREENS_DEV ? "development" : "production"), __SCREENS_TEST__: String(o.testHook) },
  });
  return r.outputFiles[0]!.text;
}

/** Listens on the first free port of `ports`, in order. 0 is any free port. */
function listen(server: http.Server, ports: readonly (number | undefined)[]): Promise<number> {
  const order = [...new Set(ports.filter((p): p is number => Number.isInteger(p)))];
  return new Promise((resolve, reject) => {
    const tryPort = (i: number) => {
      server.once("error", (e: NodeJS.ErrnoException) => { if (e.code === "EADDRINUSE" && i + 1 < order.length) tryPort(i + 1); else reject(e); });
      server.listen(order[i], "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    };
    tryPort(0);
  });
}

/** The ports this library's service last listened on: a preference, never an identity. */
function lastPorts(home: string): { canvas: number; frame: number } | null {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(home, "ports.json"), "utf8")) as { canvas?: unknown; frame?: unknown };
    const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0 && (n as number) < 65536;
    return ok(p.canvas) && ok(p.frame) ? { canvas: p.canvas, frame: p.frame } : null;
  } catch { return null; }
}

/** Per-install access token (proposal P8): survives restarts so open canvases can reconnect. */
function installToken(home: string): string {
  const file = path.join(home, "token");
  try { const t = fs.readFileSync(file, "utf8").trim(); if (/^[0-9a-f]{48}$/.test(t)) return t; } catch { /* create below */ }
  const t = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

function takeLock(file: string): boolean {
  try { fs.writeFileSync(file, String(process.pid), { flag: "wx" }); return true; }
  catch {
    const pid = Number(fs.readFileSync(file, "utf8"));
    try { process.kill(pid, 0); return false; } catch { fs.writeFileSync(file, String(process.pid)); return true; }
  }
}
function readRegistryPid(): number | null { try { return (JSON.parse(fs.readFileSync(registryPath(), "utf8")) as Registry).pid; } catch { return null; } }
/** Stable JSON: key order does not matter, so a stored document and the same one read from an export compare equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
/** A malformed op is applyOperation's to report, so the content check never throws. */
function safeContentHashes(op: Operation): string[] { try { return contentHashes(op); } catch { return []; } }
function safeEqual(a: unknown, b: string): boolean { return typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
const round = (n: number) => Math.round(n * 100) / 100;
function codeError(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }

/** OS messages often contain absolute paths. Only domain diagnostics cross the service boundary. */
function storageError(e: unknown): { code: "storage"; message: string } {
  console.error(e);
  return { code: "storage", message: (e as NodeJS.ErrnoException)?.code === "ENOSPC"
    ? "Disk full. Free some space and try again; nothing was saved."
    : "Couldn't save to the library. Check that storage is available and try again." };
}
function publicError(e: Error & { code?: string }): { code: string; message: string } {
  if (["corrupt", "invalid", "limit", "not-found", "forbidden", "conflict"].includes(e.code ?? "")) return { code: e.code!, message: e.message };
  return storageError(e);
}
