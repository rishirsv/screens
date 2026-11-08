// Domain operations. Pure: (doc, op, ctx) → next doc plus a guarded inverse, or an error.
// UI, MCP and CLI edits all go through applyOperation, so they follow identical rules.

import type { AssetManifest, Author, CanvasItem, PagedLayout, Comment, CommentId, HtmlSnapshotItem, ItemId, Point, Rect, ReferenceImageItem, Revision, ScreenDoc, Stroke, StrokeAnchor, StrokeId, StrokePoint, Thread, ThreadAnchor, ThreadId } from "./model.ts";
import { CLIENT_ID, COMMENTS_PER_THREAD_MAX, COMMENT_MAX, HEX_COLOR, ITEMS_MAX, ITEM_SIZE_MAX, ITEM_SIZE_MIN, STROKES_MAX, STROKE_MAX_POINTS, STROKE_SIZE_MAX, THREADS_MAX, TITLE_MAX } from "./limits.ts";
import { reanchorArea, type ThreadPosition } from "./comments.ts";
import { readDoc } from "./model.ts";
import { PAGE_SIZE, byStack, isPagedLayout, pageOrder, pageRect } from "./pages.ts";
import { PieceError, applyEdits, checkClassOf, isTextMedia, pieceTree, restoreSteps, row, stamp, type ObjectDelta, type EditInput, type Files, type PieceNode, type PieceStep } from "./pieces.ts";

/** x and y may be omitted: the item is then placed 80 units right of everything, top-aligned. */
/** posterHash is never client input: the service supplies it through Context.posters. */
type ItemFields<T> = Omit<T, "revision" | "z" | "x" | "y" | "posterHash"> & { readonly z?: number; readonly x?: number; readonly y?: number };
export type NewItem = ItemFields<HtmlSnapshotItem> | ItemFields<ReferenceImageItem>;
export interface NewStroke { readonly id: StrokeId; readonly anchor: StrokeAnchor; readonly points: readonly StrokePoint[]; readonly color: string; readonly size: number }
/** Author and time come from the Context, never from the client. */
export interface NewComment { readonly id: CommentId; readonly text: string }
export interface NewThread extends ThreadPosition { readonly id: ThreadId; readonly comment: NewComment }

export type Operation =
  | { readonly type: "addItem"; readonly item: NewItem }
  | { readonly type: "updateSnapshot"; readonly itemId: ItemId; readonly entry: string; readonly contentVersion: string; readonly assetManifest: AssetManifest; readonly expectedRevision?: Revision }
  /** Last writer wins for geometry. Fails only when an item no longer exists. */
  | { readonly type: "moveItems"; readonly moves: readonly { readonly itemId: ItemId; readonly x: number; readonly y: number }[] }
  | { readonly type: "resizeItems"; readonly sizes: readonly { readonly itemId: ItemId; readonly width: number; readonly height: number }[] }
  | { readonly type: "retitleItem"; readonly itemId: ItemId; readonly title: string; readonly expectedRevision?: Revision }
  /** Moves the items above (front) or below (back) every other item, or one step past the next item above (forward) or
   *  below (backward), keeping their order among themselves. { index } puts them in one block whose first item ends at
   *  that position in the full order. On a Presentation or Document that order is the page order. */
  | { readonly type: "reorderItems"; readonly itemIds: readonly ItemId[]; readonly to: ReorderTarget }
  /** Cascades strokes and threads anchored to the removed items, and clears links to them from snapshots that name a
   *  removed image as a source. */
  | { readonly type: "removeItems"; readonly itemIds: readonly ItemId[] }
  | { readonly type: "addStroke"; readonly stroke: NewStroke }
  | { readonly type: "removeStroke"; readonly strokeId: StrokeId }
  | { readonly type: "addThread"; readonly thread: NewThread }
  /** Re-anchors too: item → world, world → item, item → item. Last writer wins, like moveItems. */
  | { readonly type: "moveThread"; readonly threadId: ThreadId; readonly anchor: ThreadAnchor; readonly x: number; readonly y: number }
  | { readonly type: "addComment"; readonly threadId: ThreadId; readonly comment: NewComment }
  /** Guarded text replacement: replies and moves do not invalidate an edit. */
  | { readonly type: "editComment"; readonly threadId: ThreadId; readonly commentId: CommentId; readonly text: string; readonly expectedText: string }
  /** resolved=false reopens. Writing the current value changes nothing, so it fails like any no-op. */
  | { readonly type: "resolveThread"; readonly threadId: ThreadId; readonly resolved: boolean }
  /** Removing comments[0] removes the whole thread. */
  | { readonly type: "removeComment"; readonly threadId: ThreadId; readonly commentId: CommentId }
  | { readonly type: "removeThread"; readonly threadId: ThreadId }
  | { readonly type: "renameScreen"; readonly title: string; readonly expectedRevision?: Revision }
  /** Edits pieces of an object's HTML, all or nothing, against its current source: targets resolve at commit time, so
   *  edits to other pieces in between are kept. An empty list only stamps ids on an object saved before pieces had them. */
  | { readonly type: "editObject"; readonly itemId: ItemId; readonly edits: readonly EditInput[]; readonly expectedRevision?: Revision }
  /** All or nothing. */
  | { readonly type: "batch"; readonly ops: readonly Operation[] };

export type ReorderStep = "front" | "back" | "forward" | "backward";
export type ReorderTarget = ReorderStep | { readonly index: number };
export const REORDER_TARGETS: readonly ReorderStep[] = ["front", "back", "forward", "backward"];
export const isReorderTarget = (t: unknown): t is ReorderTarget =>
  (REORDER_TARGETS as readonly unknown[]).includes(t) || (!!t && typeof t === "object" && Number.isInteger((t as { index?: unknown }).index) && (t as { index: number }).index >= 0);

/**
 * The z each of `ids` gets for a reorder. The only code that decides stacking; the canvas uses it for its pending preview.
 * front and back move the ids above or below every other item. forward and backward move each run of ids one step past
 * the next other item above or below it. { index } puts the ids in one block, first at `index` of the final order (an
 * index past the end means last). Ids keep their order among themselves (z, then id, like sortItems). Items whose
 * z does not change are left out, so a reorder that changes nothing yields an empty map. Unknown ids are ignored. Pure.
 */
export function reorderedZ(items: readonly { readonly id: ItemId; readonly z: number }[], ids: readonly ItemId[], to: ReorderTarget): Map<ItemId, number> {
  const want = new Set(ids);
  const all = [...items].sort(byStack);
  const out = new Map<ItemId, number>();
  if (!all.some((i) => want.has(i.id))) return out;
  if (typeof to === "object") {
    const moving = all.filter((i) => want.has(i.id)), rest = all.filter((i) => !want.has(i.id));
    const at = Math.min(Math.max(0, to.index), rest.length);
    return reuseZ(all, [...rest.slice(0, at), ...moving, ...rest.slice(at)]);
  }
  if (to === "front" || to === "back") {
    const moving = all.filter((i) => want.has(i.id)), rest = all.filter((i) => !want.has(i.id));
    // Already in place: the moving items are the top (or bottom) of the full order, in the same relative order.
    const edge = to === "front" ? all.slice(all.length - moving.length) : all.slice(0, moving.length);
    if (edge.every((it, i) => it.id === moving[i]!.id)) return out;
    if (to === "front") {
      const top = rest.length ? rest[rest.length - 1]!.z : 0;
      moving.forEach((it, i) => { const z = top + 1 + i; if (z !== it.z) out.set(it.id, z); });
    } else {
      const bottom = rest.length ? rest[0]!.z : 0;
      moving.forEach((it, i) => { const z = bottom - moving.length + i; if (z !== it.z) out.set(it.id, z); });
    }
    return out;
  }
  // One step: each moving item swaps past the other item next to it, scanning from the far end so a run moves together.
  const next = [...all];
  if (to === "forward") { for (let i = next.length - 2; i >= 0; i--) if (want.has(next[i]!.id) && !want.has(next[i + 1]!.id)) [next[i], next[i + 1]] = [next[i + 1]!, next[i]!]; }
  else for (let i = 1; i < next.length; i++) if (want.has(next[i]!.id) && !want.has(next[i - 1]!.id)) [next[i], next[i - 1]] = [next[i - 1]!, next[i]!];
  return reuseZ(all, next);
}

