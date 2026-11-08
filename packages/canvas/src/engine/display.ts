// What the canvas shows, derived where it is read. Never stored.
// base = committed ⊕ newest pending op per item ⊕ remote transients. render = base ⊕ the active gesture preview.

import { PAGE_SIZE, pageRect, reanchorArea, reorderedZ, type Layout, type CanvasItem, type Comment, type CommentId, type ItemId, type Operation, type Placement, type Point, type Rect, type ScreenDoc, type StrokeAnchor, type StrokeId, type StrokePoint, type Thread, type ThreadAnchor, type ThreadArea, type ThreadId } from "@screens/core";
import { sortItems } from "./geometry.ts";

export type Sync = "committed" | "pending" | "failed";
export interface DisplayItem {
  readonly id: ItemId; readonly kind: CanvasItem["kind"]; readonly title: string; readonly z: number;
  readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly rect: Rect;
  readonly contentVersion: string | null; readonly posterHash: string | null; readonly assetHash: string | null;
  readonly sync: Sync; readonly removing: boolean;
}
export interface DisplayStroke {
  readonly id: StrokeId; readonly anchor: StrokeAnchor; readonly points: readonly StrokePoint[];
  readonly color: string; readonly size: number; readonly createdAt: number; readonly sync: Sync; readonly removing: boolean;
}
export interface DisplayComment extends Comment { readonly sync: Sync; readonly removing: boolean }
/** A thread as shown. A failed new thread or reply stays, marked failed, until Retry or Dismiss, so typed text never vanishes. */
export interface DisplayThread {
  readonly id: ThreadId; readonly anchor: ThreadAnchor; readonly x: number; readonly y: number; readonly area?: ThreadArea;
  readonly resolved: boolean; readonly createdAt: number; readonly comments: readonly DisplayComment[];
  /** Head sync: a create, move, resolve or delete of this thread in flight or failed. */
  readonly sync: Sync; readonly removing: boolean;
}
export interface BaseDoc {
  readonly title: string; readonly titleSync: Sync;
  /** canvas, or a Presentation (slides) or Document (a4) whose items are pages placed by order. */
  readonly layout: Layout;
  /** sortItems order. */
  readonly items: readonly DisplayItem[];
  readonly byId: ReadonlyMap<ItemId, DisplayItem>;
  readonly strokes: readonly DisplayStroke[];
  /** Oldest first: creation order. */
  readonly threads: readonly DisplayThread[];
  readonly threadById: ReadonlyMap<ThreadId, DisplayThread>;
  readonly revision: number;
}

/** Structural view of the client's ScreenState, so the engine needs no client or DOM types. */
export interface BaseInput {
  readonly committed: ScreenDoc | null;
  readonly pending: ReadonlyMap<string, { readonly op: Operation | { readonly type: "undo" | "redo" }; readonly seq: number; readonly outcome: { readonly status: string } }>;
  readonly remote: ReadonlyMap<string, Readonly<Record<ItemId, Placement>>>;
}

const EMPTY: BaseDoc = { title: "", titleSync: "committed", layout: "canvas", items: [], byId: new Map(), strokes: [], threads: [], threadById: new Map(), revision: -1 };
/** Not yet committed, so it sorts after everything committed. */
const UNSAVED = Number.MAX_SAFE_INTEGER;
let lastInput: BaseInput | null = null, lastBase: BaseDoc = EMPTY;
const itemCache = new Map<ItemId, DisplayItem>();
const sameItem = (a: DisplayItem, b: DisplayItem): boolean =>
  a.title === b.title && a.z === b.z && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.kind === b.kind &&
  a.contentVersion === b.contentVersion && a.posterHash === b.posterHash && a.assetHash === b.assetHash && a.sync === b.sync && a.removing === b.removing;
/** Core replaces only the threads an operation touches, so a committed Thread object maps to one display object. */
const committedThreads = new WeakMap<Thread, DisplayThread>();
const committedThread = (t: Thread): DisplayThread => {
  let d = committedThreads.get(t);
  if (!d) { d = { ...t, comments: t.comments.map((c) => ({ ...c, sync: "committed", removing: false })), sync: "committed", removing: false }; committedThreads.set(t, d); }
  return d;
};
const threadCache: { from: ScreenDoc["threads"] | null; touched: boolean } = { from: null, touched: false };