/** The new order reuses the existing z values, raised only where equal values would leave the order ambiguous, so only
 *  the items whose place changes get a new z. */
function reuseZ(all: readonly { readonly id: ItemId; readonly z: number }[], next: readonly { readonly id: ItemId; readonly z: number }[]): Map<ItemId, number> {
  const out = new Map<ItemId, number>();
  if (next.every((it, i) => it === all[i])) return out;
  let prev = -Infinity;
  next.forEach((it, i) => { const z = Math.max(all[i]!.z, prev + 1); prev = z; if (z !== it.z) out.set(it.id, z); });
  return out;
}

export type OperationErrorCode = "conflict" | "invalid" | "not-found" | "limit";
export interface OperationError { readonly code: OperationErrorCode; readonly message: string }

/**
 * One touched record. `after` is what the operation wrote (null: the record was removed),
 * `before` what it replaced (null: the record did not exist). For an existing record both hold only the touched fields.
 */
export type InverseEntry =
  | { readonly kind: "item"; readonly id: ItemId; readonly before: Partial<CanvasItem> | null; readonly after: Partial<CanvasItem> | null }
  | { readonly kind: "stroke"; readonly id: StrokeId; readonly before: Stroke | null; readonly after: Stroke | null }
  | { readonly kind: "title"; readonly before: string; readonly after: string }
  /** A thread's head (pin, anchor, resolved). Created or removed: the non-null side is the whole head. */
  | { readonly kind: "thread"; readonly id: ThreadId; readonly before: Partial<ThreadHead> | null; readonly after: Partial<ThreadHead> | null }
  /** One comment. Restoring re-inserts it in createdAt order, so concurrent replies keep their places. */
  | { readonly kind: "comment"; readonly threadId: ThreadId; readonly id: CommentId; readonly before: Comment | null; readonly after: Comment | null }
  /** Piece edits to one object, field by field. The item's content fields follow from them and are not guarded, so undoing
   *  one person's hide survives an agent's later card edit. */
  | { readonly kind: "pieces"; readonly itemId: ItemId; readonly steps: readonly PieceStep[] };
export type ThreadHead = Omit<Thread, "comments">;
/** Opaque to clients. Applying it restores `before` only if every touched field still equals `after`. */
export interface GuardedInverse { readonly entries: readonly InverseEntry[] }

export type Transition =
  | { readonly ok: false; readonly error: OperationError }
  | { readonly ok: true; readonly doc: ScreenDoc; readonly inverse: GuardedInverse; readonly produced: ReadonlyMap<string, string>; readonly deltas: readonly ObjectDelta[]; readonly contents: readonly ObjectContent[] };

/** Object content a transition wrote itself (piece edits, stamping, undo). inert content needs no load check before commit. */
export interface ObjectContent extends SnapshotContent { readonly inert: boolean }

export interface Context {
  readonly now: number;
  readonly author: Author;
  /** itemId → the poster the service rendered for that item's final content in this operation. Missing means no poster. */
  readonly posters: ReadonlyMap<string, string>;
  /** Content hash → text, for every text file of the objects an operation reads (see sourcesNeeded). */
  readonly sources?: ReadonlyMap<string, string>;
  /** SHA-256 of the UTF-8 text, lower-case hex: the content store's hash. */
  readonly digest?: (text: string) => string;
  /** Seeds stamped piece ids, so a replay of the same operation stamps the same ids. */
  readonly seed?: string;
}

/** Snapshot content an operation adds or replaces, at the size it will show. */
export interface SnapshotContent {
  readonly itemId: ItemId; readonly contentVersion: string; readonly entry: string;
  readonly manifest: AssetManifest; readonly width: number; readonly height: number;
}

/** Every snapshot content `op` brings, in order. An update to a missing item or a non-snapshot is skipped:
 *  applyOperation reports that error. Sizes come from the op or the current document. Pure. */
export function snapshotContents(doc: ScreenDoc, op: Operation): SnapshotContent[] {
  const out: SnapshotContent[] = [];
  const size = new Map<ItemId, { width: number; height: number }>();
  // A page is always the page size, whatever the op says (see addItem).
  const page = doc.layout ? PAGE_SIZE[doc.layout] : null;
  const walk = (o: Operation): void => {
    if (o.type === "batch") { for (const inner of o.ops) walk(inner); return; }
    if (o.type === "resizeItems") { for (const s of o.sizes) size.set(s.itemId, { width: s.width, height: s.height }); return; }
    if (o.type === "addItem" && o.item.kind === "html-snapshot") {
      const it = o.item;
      const s = page ?? { width: it.width, height: it.height };
      size.set(it.id, s);
      out.push({ itemId: it.id, contentVersion: it.contentVersion, entry: it.entry, manifest: it.assetManifest, width: s.width, height: s.height });
    } else if (o.type === "updateSnapshot") {
      const cur = doc.items[o.itemId];
      const s = size.get(o.itemId) ?? (cur?.kind === "html-snapshot" ? cur : null);
      if (s) out.push({ itemId: o.itemId, contentVersion: o.contentVersion, entry: o.entry, manifest: o.assetManifest, width: s.width, height: s.height });
    }
  };
  walk(op);
  return out;
}

class Fail extends Error {
  readonly code: OperationErrorCode;
  constructor(code: OperationErrorCode, message: string) { super(message); this.code = code; }
}
const fail = (code: OperationErrorCode, message: string): never => { throw new Fail(code, message); };

/** A thread inside a transition. Its comments may be empty only while a restore runs; checkRefs refuses that at the end.
 *  Threads are replaced, never mutated in place, so the input document stays untouched. */
type DraftThread = ThreadHead & { readonly comments: readonly Comment[] };
/** Mutable working copy for one transition. */
interface Draft { readonly layout: PagedLayout | null; title: string; items: Record<ItemId, CanvasItem>; strokes: Record<StrokeId, Stroke>; threads: Record<ThreadId, DraftThread>; entries: InverseEntry[]; revision: Revision;
  produced: Map<string, string>; deltas: ObjectDelta[]; contents: Map<ItemId, ObjectContent>; texts: Map<ItemId, Map<string, string>> }

const draftOf = (doc: ScreenDoc): Draft => ({ layout: doc.layout ?? null, title: doc.title, items: { ...doc.items }, strokes: { ...doc.strokes }, threads: { ...doc.threads }, entries: [], revision: doc.revision + 1,
  produced: new Map(), deltas: [], contents: new Map(), texts: new Map() });