export function baseDocOf(s: BaseInput): BaseDoc {
  if (s === lastInput) return lastBase;
  const doc = s.committed;
  if (!doc) return EMPTY;
  type Over = { x?: number; y?: number; z?: number; width?: number; height?: number; title?: string; removing?: boolean; sync?: Sync };
  const over = new Map<ItemId, Over>();
  const get = (id: ItemId) => { let o = over.get(id); if (!o) { o = {}; over.set(id, o); } return o; };
  const strokeOver = new Map<StrokeId, { sync: Sync; removing: boolean }>();
  const added: DisplayStroke[] = [];
  /** Reference images an op adds that the revision does not have yet: shown pending (or failed) at their placed rect. */
  const addedItems: DisplayItem[] = [];
  let title = doc.title, titleSync: Sync = "committed";
  // Threads: a pending op copies the committed thread it touches into an editable row, then folds over it in ledger order.
  // Untouched threads keep their cached display object.
  type Row = { -readonly [K in keyof DisplayThread]: DisplayThread[K] } & { comments: DisplayComment[] };
  const rows = new Map<ThreadId, Row>();
  const markComment = (t: Row, id: CommentId, mark: Sync, removing: boolean) => { t.comments = t.comments.map((c) => (c.id === id ? { ...c, sync: mark, removing } : c)); };

  const visit = (op: Operation, failed: boolean) => {
    const mark: Sync = failed ? "failed" : "pending";
    const row = (id: ThreadId): Row | undefined => {
      let r = rows.get(id);
      if (!r && doc.threads[id]) { const c = committedThread(doc.threads[id]); r = { ...c, comments: [...c.comments] }; rows.set(id, r); }
      return r;
    };
    switch (op.type) {
      case "addThread": {
        const t = op.thread;
        if (doc.threads[t.id]) return; // committed: the revision has it
        rows.set(t.id, { id: t.id, anchor: t.anchor, x: t.x, y: t.y, ...(t.area ? { area: t.area } : {}), resolved: false, createdAt: UNSAVED, sync: mark, removing: false,
          comments: [{ id: t.comment.id, author: { kind: "person" }, text: t.comment.text.trim(), createdAt: UNSAVED, sync: mark, removing: false }] });
        return;
      }
      case "moveThread": {
        const t = row(op.threadId);
        if (t) {
          t.sync = mark;
          if (!failed) {
            // Same rule as core: the circled area keeps its world size on the new anchor.
            if (t.area) t.area = reanchorArea(t.area, t.anchor, op.anchor, (id) => { const it = doc.items[id]; return it && { w: it.width, h: it.height }; });
            t.anchor = op.anchor; t.x = op.x; t.y = op.y;
          }
        }
        return;
      }
      case "resolveThread": { const t = row(op.threadId); if (t) { t.sync = mark; if (!failed) t.resolved = op.resolved; } return; }
      case "addComment": {
        const t = row(op.threadId);
        if (t && !t.comments.some((c) => c.id === op.comment.id)) t.comments = [...t.comments, { id: op.comment.id, author: { kind: "person" }, text: op.comment.text.trim(), createdAt: UNSAVED, sync: mark, removing: false }];
        return;
      }
      case "editComment": {
        const t = row(op.threadId);
        if (t) t.comments = t.comments.map((c) => c.id === op.commentId ? { ...c, text: op.text.trim(), sync: mark } : c);
        return;
      }
      case "removeComment": {
        const t = row(op.threadId); if (!t) return;
        if (t.comments[0]?.id === op.commentId) { t.sync = mark; t.removing = !failed; } else markComment(t, op.commentId, mark, !failed);
        return;
      }
      case "removeThread": { const t = row(op.threadId); if (t) { t.sync = mark; t.removing = !failed; } return; }
      case "batch": for (const o of op.ops) visit(o, failed); return;
      case "moveItems": for (const m of op.moves) { const o = get(m.itemId); o.sync = mark; if (!failed) { o.x = m.x; o.y = m.y; } } return;
      case "resizeItems": for (const m of op.sizes) { const o = get(m.itemId); o.sync = mark; if (!failed) { o.width = m.width; o.height = m.height; } } return;
      case "reorderItems": {
        // Same rule as core, over what the canvas shows now, so a pending reorder restacks at once. Pages a pending op adds
        // count too, so a drop inserted between pages shows in its place.
        const shown = [...Object.values(doc.items), ...addedItems].map((it) => ({ id: it.id, z: over.get(it.id)?.z ?? it.z }));
        const next = failed ? new Map<ItemId, number>() : reorderedZ(shown, op.itemIds, op.to);
        // Every z the rule changes, not only the moved items': a reorder can renumber the items between.
        for (const id of op.itemIds) get(id).sync = mark;
        for (const [id, z] of next) get(id).z = z;
        return;
      }
      case "retitleItem": { const o = get(op.itemId); o.sync = mark; if (!failed) o.title = op.title.trim(); return; }
      case "removeItems": for (const id of op.itemIds) { const o = get(id); o.sync = mark; if (!failed) o.removing = true; } return;
      case "updateSnapshot": case "editObject": get(op.itemId).sync = mark; return;
      case "addStroke": if (!failed && !doc.strokes[op.stroke.id]) added.push({ ...op.stroke, createdAt: Number.MAX_SAFE_INTEGER, sync: "pending", removing: false }); return;
      case "removeStroke": strokeOver.set(op.strokeId, { sync: mark, removing: !failed }); return;
      case "renameScreen": titleSync = mark; if (!failed) title = op.title.trim(); return;
      case "addItem": {
        const it = op.item;
        // A page has no x and y: it is placed by order below, at the page size.
        const page = doc.layout ? PAGE_SIZE[doc.layout] : null;
        if (it.kind !== "reference-image" || doc.items[it.id] || (!page && (it.x === undefined || it.y === undefined))) return;
        const x = it.x ?? 0, y = it.y ?? 0, width = page?.width ?? it.width, height = page?.height ?? it.height;
        addedItems.push({ id: it.id, kind: it.kind, title: it.title, z: UNSAVED + addedItems.length, x, y, width, height,
          rect: { x, y, w: width, h: height }, contentVersion: null, posterHash: null, assetHash: it.assetHash, sync: mark, removing: false });
        return;
      }
    }
  };
  for (const e of [...s.pending.values()].sort((a, b) => a.seq - b.seq)) {
    if (e.op.type === "undo" || e.op.type === "redo") continue;
    visit(e.op as Operation, e.outcome.status === "failed");
  }
  // A remote preview shows only where this client has nothing of its own in flight for the item.
  for (const rects of s.remote.values()) for (const [id, p] of Object.entries(rects)) {
    const o = get(id); if (o.x === undefined && o.width === undefined && o.sync === undefined) { o.x = p.x; o.y = p.y; if (p.w !== undefined) o.width = p.w; if (p.h !== undefined) o.height = p.h; }
  }

  const items: DisplayItem[] = [];
  for (const it of Object.values(doc.items)) {
    const o = over.get(it.id) ?? {};
    const x = o.x ?? it.x, y = o.y ?? it.y, width = o.width ?? it.width, height = o.height ?? it.height;
    const d: DisplayItem = {
      id: it.id, kind: it.kind, title: o.title ?? it.title, z: o.z ?? it.z, x, y, width, height, rect: { x, y, w: width, h: height },
      contentVersion: it.kind === "html-snapshot" ? it.contentVersion : null, posterHash: it.kind === "html-snapshot" ? it.posterHash : null,
      assetHash: it.kind === "reference-image" ? it.assetHash : null, sync: o.sync ?? "committed", removing: o.removing ?? false,
    };
    // Reuse the previous object when nothing shown changed, so memoized frames skip the render.
    const hit = itemCache.get(it.id);
    if (hit && sameItem(hit, d)) items.push(hit); else { itemCache.set(it.id, d); items.push(d); }
  }
  const pendingAdds = addedItems.map((a) => { const z = over.get(a.id)?.z; return z === undefined ? a : { ...a, z }; });
  let sorted = sortItems(items.concat(pendingAdds));
  // Pages sit where core will place them: by index, at the page size. A pending add, reorder or undo moves pages at once.
  if (doc.layout) {
    const layout = doc.layout;
    sorted = sorted.map((it, i) => {
      const r = pageRect(layout, i);
      if (it.x === r.x && it.y === r.y && it.width === r.width && it.height === r.height) return it;
      const d = { ...it, x: r.x, y: r.y, width: r.width, height: r.height, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
      const hit = itemCache.get(it.id);
      if (hit && sameItem(hit, d)) return hit;
      if (doc.items[it.id]) itemCache.set(it.id, d);
      return d;
    });
  }
  const strokes: DisplayStroke[] = Object.values(doc.strokes).map((st) => {
    const so = strokeOver.get(st.id);
    return { id: st.id, anchor: st.anchor, points: st.points, color: st.color, size: st.size, createdAt: st.createdAt, sync: so?.sync ?? "committed", removing: so?.removing ?? false };
  }).concat(added).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  // With no pending thread op and the same committed threads, the previous list stands as is.
  const reuse = rows.size === 0 && threadCache.from === doc.threads && !threadCache.touched;
  const threads = reuse ? lastBase.threads : Object.values(doc.threads).map((t): DisplayThread => rows.get(t.id) ?? committedThread(t))
    .concat([...rows.values()].filter((r) => !doc.threads[r.id])).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  threadCache.from = doc.threads; threadCache.touched = rows.size > 0;
  lastInput = s;
  lastBase = { title, titleSync, layout: doc.layout ?? "canvas", items: sorted, byId: new Map(sorted.map((i) => [i.id, i])), strokes, threads,
    threadById: reuse ? lastBase.threadById : new Map(threads.map((t) => [t.id, t])), revision: doc.revision };
  return lastBase;
}

/** base ⊕ the active drag preview. Only previewed items get new objects. Render-only: never passed to step(). */
export function renderDocOf(base: BaseDoc, preview: ReadonlyMap<ItemId, Placement> | null): BaseDoc {
  if (!preview || preview.size === 0) return base;
  const items = base.items.map((i) => {
    const p = preview.get(i.id);
    if (!p) return i;
    const width = p.w ?? i.width, height = p.h ?? i.height;
    return { ...i, x: p.x, y: p.y, width, height, rect: { x: p.x, y: p.y, w: width, h: height } };
  });
  return { ...base, items, byId: new Map(items.map((i) => [i.id, i])) };
}

/** True until the service commits the thread or comment: a pending or failed create. */
export const isUnsaved = (r: { readonly createdAt: number }): boolean => r.createdAt === UNSAVED;