const done = (doc: ScreenDoc, d: Draft, ctx: Context, entries: InverseEntry[]): Transition =>
  ({ ok: true, doc: finish(doc, d, ctx), inverse: { entries }, produced: d.produced, deltas: d.deltas, contents: [...d.contents.values()] });

export function applyOperation(doc: ScreenDoc, op: Operation, ctx: Context): Transition {
  const draft = draftOf(doc);
  try {
    apply(draft, op, ctx);
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: { code: e.code, message: e.message } };
    throw e;
  }
  if (draft.entries.length === 0) return { ok: false, error: { code: "invalid", message: "operation changes nothing" } };
  relayout(draft);
  return done(doc, draft, ctx, draft.entries);
}

/** Applies an inverse through the same guarded path. The returned inverse re-applies the original (redo). */
export function applyInverse(doc: ScreenDoc, inverse: GuardedInverse, ctx: Context): Transition {
  const draft = draftOf(doc);
  try {
    // Restore in reverse order so a cascade restores its item before the item's strokes and threads,
    // and a thread's head before its comments.
    for (const entry of [...inverse.entries].reverse()) restore(draft, entry, ctx);
    checkRefs(draft);
    relayout(draft);
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: { code: e.code, message: e.message } };
    throw e;
  }
  // restore records each reverse change in execution order. The next undo/redo reverses that order itself.
  return done(doc, draft, ctx, draft.entries);
}

/** Fields relayout owns on a Presentation or Document. No operation writes them there and no undo guards them. */
const PLACED = new Set(["x", "y", "width", "height"]);

/**
 * Places every page by its index in (z, id) order. The rect is a function of z, which the inverse entries already carry,
 * so relayout writes no inverse entry and no item revision: undo restores z under its guard and relayout re-derives the
 * places, and a later edit that shifted pages never makes an undo or an expectedRevision fail. Unchanged items keep
 * their object. Running it twice changes nothing.
 */
function relayout(d: Draft): void {
  if (!d.layout) return;
  pageOrder(Object.values(d.items)).forEach((it, i) => {
    const r = pageRect(d.layout!, i);
    if (it.x !== r.x || it.y !== r.y || it.width !== r.width || it.height !== r.height) d.items[it.id] = { ...it, ...r };
  });
}

const PAGED_NAME = { slides: "a Presentation", a4: "a Document" } as const;
/** Refuses free placement and world marks on a Presentation or Document. */
function noFree(d: Draft, what: string, hint: string): void {
  if (d.layout) fail("invalid", `${what} on ${PAGED_NAME[d.layout]}: ${hint}`);
}

function finish(doc: ScreenDoc, d: Draft, ctx: Context): ScreenDoc {
  // checkRefs (inverse) and every apply case keep each thread non-empty, so the draft threads are Threads here.
  return { ...doc, title: d.title, items: d.items, strokes: d.strokes, threads: d.threads as Record<ThreadId, Thread>, revision: d.revision, updatedAt: ctx.now };
}

/** After a restore: capacity limits hold, nothing anchors to a missing item, no snapshot names a missing image, and no thread is empty.
 *  Undo refuses rather than orphan someone's work. */
function checkRefs(d: Draft): void {
  // Another writer can fill a slot after this session deleted a record. Restoring must obey the same limits as add,
  // or the service could commit a document that storage refuses to open after a restart.
  if (Object.keys(d.items).length > ITEMS_MAX) fail("conflict", "the Screen's item capacity was used since this edit");
  if (Object.keys(d.strokes).length > STROKES_MAX) fail("conflict", "the Screen's stroke capacity was used since this edit");
  if (Object.keys(d.threads).length > THREADS_MAX) fail("conflict", "the Screen's thread capacity was used since this edit");
  // Only links this restore wrote or removed the target of: older documents may hold dangling links, and
  // those must not block an unrelated undo.
  const removed = new Set<ItemId>();
  for (const e of d.entries) if (e.kind === "item") {
    if (e.after === null) removed.add(e.id);
    else if (e.after.kind !== undefined || "sourceReferenceIds" in e.after) {
      // A re-created snapshot checks every link; a rewritten list checks only the links it adds.
      const it = d.items[e.id];
      const had = new Set(e.before && e.before.kind === undefined ? (e.before as Partial<HtmlSnapshotItem>).sourceReferenceIds ?? [] : []);
      if (it?.kind === "html-snapshot") for (const r of it.sourceReferenceIds) if (!had.has(r) && d.items[r]?.kind !== "reference-image") fail("conflict", `source image ${r} was removed since this edit`);
    }
  }
  if (removed.size) for (const it of Object.values(d.items))
    if (it.kind === "html-snapshot" && it.sourceReferenceIds.some((r) => removed.has(r))) fail("conflict", `snapshot ${it.id} names ${it.sourceReferenceIds.find((r) => removed.has(r))} as its source`);
  for (const s of Object.values(d.strokes)) if (s.anchor.kind === "item" && !d.items[s.anchor.itemId]) fail("conflict", `stroke ${s.id} was drawn on item ${s.anchor.itemId} since this edit`);
  for (const t of Object.values(d.threads)) {
    if (t.anchor.kind === "item" && !d.items[t.anchor.itemId]) fail("conflict", `thread ${t.id} was pinned to item ${t.anchor.itemId} since this edit`);
    if (t.comments.length === 0) fail("conflict", `thread ${t.id} lost its first comment since this edit`);
    if (t.comments.length > COMMENTS_PER_THREAD_MAX) fail("conflict", `thread ${t.id}'s comment capacity was used since this edit`);
  }
}

function apply(d: Draft, op: Operation, ctx: Context): void {
  switch (op.type) {
    case "batch":
      if (op.ops.length === 0) fail("invalid", "empty batch");
      for (const inner of op.ops) apply(d, inner, ctx);
      return;
    case "addItem": {
      const it = op.item;
      if (d.items[it.id]) fail("conflict", `item ${it.id} already exists`);
      if (Object.keys(d.items).length >= ITEMS_MAX) fail("limit", `a Screen holds at most ${ITEMS_MAX} items`);
      if (d.layout && (it.x !== undefined || it.y !== undefined)) noFree(d, "pages are placed by order", "leave out x and y, and use reorder_items");
      // A page is the page size: width and height are an image's natural size or a tool's default, not a request.
      const page = d.layout ? PAGE_SIZE[d.layout] : null;
      const width = page?.width ?? it.width, height = page?.height ?? it.height;
      const slot = !page && (it.x === undefined || it.y === undefined) ? nextSlot(d, []) : null;
      const x = page ? 0 : it.x ?? slot!.x, y = page ? 0 : it.y ?? slot!.y;
      checkGeometry(x, y, width, height);
      checkTitle(it.title);
      if (it.kind === "html-snapshot") {
        checkManifest(it.entry, it.assetManifest);
        for (const ref of it.sourceReferenceIds) if (d.items[ref]?.kind !== "reference-image") fail("invalid", `source reference ${ref} is not a reference image`);
      } else if (it.kind !== "reference-image") fail("invalid", `unknown item kind`);
      const z = it.z ?? Math.max(0, ...Object.values(d.items).map((i) => i.z)) + 1;
      let item = (it.kind === "html-snapshot" ? { ...it, x, y, width, height, z, posterHash: ctx.posters.get(it.id) ?? null, revision: d.revision } : { ...it, x, y, width, height, z, revision: d.revision }) as CanvasItem;
      if (item.kind === "html-snapshot") item = stamped(d, item, ctx);
      d.items[it.id] = item;
      d.entries.push({ kind: "item", id: it.id, before: null, after: item });
      return;
    }
    case "updateSnapshot": {
      const cur = existing(d, op.itemId);
      if (cur.kind !== "html-snapshot") return fail("invalid", `${op.itemId} is not an object`);
      checkRevision(cur.revision, op.expectedRevision, op.itemId);
      checkManifest(op.entry, op.assetManifest);
      const s = stamped(d, { ...cur, entry: op.entry, contentVersion: op.contentVersion, assetManifest: op.assetManifest, posterHash: ctx.posters.get(op.itemId) ?? null }, ctx);
      touchItem(d, cur, { entry: s.entry, contentVersion: s.contentVersion, assetManifest: s.assetManifest, posterHash: s.posterHash });
      return;
    }
    case "editObject": {
      const cur = existing(d, op.itemId);
      if (cur.kind !== "html-snapshot") return fail("invalid", `${op.itemId} is not an object`);
      checkRevision(cur.revision, op.expectedRevision, op.itemId);
      const files = filesOf(d, cur, ctx);
      const seed = `${ctx.seed ?? ctx.now}`;
      let r: ReturnType<typeof applyEdits>;
      try { r = applyEdits(files, op.edits, (n) => pidFor(ctx, seed, n), { allowEmpty: true }); }
      catch (e) { if (e instanceof PieceError) fail(e.code, e.matches ? `${e.message}\n${e.matches}` : e.message); throw e; }
      if (files.texts.get(files.entry) === d.texts.get(cur.id)!.get(cur.entry) && r.steps.length === 0 && [...files.texts].every(([k, v]) => d.texts.get(cur.id)!.get(k) === v)) return;
      const next = writeObject(d, cur, files, ctx);
      d.entries.push({ kind: "pieces", itemId: cur.id, steps: stampStep(d, cur, files, r.steps) });
      const tree = pieceTree(files.texts.get(files.entry)!);
      d.deltas.push({ itemId: cur.id, contentVersion: next.contentVersion, resolved: r.resolved, changed: rowsOf(tree, r.touched), removed: r.removed, renumbered: r.renumbered,
        inert: d.contents.get(cur.id)!.inert });
      return;
    }
    case "moveItems":
      noFree(d, "pages are placed by order", "use reorder_items");
      if (op.moves.length === 0) fail("invalid", "no moves");
      for (const m of op.moves) {
        const cur = existing(d, m.itemId);
        checkGeometry(m.x, m.y, cur.width, cur.height);
        if (cur.x !== m.x || cur.y !== m.y) touchItem(d, cur, { x: m.x, y: m.y });
      }
      return;
    case "resizeItems":
      noFree(d, "pages are the page size", "they cannot be resized");
      for (const s of op.sizes) {
        const cur = existing(d, s.itemId);
        checkGeometry(cur.x, cur.y, s.width, s.height);
        touchItem(d, cur, { width: s.width, height: s.height });
      }
      return;
    case "retitleItem": {
      const cur = existing(d, op.itemId);
      checkRevision(cur.revision, op.expectedRevision, op.itemId);
      const title = op.title.trim();
      checkTitle(title);
      if (title !== cur.title) touchItem(d, cur, { title });
      return;
    }
    case "reorderItems": {
      if (op.itemIds.length === 0) fail("invalid", "no items");
      if (!isReorderTarget(op.to)) fail("invalid", `to must be ${REORDER_TARGETS.join(", ")} or { index }`);
      for (const id of op.itemIds) existing(d, id);
      if (typeof op.to === "object") {
        const others = Object.keys(d.items).length - new Set(op.itemIds).size;
        if (op.to.index > others) fail("invalid", `index must be 0-${others}`);
      }
      for (const [id, z] of reorderedZ(Object.values(d.items), op.itemIds, op.to)) touchItem(d, d.items[id]!, { z });
      return;
    }
    case "removeItems": {
      if (op.itemIds.length === 0) fail("invalid", "no items");
      const ids = new Set(op.itemIds);
      for (const id of ids) existing(d, id);
      // A removed image stops being any snapshot's source. Recorded before the removals, so undo (which runs in
      // reverse) brings the image back before the link that names it.
      for (const it of Object.values(d.items)) if (it.kind === "html-snapshot" && !ids.has(it.id) && it.sourceReferenceIds.some((r) => ids.has(r)))
        touchItem(d, it, { sourceReferenceIds: it.sourceReferenceIds.filter((r) => !ids.has(r)) });
      for (const s of Object.values(d.strokes)) if (s.anchor.kind === "item" && ids.has(s.anchor.itemId)) {
        delete d.strokes[s.id];
        d.entries.push({ kind: "stroke", id: s.id, before: s, after: null });
      }
      for (const t of Object.values(d.threads)) if (t.anchor.kind === "item" && ids.has(t.anchor.itemId)) dropThread(d, t);
      for (const id of ids) {
        const cur = d.items[id]!;
        delete d.items[id];
        d.entries.push({ kind: "item", id, before: cur, after: null });
      }
      return;
    }
    case "addStroke": {
      const s = op.stroke;
      if (!CLIENT_ID.test(s.id)) fail("invalid", "stroke id must be 8-32 lower-case letters or digits");
      if (d.strokes[s.id]) fail("conflict", `stroke ${s.id} already exists`);
      if (Object.keys(d.strokes).length >= STROKES_MAX) fail("limit", `a Screen holds at most ${STROKES_MAX} strokes`);
      if (!HEX_COLOR.test(s.color)) fail("invalid", "color must be #rrggbb");
      if (!(Number.isFinite(s.size) && s.size > 0 && s.size <= STROKE_SIZE_MAX)) fail("invalid", "size out of range");
      if (s.points.length < 1 || s.points.length > STROKE_MAX_POINTS) fail("invalid", `1-${STROKE_MAX_POINTS} points required`);
      for (const p of s.points) if (p.length !== 3 || !p.every(Number.isFinite)) fail("invalid", "points must be finite [x, y, pressure]");
      if (s.anchor.kind === "item" && !d.items[s.anchor.itemId]) fail("not-found", `anchor item ${s.anchor.itemId} not found`);
      if (s.anchor.kind !== "item") noFree(d, "strokes are drawn on a page", "anchor the stroke to an item");
      const stroke: Stroke = { ...s, author: ctx.author, createdAt: ctx.now };
      d.strokes[s.id] = stroke;
      d.entries.push({ kind: "stroke", id: s.id, before: null, after: stroke });
      return;
    }
    case "removeStroke": {
      const cur = d.strokes[op.strokeId] ?? fail("not-found", `stroke ${op.strokeId} not found`);
      delete d.strokes[op.strokeId];
      d.entries.push({ kind: "stroke", id: op.strokeId, before: cur, after: null });
      return;
    }
    case "addThread": {
      const t = op.thread;
      if (!CLIENT_ID.test(t.id) || !CLIENT_ID.test(t.comment.id)) fail("invalid", "thread and comment ids must be 8-32 lower-case letters or digits");
      if (d.threads[t.id]) fail("conflict", `thread ${t.id} already exists`);
      if (Object.keys(d.threads).length >= THREADS_MAX) fail("limit", `a Screen holds at most ${THREADS_MAX} threads`);
      checkPosition(d, t);
      const comment = newComment(d, t.comment, ctx);
      const head: ThreadHead = { id: t.id, anchor: t.anchor, x: t.x, y: t.y, ...(t.area ? { area: { w: t.area.w, h: t.area.h } } : {}), resolved: false, createdAt: ctx.now };
      d.threads[t.id] = { ...head, comments: [comment] };
      // Head first, then the comment: undo runs in reverse, so it takes the comment out before the head.
      d.entries.push({ kind: "thread", id: t.id, before: null, after: head });
      d.entries.push({ kind: "comment", threadId: t.id, id: comment.id, before: null, after: comment });
      return;
    }
    case "moveThread": {
      const cur = existingThread(d, op.threadId);
      // A circled region keeps its world size when the pin moves onto another item or off one.
      const next = { anchor: op.anchor, x: op.x, y: op.y, ...(cur.area ? { area: reanchorArea(cur.area, cur.anchor, op.anchor, (id) => { const it = d.items[id]; return it && { w: it.width, h: it.height }; }) } : {}) };
      checkPosition(d, next);
      if (!same(cur.anchor, next.anchor) || cur.x !== next.x || cur.y !== next.y) touchThread(d, cur, next);
      return;
    }
    case "addComment": {
      const cur = existingThread(d, op.threadId);
      if (!CLIENT_ID.test(op.comment.id)) fail("invalid", "comment id must be 8-32 lower-case letters or digits");
      if (cur.comments.length >= COMMENTS_PER_THREAD_MAX) fail("limit", `a thread holds at most ${COMMENTS_PER_THREAD_MAX} comments`);
      const last = cur.comments.at(-1)!;
      // createdAt strictly increases within a thread (a batch shares one clock), so array order and time order are the same
      // thing and a restore puts every comment back in its place.
      const comment = newComment(d, op.comment, { ...ctx, now: Math.max(ctx.now, last.createdAt + 1) });
      d.threads[cur.id] = { ...cur, comments: [...cur.comments, comment] };
      d.entries.push({ kind: "comment", threadId: cur.id, id: comment.id, before: null, after: comment });
      return;
    }
    case "editComment": {
      const cur = existingThread(d, op.threadId);
      const before = cur.comments.find((c) => c.id === op.commentId) ?? fail("not-found", `comment ${op.commentId} not found in thread ${op.threadId}`);
      if (before.text !== op.expectedText) fail("conflict", "the comment changed since you read it");
      const text = typeof op.text === "string" ? op.text.trim() : "";
      if (!text || text.length > COMMENT_MAX) fail("invalid", `comments must be 1-${COMMENT_MAX} characters`);
      if (text === before.text) return;
      const after = { ...before, text };
      d.threads[cur.id] = { ...cur, comments: cur.comments.map((c) => c.id === before.id ? after : c) };
      d.entries.push({ kind: "comment", threadId: cur.id, id: before.id, before, after });
      return;
    }
    case "resolveThread": {
      const cur = existingThread(d, op.threadId);
      if (typeof op.resolved !== "boolean") fail("invalid", "resolved must be true or false");
      if (cur.resolved !== op.resolved) touchThread(d, cur, { resolved: op.resolved });
      return;
    }
    case "removeComment": {
      const cur = existingThread(d, op.threadId);
      const i = cur.comments.findIndex((c) => c.id === op.commentId);
      if (i < 0) fail("not-found", `comment ${op.commentId} not found in thread ${op.threadId}`);
      if (i === 0) { dropThread(d, cur); return; }
      const gone = cur.comments[i]!;
      d.threads[cur.id] = { ...cur, comments: cur.comments.filter((c) => c.id !== gone.id) };
      d.entries.push({ kind: "comment", threadId: cur.id, id: gone.id, before: gone, after: null });
      return;
    }
    case "removeThread": dropThread(d, existingThread(d, op.threadId)); return;
    case "renameScreen": {
      if (op.expectedRevision !== undefined && op.expectedRevision !== d.revision - 1) fail("conflict", "the Screen changed since you read it");
      const title = op.title.trim();
      checkTitle(title);
      if (title !== d.title) { d.entries.push({ kind: "title", before: d.title, after: title }); d.title = title; }
      return;
    }
    default:
      fail("invalid", `unknown operation`);
  }
}

function restore(d: Draft, e: InverseEntry, ctx: Context): void {
  if (e.kind === "pieces") {
    const cur = d.items[e.itemId] ?? fail("conflict", `item ${e.itemId} was removed since this edit`);
    if (cur.kind !== "html-snapshot") return fail("conflict", `item ${e.itemId} is not an object`);
    const files = filesOf(d, cur, ctx);
    let redo: PieceStep[];
    try { redo = restoreSteps(files, e.steps); }
    catch (err) { if (err instanceof PieceError) fail("conflict", err.message); throw err; }
    writeObject(d, cur, files, ctx);
    d.entries.push({ kind: "pieces", itemId: e.itemId, steps: redo });
    return;
  }
  if (e.kind === "title") {
    if (d.title !== e.after) fail("conflict", "the Screen title changed since this edit");
    d.title = e.before;
    d.entries.push({ kind: "title", before: e.after, after: e.before });
    return;
  }
  if (e.kind === "thread") {
    const cur = d.threads[e.id] ?? null;
    if (e.after === null) { if (cur) fail("conflict", `thread ${e.id} exists again`); }
    else {
      if (!cur) fail("conflict", `thread ${e.id} was removed since this edit`);
      for (const [k, v] of Object.entries(e.after)) if (!same((cur as unknown as Record<string, unknown>)[k], v)) fail("conflict", `thread ${e.id} changed since this edit`);
      // Undoing a create: its own comment was taken out just before this, so any comment left is someone's reply.
      if (e.before === null && cur!.comments.length > 0) fail("conflict", `thread ${e.id} has replies since this edit`);
    }
    if (e.before === null) delete d.threads[e.id];
    else d.threads[e.id] = cur ? { ...cur, ...e.before } : { ...(e.before as ThreadHead), comments: [] };
    d.entries.push({ kind: "thread", id: e.id, before: e.after, after: e.before });
    return;
  }
  if (e.kind === "comment") {
    const t = d.threads[e.threadId] ?? fail("conflict", `thread ${e.threadId} was removed since this edit`);
    const i = t.comments.findIndex((c) => c.id === e.id);
    if (e.after === null) { if (i >= 0) fail("conflict", `comment ${e.id} exists again`); }
    else if (i < 0 || !same(t.comments[i], e.after)) fail("conflict", `comment ${e.id} changed since this edit`);
    let comments = t.comments.filter((c) => c.id !== e.id);
    if (e.before) {
      const b = e.before;
      const at = comments.findIndex((c) => c.createdAt > b.createdAt);
      comments = at < 0 ? [...comments, b] : [...comments.slice(0, at), b, ...comments.slice(at)];
    }
    d.threads[t.id] = { ...t, comments };
    d.entries.push({ kind: "comment", threadId: e.threadId, id: e.id, before: e.after, after: e.before });
    return;
  }
  if (e.kind === "stroke") {
    const cur = d.strokes[e.id] ?? null;
    if (!same(cur, e.after)) fail("conflict", `stroke ${e.id} changed since this edit`);
    if (e.before === null) delete d.strokes[e.id]; else d.strokes[e.id] = e.before;
    d.entries.push({ kind: "stroke", id: e.id, before: e.after, after: e.before });
    return;
  }
  const cur = d.items[e.id] ?? null;
  if (e.after === null) { if (cur) fail("conflict", `item ${e.id} exists again`); }
  else {
    if (!cur) fail("conflict", `item ${e.id} was removed since this edit`);
    for (const [k, v] of Object.entries(e.after)) if (k !== "revision" && !(d.layout && PLACED.has(k)) && !same((cur as unknown as Record<string, unknown>)[k], v)) fail("conflict", `item ${e.id} changed since this edit`);
  }
  if (e.before === null) delete d.items[e.id];
  else if (!cur) d.items[e.id] = { ...(e.before as CanvasItem), revision: d.revision };
  else d.items[e.id] = { ...cur, ...e.before, revision: d.revision } as CanvasItem;
  d.entries.push({ kind: "item", id: e.id, before: e.after, after: e.before });
}

function existing(d: Draft, id: ItemId): CanvasItem {
  return d.items[id] ?? fail("not-found", `item ${id} not found`);
}

function touchItem(d: Draft, cur: CanvasItem, fields: Partial<CanvasItem>): void {
  const before: Record<string, unknown> = {};
  for (const k of Object.keys(fields)) before[k] = (cur as unknown as Record<string, unknown>)[k];
  d.items[cur.id] = { ...cur, ...fields, revision: d.revision } as CanvasItem;
  d.entries.push({ kind: "item", id: cur.id, before: before as Partial<CanvasItem>, after: fields });
}

function existingThread(d: Draft, id: ThreadId): DraftThread {
  return d.threads[id] ?? fail("not-found", `thread ${id} not found`);
}

function touchThread(d: Draft, cur: DraftThread, fields: Partial<ThreadHead>): void {
  const before: Record<string, unknown> = {};
  for (const k of Object.keys(fields)) before[k] = (cur as unknown as Record<string, unknown>)[k];
  d.threads[cur.id] = { ...cur, ...fields };
  d.entries.push({ kind: "thread", id: cur.id, before: before as Partial<ThreadHead>, after: fields });
}

/** The only code that deletes a thread: removeThread, removing its first comment, and the removeItems cascade.
 *  Comment entries newest first, then the head, so a restore rebuilds the head and re-inserts the comments in order. */
function dropThread(d: Draft, t: DraftThread): void {
  delete d.threads[t.id];
  for (const c of [...t.comments].reverse()) d.entries.push({ kind: "comment", threadId: t.id, id: c.id, before: c, after: null });
  const { comments: _, ...head } = t;
  d.entries.push({ kind: "thread", id: t.id, before: head, after: null });
}

function newComment(d: Draft, c: NewComment, ctx: Context): Comment {
  for (const t of Object.values(d.threads)) if (t.comments.some((x) => x.id === c.id)) fail("conflict", `comment ${c.id} already exists`);
  const text = typeof c.text === "string" ? c.text.trim() : "";
  if (text.length === 0 || text.length > COMMENT_MAX) fail("invalid", `comments must be 1-${COMMENT_MAX} characters`);
  return { id: c.id, author: ctx.author, text, createdAt: ctx.now };
}

/** Finite x/y. An item anchor names an item here, and its point lies inside the item (0 to 1 on both axes). */
function checkPosition(d: Draft, p: ThreadPosition): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) fail("invalid", "comment position must be finite numbers");
  if (p.anchor?.kind === "world") noFree(d, "comments are pinned to a page", "pass itemId");
  if (p.anchor?.kind === "item") {
    if (!d.items[p.anchor.itemId]) fail("not-found", `anchor item ${p.anchor.itemId} not found`);
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) fail("invalid", "an item comment's x and y are fractions of the item, from 0 to 1");
  } else if (p.anchor?.kind !== "world") fail("invalid", "anchor must be world or item");
  if (p.area !== undefined) {
    const { w, h } = p.area ?? {};
    if (typeof w !== "number" || typeof h !== "number" || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) fail("invalid", "a comment area's w and h must be positive numbers");
    // An item area may outgrow its item: a region keeps its world size when its pin moves onto a smaller item.
    if (p.anchor.kind === "item" && (w > AREA_ITEM_MAX || h > AREA_ITEM_MAX)) fail("invalid", `an item comment's area is a multiple of the item's size, at most ${AREA_ITEM_MAX}`);
  }
}

const AREA_ITEM_MAX = 1000;

function checkRevision(actual: Revision, expected: Revision | undefined, id: string): void {
  if (expected !== undefined && expected !== actual) fail("conflict", `${id} is at revision ${actual}, expected ${expected}`);
}
function checkTitle(t: string): void {
  if (typeof t !== "string" || t.trim().length === 0 || t.length > TITLE_MAX) fail("invalid", `titles must be 1-${TITLE_MAX} characters`);
}
/** Where a new item lands when it names no position: 80 units right of everything, top-aligned, or the origin on an empty
 *  Screen. reserved holds rects promised to objects on their way (agent placeholders), so they count as occupied.
 *  An add without x/y and a placeholder use this one rule. */
export function nextSlot(doc: { readonly layout?: PagedLayout | null; readonly items: Readonly<Record<string, { readonly x: number; readonly y: number; readonly width: number; readonly height: number }>> }, reserved: readonly Rect[]): Point {
  // On a Presentation or Document the next slot is the next page, below the pages and the slots already reserved.
  if (doc.layout) { const r = pageRect(doc.layout, Object.keys(doc.items).length + reserved.length); return { x: r.x, y: r.y }; }
  const rects = [...Object.values(doc.items).map((o) => ({ x: o.x, y: o.y, w: o.width, h: o.height })), ...reserved];
  if (!rects.length) return { x: 0, y: 0 };
  return { x: Math.round(Math.max(...rects.map((r) => r.x + r.w)) + 80), y: Math.round(Math.min(...rects.map((r) => r.y))) };
}

function checkGeometry(x: number, y: number, w: number, h: number): void {
  if (![x, y, w, h].every(Number.isFinite)) fail("invalid", "geometry must be finite numbers");
  if (w < ITEM_SIZE_MIN || h < ITEM_SIZE_MIN || w > ITEM_SIZE_MAX || h > ITEM_SIZE_MAX) fail("invalid", "item size out of range");
}
/** Canonical logical bundle path. No host filesystem or I/O is involved. */
export function normalizeBundlePath(path: string): string | null {
  if (!path || path.startsWith("/") || path.includes("\\") || /^[a-z]:/i.test(path) || path.split("/").includes("..")) return null;
  const normalized = path.split("/").filter((p) => p && p !== ".").join("/");
  return normalized && !/^[a-z]:/i.test(normalized) ? normalized : null;
}

function checkManifest(entry: string, m: AssetManifest, stored = false): void {
  if (!m[entry]) fail("invalid", `entry ${entry} is not in the asset manifest`);
  // Older saved/exported bundles accepted backslashes and drive-like names as inert hash keys.
  // Preserve those bytes on read/import; fresh operations still enforce the current path contract.
  for (const path of Object.keys(m)) if (stored ? path.startsWith("/") || path.split("/").includes("..") : normalizeBundlePath(path) === null)
    fail("invalid", "bundle paths must stay inside the bundle");
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Objects ──

const needSources = (ctx: Context): { sources: ReadonlyMap<string, string>; digest: (t: string) => string } =>
  ctx.sources && ctx.digest ? { sources: ctx.sources, digest: ctx.digest } : fail("invalid", "this operation needs the object's source, which only the service supplies");

/** The text files of an object, current within this transition. */
function filesOf(d: Draft, it: HtmlSnapshotItem, ctx: Context): Files {
  let texts = d.texts.get(it.id);
  if (!texts) {
    const { sources } = needSources(ctx);
    texts = new Map();
    for (const [path, a] of Object.entries(it.assetManifest)) if (isTextMedia(a.mediaType) || path === it.entry) {
      // Files written earlier in this transition (a stamp in the same batch) are read from it.
      const t = d.produced.get(a.hash) ?? sources.get(a.hash);
      if (t === undefined) fail("invalid", `the source of ${path} was not supplied`);
      texts.set(path, t!);
    }
    d.texts.set(it.id, texts);
  }
  return { entry: it.entry, texts: new Map(texts) };
}

const pidFor = (ctx: Context, seed: string, n: number) => `p${needSources(ctx).digest(`${seed}:${n}`).slice(0, 5)}`;

/** The same identity contentVersionOf computes: the first 12 bytes of SHA-256 over the entry and the sorted manifest. */
export function objectVersion(entry: string, manifest: AssetManifest, digest: (t: string) => string): string {
  return digest(JSON.stringify([entry, Object.keys(manifest).sort().map((p) => [p, manifest[p]!.hash, manifest[p]!.mediaType])])).slice(0, 24);
}

/** Writes changed files of an object into the item, without an item inverse entry (the pieces entry is the inverse). */
function writeObject(d: Draft, cur: HtmlSnapshotItem, files: Files, ctx: Context): HtmlSnapshotItem {
  const { digest } = needSources(ctx);
  const manifest: Record<string, { hash: string; mediaType: string }> = { ...cur.assetManifest };
  for (const [path, text] of files.texts) {
    const hash = digest(text);
    if (hash !== manifest[path]!.hash) { manifest[path] = { ...manifest[path]!, hash }; d.produced.set(hash, text); }
  }
  const contentVersion = objectVersion(cur.entry, manifest, digest);
  const live = d.items[cur.id] as HtmlSnapshotItem;
  const next: HtmlSnapshotItem = { ...live, assetManifest: manifest, contentVersion, posterHash: ctx.posters.get(cur.id) ?? null, revision: d.revision };
  d.items[cur.id] = next;
  d.texts.set(cur.id, new Map(files.texts));
  const entryText = files.texts.get(cur.entry)!;
  d.contents.set(cur.id, { itemId: cur.id, contentVersion, entry: cur.entry, manifest, width: next.width, height: next.height, inert: checkClassOf(entryText, manifest) === "inert" });
  return next;
}

/** Stamps piece ids into an object's entry when the service supplied its source. Without a source the item is unchanged.
 *  Only an object that cannot run code is stamped here: its page was test-loaded without the ids, and a script could react
 *  to them. An object with scripts is stamped by its first piece edit, whose result is test-loaded before it commits. */
function stamped(d: Draft, it: HtmlSnapshotItem, ctx: Context): HtmlSnapshotItem {
  if (!ctx.sources || !ctx.digest) return it;
  const a = it.assetManifest[it.entry];
  const text = a && /html/i.test(a.mediaType) ? ctx.sources.get(a.hash) : undefined;
  if (text === undefined || checkClassOf(text, it.assetManifest) !== "inert") return it;
  const s = stamp(text, (n) => pidFor(ctx, `${ctx.seed ?? ctx.now}:stamp`, n));
  const tree = pieceTree(s.source);
  const manifest = s.stamped.length || s.renumbered.length ? { ...it.assetManifest, [it.entry]: { ...a!, hash: ctx.digest(s.source) } } : it.assetManifest;
  if (manifest !== it.assetManifest) d.produced.set(manifest[it.entry]!.hash, s.source);
  const contentVersion = manifest === it.assetManifest ? it.contentVersion : objectVersion(it.entry, manifest, ctx.digest);
  d.deltas.push({ itemId: it.id, contentVersion, resolved: [], changed: rowsOf(tree, null), removed: [], renumbered: s.renumbered, inert: true });
  // The poster was rendered from the unstamped page: when stamping changed it, the service renders the stamped one on demand.
  return { ...it, assetManifest: manifest, contentVersion, posterHash: manifest === it.assetManifest ? it.posterHash : null };
}

/** A pure stamp has no steps; undoing it is a no-op, which a pieces entry with no steps expresses. */
const stampStep = (_d: Draft, _cur: HtmlSnapshotItem, _f: Files, steps: readonly PieceStep[]) => steps;

/** Outline rows of `pids` (every piece when null), in tree order. */
function rowsOf(tree: PieceNode, pids: ReadonlySet<string> | null): string {
  const out: string[] = [];
  const walk = (n: PieceNode, depth: number) => { if (n.pid !== "body" && (!pids || pids.has(n.pid))) out.push(`${"  ".repeat(pids ? 0 : depth - 1)}${row(n)}`); for (const c of n.children) walk(c, depth + 1); };
  walk(tree, 0);
  return out.join("\n");
}

/** Content hashes whose text an operation (or an inverse) needs in Context.sources. Pure. */
export function sourcesNeeded(doc: ScreenDoc, op: Operation | GuardedInverse): string[] {
  const out = new Set<string>();
  const readFilesOf = (id: ItemId) => { const it = doc.items[id]; if (it?.kind === "html-snapshot") for (const [p, a] of Object.entries(it.assetManifest)) if (isTextMedia(a.mediaType) || p === it.entry) out.add(a.hash); };
  const entryOf = (entry: string, m: AssetManifest | undefined) => { const a = m?.[entry]; if (a && /html/i.test(a.mediaType)) out.add(a.hash); };
  // An object added or replaced earlier in the same batch is edited with its new files.
  const fresh = new Map<ItemId, { entry: string; manifest: AssetManifest }>();
  const walk = (o: Operation): void => {
    if (!o || typeof o !== "object") return;
    if (o.type === "batch") { for (const x of o.ops ?? []) walk(x); return; }
    if (o.type === "editObject") {
      const f = fresh.get(o.itemId);
      if (!f) readFilesOf(o.itemId);
      else for (const [p, a] of Object.entries(f.manifest)) if (isTextMedia(a.mediaType) || p === f.entry) out.add(a.hash);
    } else if (o.type === "addItem" && o.item?.kind === "html-snapshot") { entryOf(o.item.entry, o.item.assetManifest); fresh.set(o.item.id, { entry: o.item.entry, manifest: o.item.assetManifest }); }
    else if (o.type === "updateSnapshot") { entryOf(o.entry, o.assetManifest); fresh.set(o.itemId, { entry: o.entry, manifest: o.assetManifest }); }
  };
  if ("entries" in op) { for (const e of op.entries) if (e.kind === "pieces") readFilesOf(e.itemId); }
  else walk(op);
  return [...out];
}

/** Every content hash `op` introduces: a reference image's asset and every file of a snapshot manifest, through batches.
 *  The service refuses an op whose content the store lacks. Pure. */
export function contentHashes(op: Operation): string[] {
  const out = new Set<string>();
  const walk = (o: Operation): void => {
    if (o.type === "batch") { for (const inner of o.ops ?? []) walk(inner); return; }
    if (o.type === "addItem") {
      if (o.item.kind === "reference-image") out.add(o.item.assetHash);
      else for (const a of Object.values(o.item.assetManifest ?? {})) out.add(a.hash);
    } else if (o.type === "updateSnapshot") for (const a of Object.values(o.assetManifest ?? {})) out.add(a.hash);
  };
  walk(op);
  return [...out];
}

const CONTENT_HASH = /^[0-9a-f]{64}$/;
const SCREEN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The full invariant check for a document that did not come from applyOperation (an import). Uses the same checkers as
 *  every operation, so the two paths cannot drift. Returns the upgraded document. Pure. */
export function checkScreen(raw: unknown): { readonly ok: true; readonly doc: ScreenDoc } | { readonly ok: false; readonly error: OperationError } {
  try {
    if (!raw || typeof raw !== "object") fail("invalid", "the Screen document is not an object");
    const doc = readDoc(raw);
    if (typeof doc.id !== "string" || !SCREEN_ID.test(doc.id)) fail("invalid", "bad Screen id");
    if (doc.schemaVersion !== 1) fail("invalid", `unknown Screen schema version ${String(doc.schemaVersion)}`);
    if ("layout" in doc && !isPagedLayout(doc.layout)) fail("invalid", `unknown Screen layout ${String(doc.layout)}`);
    checkTitle(doc.title);
    if (!Number.isInteger(doc.revision) || doc.revision < 0) fail("invalid", "bad revision");
    if (!Number.isFinite(doc.createdAt) || !Number.isFinite(doc.updatedAt)) fail("invalid", "bad timestamps");
    const record = (r: unknown, what: string) => (r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : fail("invalid", `${what} must be an object`));
    const items = record(doc.items, "items"), strokes = record(doc.strokes, "strokes"), threads = record(doc.threads, "threads");
    if (Object.keys(items).length > ITEMS_MAX) fail("limit", `a Screen holds at most ${ITEMS_MAX} items`);
    if (Object.keys(strokes).length > STROKES_MAX) fail("limit", `a Screen holds at most ${STROKES_MAX} strokes`);
    if (Object.keys(threads).length > THREADS_MAX) fail("limit", `a Screen holds at most ${THREADS_MAX} threads`);
    const author = (a: Author | undefined, what: string) => {
      if (!a || (a.kind !== "person" && !(a.kind === "agent" && typeof a.name === "string"))) fail("invalid", `${what} has a bad author`);
    };
    for (const [key, it] of Object.entries(items) as [string, CanvasItem][]) {
      if (!it || it.id !== key || typeof it.id !== "string" || it.id.length > 64) fail("invalid", `item ${key} has a bad id`);
      checkGeometry(it.x, it.y, it.width, it.height);
      checkTitle(it.title);
      if (!Number.isFinite(it.z) || !Number.isInteger(it.revision) || it.revision < 0 || it.revision > doc.revision) fail("invalid", `item ${key} has a bad z or revision`);
      if (it.kind === "reference-image") {
        if (!CONTENT_HASH.test(it.assetHash) || typeof it.mediaType !== "string") fail("invalid", `item ${key} has a bad image`);
      } else if (it.kind === "html-snapshot") {
        if (typeof it.entry !== "string" || typeof it.contentVersion !== "string") fail("invalid", `item ${key} has a bad bundle`);
        checkManifest(it.entry, record(it.assetManifest, `item ${key} manifest`) as AssetManifest, true);
        for (const a of Object.values(it.assetManifest)) if (!CONTENT_HASH.test(a?.hash) || typeof a.mediaType !== "string") fail("invalid", `item ${key} has a bad manifest entry`);
        if (it.posterHash !== null && !CONTENT_HASH.test(it.posterHash)) fail("invalid", `item ${key} has a bad poster`);
        if (!Array.isArray(it.sourceReferenceIds)) fail("invalid", `item ${key} has bad source references`);
        // A link may dangle: documents written before deletes cleared links keep them, and import must not refuse its own export.
        for (const ref of it.sourceReferenceIds) {
          if (typeof ref !== "string") fail("invalid", `item ${key} has a bad source reference`);
          const src = items[ref] as CanvasItem | undefined;
          if (src && src.kind !== "reference-image") fail("invalid", `source reference ${ref} is not a reference image`);
        }
      } else fail("invalid", "unknown item kind");
    }
    for (const [key, s] of Object.entries(strokes) as [string, Stroke][]) {
      if (!s || s.id !== key || !CLIENT_ID.test(s.id)) fail("invalid", `stroke ${key} has a bad id`);
      if (!HEX_COLOR.test(s.color)) fail("invalid", "color must be #rrggbb");
      if (!(Number.isFinite(s.size) && s.size > 0 && s.size <= STROKE_SIZE_MAX)) fail("invalid", "size out of range");
      if (!Array.isArray(s.points) || s.points.length < 1 || s.points.length > STROKE_MAX_POINTS) fail("invalid", `1-${STROKE_MAX_POINTS} points required`);
      for (const p of s.points) if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) fail("invalid", "points must be finite [x, y, pressure]");
      if (s.anchor?.kind === "item") { if (!items[s.anchor.itemId]) fail("invalid", `stroke ${key} is anchored to a missing item`); }
      else if (s.anchor?.kind !== "world") fail("invalid", `stroke ${key} has a bad anchor`);
      else if (doc.layout) fail("invalid", `stroke ${key} is not on a page`);
      author(s.author, `stroke ${key}`);
      if (!Number.isFinite(s.createdAt)) fail("invalid", `stroke ${key} has a bad time`);
    }
    // Pages sit where relayout puts them. Import refuses a document that disagrees rather than repairing it, so relayout
    // stays the only writer of a page's place.
    if (doc.layout) pageOrder(Object.values(items) as CanvasItem[]).forEach((it, i) => {
      const r = pageRect(doc.layout!, i);
      if (it.x !== r.x || it.y !== r.y || it.width !== r.width || it.height !== r.height) fail("invalid", `page ${it.id} is not where its order places it`);
    });
    const commentIds = new Set<string>();
    const draft = { layout: doc.layout ?? null, items } as unknown as Draft;
    for (const [key, t] of Object.entries(threads) as [string, Thread][]) {
      if (!t || t.id !== key || !CLIENT_ID.test(t.id)) fail("invalid", `thread ${key} has a bad id`);
      checkPosition(draft, t);
      if (typeof t.resolved !== "boolean" || !Number.isFinite(t.createdAt)) fail("invalid", `thread ${key} has a bad head`);
      if (!Array.isArray(t.comments) || t.comments.length === 0 || t.comments.length > COMMENTS_PER_THREAD_MAX) fail("invalid", `thread ${key} has a bad comment list`);
      let last = -Infinity;
      for (const c of t.comments) {
        if (!c || !CLIENT_ID.test(c.id) || commentIds.has(c.id)) fail("invalid", `thread ${key} has a bad or repeated comment id`);
        commentIds.add(c.id);
        if (typeof c.text !== "string" || c.text.trim() !== c.text || c.text.length === 0 || c.text.length > COMMENT_MAX) fail("invalid", `comments must be 1-${COMMENT_MAX} characters`);
        author(c.author, `comment ${c.id}`);
        if (!Number.isFinite(c.createdAt) || c.createdAt <= last) fail("invalid", `thread ${key} comments are out of order`);
        last = c.createdAt;
      }
    }
    return { ok: true, doc };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: { code: e.code, message: e.message } };
    throw e;
  }
}
