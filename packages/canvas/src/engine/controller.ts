// The canvas engine: one pure reducer, the only writer of ViewState.
// step(view, input, baseDoc, env) → { state, effects }. No DOM, no timers, no transport.
// CanvasInput is JSON-serializable, so a recorded input stream replays exactly (replay()).

import { areaAt, pageRect, positionAt, reorderedZ, threadPoint, type ReorderTarget, type Placement, type CommentId, type ItemId, type Operation, type Point, type Rect, type StrokeAnchor, type StrokeId, type StrokePoint, type ThreadId, type ThreadPosition } from "@screens/core";
import { FOCUS_ANIM_MS, ZOOM_STEP_IN, ZOOM_STEP_OUT, WHEEL_ZOOM_K, clampZoom, fitAll, fitItem, focusEase, lerpCamera, pan, screenToWorld, viewportWorldRect, zoomAround, type Camera, type Size } from "./camera.ts";
import { boundsOf, intersects, normalizedRect, topItemAt } from "./geometry.ts";
import { SNAP_SCREEN_PX, snapLead, type Guide } from "./snap.ts";
import { groupBox, keepsAspect, resizeRect, scaleRect, type Handle, type SizeLimits } from "./resize.ts";
import { TOOLS, defaultInk, type PencilSize, type ToolId } from "./tools.ts";
import { round2 } from "./stroke.ts";
import { isUnsaved, type BaseDoc, type DisplayItem, type DisplayThread } from "./display.ts";
import { gridColumns, PRESENT_KEYS, SCROLL, fitExact, fitTop, gridRect, policyOf, scrollRect, shownDocOf, slotAmong, type PagesState, type PagesView } from "./pages.ts";

export const DRAG_THRESHOLD_PX = 3, PAN_MOVED_PX = 3, TRANSIENT_INTERVAL_MS = 33, PIN_DRAG_PX = 4;
export const STROKE_DRAW_PX = 4, STROKE_SPACING_PX = 0.75, STROKE_MAX_POINTS = 3000;
export const VIEW_COMMAND_TTL_MS = 30_000;

export type Selection = { readonly kind: "items"; readonly ids: readonly ItemId[] } | { readonly kind: "stroke"; readonly id: StrokeId };
export type FocusState =
  | { readonly mode: "none" }
  /** restore is saved once, on the first focus; switching focus keeps it. */
  | { readonly mode: "focused"; readonly itemId: ItemId; readonly restore: { readonly camera: Camera; readonly autoFit: boolean } }
  /** Frame input is off until the return animation ends. */
  | { readonly mode: "returning"; readonly itemId: ItemId };
export interface CameraAnimation { readonly from: Camera; readonly to: Camera; readonly startedAt: number; readonly then: "none" | "finish-return" }
export type ViewCommand =
  | { readonly id: string; readonly kind: "show"; readonly itemIds: readonly ItemId[]; readonly issuedAt: number }
  | { readonly id: string; readonly kind: "focus"; readonly itemId: ItemId; readonly issuedAt: number }
  | { readonly id: string; readonly kind: "exit-focus"; readonly issuedAt: number };

export interface PointerSample { readonly pointerId: number; readonly client: Point; readonly pressure: number; readonly pointerType: "mouse" | "pen" | "touch" }
export type HitTarget =
  | { readonly kind: "background" }
  | { readonly kind: "item"; readonly itemId: ItemId; readonly part: "surface" | "title" }
  | { readonly kind: "stroke"; readonly strokeId: StrokeId }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  /** A resize handle of the selection: one frame's, or the box around several. */
  | { readonly kind: "handle"; readonly handle: Handle };
/** A new thread being composed. Its id is final: the addThread and the opened card reuse it. The text lives in the composer's
 *  DOM. A draft ends on send, Escape, a tool change, a new placement or a reload. */
export interface CommentDraft extends ThreadPosition { readonly id: ThreadId }
export interface StrokeDraft { readonly id: StrokeId; readonly anchor: StrokeAnchor; readonly points: readonly StrokePoint[]; readonly color: string; readonly size: number }

export type Gesture =
  | { readonly kind: "pan"; readonly pointerId: number; readonly origin: Point; readonly last: Point; readonly moved: boolean; readonly onClick: { readonly kind: "clear" } | { readonly kind: "select"; readonly itemId: ItemId } | { readonly kind: "next-slide" } }
  | { readonly kind: "item-drag"; readonly pointerId: number; readonly gestureId: string; readonly origin: Point; readonly leadId: ItemId; readonly clickReduces: boolean;
      readonly initial: ReadonlyMap<ItemId, Point>; readonly leadRect: Rect; readonly targets: readonly Rect[]; readonly dragging: boolean;
      readonly preview: ReadonlyMap<ItemId, Placement> | null; readonly guides: readonly Guide[]; readonly lastBroadcastAt: number; readonly unsent: boolean;
      /** Grid view of a Presentation or Document: the drag reorders. slot is where the pages would go (reorderItems' index). */
      readonly reorder: boolean; readonly slot: number | null }
  /** starts: each selected item's rect at press; box: their bounds, which the handle resizes, scaling every item with it.
   *  preview holds every item's full rect once past DRAG_THRESHOLD_PX. */
  | { readonly kind: "item-resize"; readonly pointerId: number; readonly gestureId: string; readonly origin: Point; readonly starts: ReadonlyMap<ItemId, Rect>;
      readonly kinds: readonly string[]; readonly handle: Handle; readonly box: Rect; readonly limits: SizeLimits; readonly targets: readonly Rect[]; readonly preview: ReadonlyMap<ItemId, Placement> | null;
      readonly guides: readonly Guide[]; readonly lastBroadcastAt: number; readonly unsent: boolean }
  | { readonly kind: "marquee"; readonly pointerId: number; readonly originWorld: Point; readonly base: readonly ItemId[]; readonly restore: readonly ItemId[]; readonly rect: Rect | null }
  | { readonly kind: "stroke"; readonly pointerId: number; readonly origin: Point; readonly anchorOrigin: Point; readonly draft: StrokeDraft; readonly drawing: boolean; readonly frameRequested: boolean }
  /** start: the pin tip in world units at press. preview: start + pointer delta / zoom, once past PIN_DRAG_PX. */
  | { readonly kind: "pin-drag"; readonly pointerId: number; readonly threadId: ThreadId; readonly origin: Point; readonly start: Point; readonly movable: boolean; readonly preview: Point | null }
  /** Comment mode: a click places a pin; a drag past PIN_DRAG_PX circles a region. start and rect are world units. */
  | { readonly kind: "comment-area"; readonly pointerId: number; readonly origin: Point; readonly start: Point; readonly rect: Rect | null };

export type Editing = { readonly kind: "item-title"; readonly itemId: ItemId } | { readonly kind: "screen-name" } | null;

export interface CommentSession {
  readonly draft: CommentDraft | null;
  readonly activeThreadId: ThreadId | null;
  /** An unfinished new annotation temporarily set aside while another thread is inspected. */
  readonly parkedDraft: CommentDraft | null;
  readonly expanded: boolean;
  readonly panelOpen: boolean;
  readonly editingCommentId: CommentId | null;
  readonly composing: boolean;
}

export interface ViewState {
  readonly viewport: Size; readonly pointer: "fine" | "coarse"; readonly dpr: number; readonly theme: "light" | "dark";
  readonly camera: Camera;
  /** True at start; person-driven camera movement turns it off; Fit all turns it on. */
  readonly autoFit: boolean;
  readonly moving: boolean;
  readonly animation: CameraAnimation | null;
  readonly focus: FocusState;
  readonly tool: ToolId;
  readonly shiftPanning: boolean;
  readonly pencil: { readonly color: string; readonly size: PencilSize };
  readonly selection: Selection;
  readonly interacting: ItemId | null;
  readonly gesture: Gesture | null;
  readonly wheel: { readonly dx: number; readonly dy: number; readonly zoom: number; readonly anchor: Point; readonly scheduled: boolean };
  readonly editing: Editing;
  /** The open annotation and optional index are independent. Text lives in the view runtime. */
  readonly comment: CommentSession & { readonly showResolved: boolean; readonly restore: CommentSession | null };
  /** The command's deadline uses the animation clock, independently of its wire timestamp. */
  readonly deferredCommand: (ViewCommand & { readonly expiresAt: number }) | null;
  readonly invertScroll: boolean;
  readonly capabilities: { readonly comments: boolean };
  /** The participant whose work the camera follows (roster Follow). Any press, wheel, zoom or Escape releases it. */
  readonly following: string | null;
  /** A Presentation or Document: scroll, grid or present. Ignored on a canvas. */
  readonly pages: PagesState;
}

export type CanvasInput =
  | { readonly type: "pointer-down"; readonly p: PointerSample; readonly target: HitTarget; readonly button: number; readonly isPrimary: boolean; readonly shift: boolean; readonly mod: boolean }
  /** samples = getCoalescedEvents() when non-empty, else [the event]. */
  | { readonly type: "pointer-move"; readonly pointerId: number; readonly samples: readonly PointerSample[]; readonly mod: boolean; readonly shift: boolean }
  | { readonly type: "pointer-up"; readonly pointerId: number }
  | { readonly type: "pointer-cancel"; readonly pointerId: number }
  | { readonly type: "double-click"; readonly target: HitTarget }
  /** zoom: "cmd" for Cmd (Meta) held, "pinch" for a trackpad pinch or Ctrl held, which browsers report as ctrlKey. */
  | { readonly type: "wheel"; readonly dx: number; readonly dy: number; readonly zoom: WheelZoom; readonly client: Point }
  /** control: keyboard focus is on a button, link or pin, which keeps Space, Enter, Tab and the arrows for itself. */
  | { readonly type: "key-down"; readonly key: string; readonly code: string; readonly mod: boolean; readonly shift: boolean; readonly editable: boolean; readonly control: boolean }
  | { readonly type: "key-up"; readonly code: string }
  | { readonly type: "window-blur"; readonly activeFrameItem: ItemId | null }
  | { readonly type: "bridge"; readonly itemId: ItemId; readonly msg: { readonly kind: "pointer"; readonly x: number; readonly y: number } | { readonly kind: "zoom"; readonly x: number; readonly y: number; readonly dy: number; readonly pinch: boolean } | { readonly kind: "pan"; readonly dx: number; readonly dy: number } | { readonly kind: "escape" } }
  | { readonly type: "tick"; readonly now: number }
  | { readonly type: "camera-settled" }
  | { readonly type: "resize"; readonly viewport: Size }
  | { readonly type: "document-changed" }
  | { readonly type: "command"; readonly command: Command }
  | { readonly type: "title-commit"; readonly value: string }
  | { readonly type: "title-cancel" }
  /** The open composer's text: the draft's when a draft exists, else a reply to the open thread. Blank after trimming does nothing. */
  | { readonly type: "comment-submit"; readonly text: string; readonly expectedText?: string }
  | { readonly type: "comment-composing"; readonly on: boolean }
  /** Escape in a composer: clears the draft and the open thread. */
  | { readonly type: "comment-cancel" }
  | { readonly type: "view-command"; readonly cmd: ViewCommand; readonly now: number }
  | { readonly type: "theme"; readonly theme: "light" | "dark" }
  /** Image files the shell has read, hashed and measured. at: stage px of a drop; null for a paste (viewport centre). */
  | { readonly type: "drop-images"; readonly at: Point | null; readonly images: readonly DroppedImage[] }
  /** Where a participant is working now, in world units; the shell sends it when the roster changes. Only the followed one moves the camera. */
  | { readonly type: "follow-target"; readonly id: string; readonly rect: Rect | null };

export type WheelZoom = "none" | "cmd" | "pinch";
/** Wheel delta to zoom exponent. Scrolling up (deltaY < 0) with Cmd or Ctrl zooms in, and so does a trackpad pinch
 *  outward, which browsers report as a Ctrl wheel with deltaY < 0. Invert scroll flips it. */
export const wheelZoom = (dy: number, invert: boolean): number => -dy * WHEEL_ZOOM_K * (invert ? -1 : 1);

/** A file the shell has already read. No Blob reaches the engine: the runtime keeps the bytes under the hash. */
export interface DroppedImage { readonly hash: string; readonly mediaType: string; readonly width: number; readonly height: number; readonly title: string }
export const IMAGE_DROP_MAX_SIDE = 1600, IMAGE_DROP_GAP = 40;

/** Natural size with the longest side capped at IMAGE_DROP_MAX_SIDE and no upscaling; one row, IMAGE_DROP_GAP apart, top-aligned,
 *  centred on `centre`. Rounded to whole world units. */
export function placeImages(centre: Point, images: readonly DroppedImage[]): readonly Rect[] {
  const sizes = images.map((i) => {
    const k = Math.min(1, IMAGE_DROP_MAX_SIDE / Math.max(i.width, i.height, 1));
    return { w: Math.max(1, Math.round(i.width * k)), h: Math.max(1, Math.round(i.height * k)) };
  });
  const total = sizes.reduce((n, s) => n + s.w, 0) + IMAGE_DROP_GAP * Math.max(0, sizes.length - 1);
  const top = Math.round(centre.y - Math.max(...sizes.map((s) => s.h)) / 2);
  let x = Math.round(centre.x - total / 2);
  return sizes.map((s) => { const r = { x, y: top, w: s.w, h: s.h }; x += s.w + IMAGE_DROP_GAP; return r; });
}

export type Command =
  | { readonly kind: "zoom-in" } | { readonly kind: "zoom-out" } | { readonly kind: "zoom-100" } | { readonly kind: "fit-all" }
  | { readonly kind: "focus"; readonly itemId: ItemId } | { readonly kind: "exit-focus" }
  | { readonly kind: "select-tool"; readonly tool: ToolId } | { readonly kind: "delete" } | { readonly kind: "undo" } | { readonly kind: "redo" }
  | { readonly kind: "pencil-color"; readonly color: string } | { readonly kind: "pencil-size"; readonly size: PencilSize }
  | { readonly kind: "invert-scroll"; readonly on: boolean } | { readonly kind: "edit"; readonly editing: Editing }
  /** Panel row or card Close (null). */
  | { readonly kind: "open-thread"; readonly threadId: ThreadId | null }
  | { readonly kind: "resolve-thread"; readonly threadId: ThreadId; readonly resolved: boolean }
  | { readonly kind: "delete-comment"; readonly threadId: ThreadId; readonly commentId: CommentId }
  | { readonly kind: "comment-filter"; readonly showResolved: boolean }
  | { readonly kind: "comments-panel"; readonly open: boolean }
  | { readonly kind: "edit-comment"; readonly commentId: CommentId | null }
  /** The selection to the front or back (] and [), or one step forward or backward (Mod+] and Mod+[). */
  | { readonly kind: "reorder"; readonly to: ReorderTarget }
  /** Arrow keys: move the selection by dx, dy world units. With nothing selected they pan the view instead. */
  | { readonly kind: "nudge"; readonly dx: number; readonly dy: number }
  /** Mod+arrow keys: grow or shrink the selection's right and bottom edges by dw, dh world units. */
  | { readonly kind: "resize-by"; readonly dw: number; readonly dh: number }
  /** Tab and Shift+Tab: select the next or previous item in reading order, or focus it while focused. */
  | { readonly kind: "select-next"; readonly back: boolean }
  /** Shift+2: frame the selection. */
  | { readonly kind: "zoom-to-selection" }
  /** Toolbar Copy as image or Shift+Mod+C: the one selected item's picture to the clipboard. */
  | { readonly kind: "copy-image" }

  /** Roster Follow: keep a participant's work in view (null stops). rect: where it is now, framed at once. */
  | { readonly kind: "follow"; readonly id: string | null; readonly rect: Rect | null }
  /** Roster Locate or an off-screen marker: show a participant's work once. */
  | { readonly kind: "locate"; readonly rect: Rect }
  /** A Presentation or Document: the scroll view, the grid, or (slides only) Present. */
  | { readonly kind: "pages-view"; readonly view: PagesView };

export type Effect =
  | { readonly type: "capture"; readonly pointerId: number } | { readonly type: "release"; readonly pointerId: number }
  /** endsPreview: the gesture whose live preview this op replaces. The runtime clears that preview once the op settles. */
  | { readonly type: "submit"; readonly op: Operation; readonly endsPreview?: string }
  /** A live preview for other clients. null ends it; a committing gesture ends it through its submit's endsPreview. */
  | { readonly type: "transient"; readonly gestureId: string; readonly rects: ReadonlyMap<ItemId, Placement> | null }
  | { readonly type: "undo" } | { readonly type: "redo" }
  | { readonly type: "request-frame" } | { readonly type: "settle-timer" } | { readonly type: "blur-active" } | { readonly type: "publish-context" }
  | { readonly type: "answer-view-command"; readonly id: string; readonly outcome: "applied" | "deferred" | "dropped" }
  | { readonly type: "copy-image"; readonly itemId: ItemId };

export interface Env { readonly now: () => number; readonly reducedMotion: boolean; readonly newId: () => string }
export interface Step { readonly state: ViewState; readonly effects: readonly Effect[] }

export const ESCAPE_CHAIN = ["cancel-gesture", "clear-stroke-selection", "clear-comment", "clear-interacting", "exit-focus", "clear-selection", "tool-move"] as const;

export function initialViewState(o: { viewport: Size; pointer: "fine" | "coarse"; dpr: number; theme: "light" | "dark"; invertScroll?: boolean }): ViewState {
  return {
    viewport: o.viewport, pointer: o.pointer, dpr: o.dpr, theme: o.theme, camera: { x: 0, y: 0, z: 1 }, autoFit: true, moving: false, animation: null,
    focus: { mode: "none" }, tool: "move", shiftPanning: false, pencil: { color: defaultInk(o.theme), size: 6 },
    selection: { kind: "items", ids: [] }, interacting: null, gesture: null, wheel: { dx: 0, dy: 0, zoom: 0, anchor: { x: 0, y: 0 }, scheduled: false },
    editing: null, comment: { draft: null, activeThreadId: null, parkedDraft: null, showResolved: false, expanded: false, panelOpen: false, editingCommentId: null, composing: false, restore: null }, deferredCommand: null, invertScroll: o.invertScroll ?? false, capabilities: { comments: true }, following: null,
    pages: SCROLL,
  };
}

export const selectedIds = (s: ViewState): readonly ItemId[] => (s.selection.kind === "items" ? s.selection.ids : []);
/** The item Copy as image takes: the focused item, else the only selected one. It needs a picture: a design's poster or an image's asset. */
export function copyableItem(s: ViewState, doc: BaseDoc): DisplayItem | null {
  const id = s.focus.mode === "focused" ? s.focus.itemId : selectedIds(s).length === 1 ? selectedIds(s)[0]! : null;
  const it = id ? doc.byId.get(id) : undefined;
  return it && !it.removing && (it.kind === "reference-image" ? !!it.assetHash : !!it.contentVersion) ? it : null;
}
const items = (ids: readonly ItemId[]): Selection => ({ kind: "items", ids });
/** Composing a comment counts: an agent's view command waits until the person sends or cancels. */
const busy = (s: ViewState) => s.gesture !== null || s.editing !== null || s.animation !== null || s.comment.draft !== null || s.comment.parkedDraft !== null || s.comment.composing || s.pages.view === "present";
const policy = (s: ViewState, doc: BaseDoc) => policyOf(doc.layout, s.pages.view);
const presenting = (s: ViewState, doc: BaseDoc) => doc.layout !== "canvas" && s.pages.view === "present";
const closedComment = (s: ViewState): ViewState["comment"] => ({ ...s.comment, draft: s.comment.parkedDraft, parkedDraft: null, activeThreadId: null, expanded: s.comment.parkedDraft !== null, editingCommentId: null, composing: s.comment.parkedDraft !== null });

/** Folds step over a trace. Used by tests and recorded-trace replays. */
export function replay(state: ViewState, doc: BaseDoc, inputs: readonly CanvasInput[], env?: Partial<Env>): { state: ViewState; effects: Effect[] } {
  let t = 0;
  const e: Env = { now: () => t, reducedMotion: true, newId: (() => { let n = 0; return () => `id${String(++n).padStart(8, "0")}`; })(), ...env };
  const effects: Effect[] = [];
  for (const input of inputs) { if (input.type === "tick") t = input.now; const r = step(state, input, doc, e); state = r.state; effects.push(...r.effects); }
  return { state, effects };
}

export function step(s0: ViewState, input: CanvasInput, doc: BaseDoc, env: Env): Step {
  const fx: Effect[] = [];
  // An overdue camera animation (frames throttled in a background tab) finishes before any other input,
  // so a return in progress never blocks the person.
  const caughtUp = s0.animation && input.type !== "tick" && env.now() - s0.animation.startedAt >= FOCUS_ANIM_MS ? tick(s0, env.now(), doc, fx) : s0;
  // The person taking over releases Follow. Escape while following only releases it.
  if (caughtUp.following && input.type === "key-down" && input.key === "Escape" && !input.editable && !caughtUp.gesture) return { state: { ...caughtUp, following: null }, effects: fx };
  const s = stepInner(caughtUp.following && (input.type === "pointer-down" || input.type === "wheel") ? { ...caughtUp, following: null } : caughtUp, input, doc, env, fx);
  // Apply a deferred view command once the person is idle again.
  if (s.deferredCommand && !busy(s) && !s.moving && input.type !== "view-command") {
    const cmd = s.deferredCommand;
    const cleared = { ...s, deferredCommand: null };
    return { state: env.now() > cmd.expiresAt ? cleared : applyViewCommand(cleared, cmd, doc, env, fx), effects: fx };
  }
  return { state: s, effects: fx };
}

function stepInner(s: ViewState, input: CanvasInput, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  switch (input.type) {
    case "pointer-down": return pointerDown(s, input, doc, env, fx);
    case "pointer-move": return s.gesture && s.gesture.pointerId === input.pointerId ? gestureMove(s, s.gesture, input, doc, env, fx) : s;
    case "pointer-up": return s.gesture && s.gesture.pointerId === input.pointerId ? gestureEnd(s, s.gesture, doc, env, fx) : s;
    case "pointer-cancel": return s.gesture && s.gesture.pointerId === input.pointerId ? gestureCancel(s, s.gesture, fx) : s;
    case "double-click": {
      const t = input.target;
      if (t.kind !== "item" || presenting(s, doc)) return s;
      // In the grid, a page opens in the scroll view, scrolled to it.
      if (doc.layout !== "canvas" && s.pages.view === "grid") return scrollTo(leaveGrid({ ...s, selection: items([t.itemId]) }), doc, t.itemId);
      if (t.part === "title") return { ...s, editing: { kind: "item-title", itemId: t.itemId } };
      const it = doc.byId.get(t.itemId);
      if (s.tool !== "move" || !it || it.kind !== "html-snapshot") return s;
      return { ...s, interacting: t.itemId, selection: items([t.itemId]) };
    }
    case "wheel": {
      if (presenting(s, doc)) return s;
      const w = s.wheel;
      if (input.zoom === "none" && policy(s, doc).wheel === "vertical") input = { ...input, dx: 0 };
      const next = input.zoom !== "none"
        ? { ...w, zoom: w.zoom + wheelZoom(input.dy, s.invertScroll), anchor: input.client }
        : { ...w, dx: w.dx + input.dx, dy: w.dy + input.dy };
      if (!w.scheduled) fx.push({ type: "request-frame" });
      return { ...s, wheel: { ...next, scheduled: true } };
    }
    case "tick": return tick(s, input.now, doc, fx);
    case "camera-settled": fx.push({ type: "publish-context" }); return { ...s, moving: false };
    case "resize": return reconcile({ ...s, viewport: input.viewport }, shownDocOf(doc, s.pages.view, input.viewport.width));
    case "document-changed": return reconcile(s, doc, fx);
    case "key-down": return keyDown(s, input, doc, env, fx);
    case "key-up": return (input.code === "ShiftLeft" || input.code === "ShiftRight") ? { ...s, shiftPanning: false } : s;
    case "window-blur": {
      let n: ViewState = { ...s, shiftPanning: false };
      // Focus moving into a live page means the person is using it, but only under Move (POINTER_HAND_PEN_SPEC §3).
      if (input.activeFrameItem && doc.byId.has(input.activeFrameItem) && s.tool === "move" && !s.gesture) n = { ...n, interacting: input.activeFrameItem };
      return n;
    }
    case "bridge": {
      const it = doc.byId.get(input.itemId);
      if (!it) return s;
      const m = input.msg;
      if (m.kind === "pointer") return s.tool === "move" ? { ...s, interacting: input.itemId } : s;
      if (m.kind === "escape") {
        fx.push({ type: "blur-active" });
        const n = { ...s, interacting: null };
        return s.focus.mode === "focused" ? exitFocus(n, doc, env, fx) : n;
      }
      // A wheel the page cannot scroll itself pans the canvas, as it would outside a live page.
      if (m.kind === "pan") return stepInner(s, { type: "wheel", dx: m.dx, dy: m.dy, zoom: "none", client: { x: s.viewport.width / 2, y: s.viewport.height / 2 } }, doc, env, fx);
      const anchor = { x: s.camera.x + (it.x + m.x) * s.camera.z, y: s.camera.y + (it.y + m.y) * s.camera.z };
      return userCamera(s, zoomAround(s.camera, Math.exp(wheelZoom(m.dy, s.invertScroll)), anchor), doc, fx);
    }
    case "command": return command(s, input.command, doc, env, fx);
    case "title-commit": {
      const e = s.editing, v = input.value.trim();
      if (e?.kind === "item-title") { const it = doc.byId.get(e.itemId); if (it && v && v !== it.title) fx.push({ type: "submit", op: { type: "retitleItem", itemId: e.itemId, title: v } }); }
      if (e?.kind === "screen-name" && v && v !== doc.title) fx.push({ type: "submit", op: { type: "renameScreen", title: v } });
      return { ...s, editing: null };
    }
    case "title-cancel": return { ...s, editing: null };
    case "comment-submit": return submitComment(s, input.text, input.expectedText, doc, env, fx);
    case "comment-composing": return { ...s, comment: { ...s.comment, composing: input.on } };
    case "comment-cancel":
      fx.push({ type: "blur-active" });
      return { ...s, comment: s.comment.editingCommentId ? { ...s.comment, editingCommentId: null, composing: false } : closedComment(s) };
    case "view-command": {
      const cmd = input.cmd;
      if (input.now - cmd.issuedAt > VIEW_COMMAND_TTL_MS) { fx.push({ type: "answer-view-command", id: cmd.id, outcome: "dropped" }); return s; }
      if (busy(s)) {
        if (s.deferredCommand) fx.push({ type: "answer-view-command", id: s.deferredCommand.id, outcome: "dropped" });
        fx.push({ type: "answer-view-command", id: cmd.id, outcome: "deferred" });
        return { ...s, deferredCommand: { ...cmd, expiresAt: env.now() + VIEW_COMMAND_TTL_MS - Math.max(0, input.now - cmd.issuedAt) } };
      }
      fx.push({ type: "answer-view-command", id: cmd.id, outcome: "applied" });
      return applyViewCommand(s, cmd, doc, env, fx);
    }
    case "drop-images": {
      if (!input.images.length || s.gesture || s.editing || s.focus.mode !== "none") return s;
      if (doc.layout !== "canvas") return dropPages(s, input, doc, env, fx);
      const v = viewportWorldRect(s.camera, s.viewport);
      const centre = input.at ? screenToWorld(input.at, s.camera) : { x: v.x + v.w / 2, y: v.y + v.h / 2 };
      const rects = placeImages(centre, input.images);
      const ops: Operation[] = input.images.map((img, i) => ({ type: "addItem", item: { kind: "reference-image", id: env.newId(), title: img.title,
        x: rects[i]!.x, y: rects[i]!.y, width: rects[i]!.w, height: rects[i]!.h, assetHash: img.hash, mediaType: img.mediaType } }));
      // One batch, so one drop is one undo step and all or nothing.
      fx.push({ type: "submit", op: ops.length === 1 ? ops[0]! : { type: "batch", ops } });
      const ids = ops.map((o) => (o as Extract<Operation, { type: "addItem" }>).item.id);
      return { ...s, autoFit: false, selection: items(ids), interacting: null };
    }
    case "follow-target": return input.id === s.following && input.rect ? keepInView(s, input.rect, false, env, fx) : s;
    case "theme": return { ...s, theme: input.theme };
  }
}

// ── Pointer dispatch (POINTER_HAND_PEN_SPEC §2) ──

function pointerDown(s0: ViewState, i: Extract<CanvasInput, { type: "pointer-down" }>, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  if (!i.isPrimary || s0.gesture || s0.focus.mode === "returning") return s0;
  const t = i.target;
  let s: ViewState = { ...s0, selection: s0.selection.kind === "stroke" ? items([]) : s0.selection,
    interacting: t.kind === "item" && t.itemId === s0.interacting ? s0.interacting : null };
  const touch = i.p.pointerType === "touch";
  const pol = policy(s, doc);
  // Present: a click anywhere steps to the next slide. Nothing else takes input.
  if (presenting(s, doc)) {
    if (i.button !== 0) return s;
    fx.push({ type: "capture", pointerId: i.p.pointerId });
    return { ...s, gesture: { kind: "pan", pointerId: i.p.pointerId, origin: i.p.client, last: i.p.client, moved: false, onClick: { kind: "next-slide" } } };
  }
  const unselectedSurface = t.kind === "item" && t.part === "surface" && !selectedIds(s).includes(t.itemId);
  // Pins sit above frames and strokes, so in every tool, Hand included, a primary press on a pin is a pin press: a click
  // opens it, a drag moves it. Only Shift and the middle button still pan.
  if (t.kind === "thread" && i.button === 0 && !s.shiftPanning) return startPinDrag(s, i.p, t.threadId, doc, fx);
  // On a page in the scroll view, Move selects and a drag pans: pages are placed by order, never dragged.
  const pagePan = s.tool === "move" && t.kind === "item" && pol.drag === "pan" && s.focus.mode === "none";
  if (i.button === 1 || s.shiftPanning || pagePan || (i.button === 0 && (s.tool === "hand" || (s.tool === "move" && touch && (t.kind === "background" || unselectedSurface))))) {
    fx.push({ type: "capture", pointerId: i.p.pointerId });
    return { ...s, gesture: { kind: "pan", pointerId: i.p.pointerId, origin: i.p.client, last: i.p.client, moved: false,
      onClick: t.kind === "item" && (touch || pagePan) ? { kind: "select", itemId: t.itemId } : { kind: "clear" } } };
  }
  if (i.button !== 0) return s;
  if (s.comment.activeThreadId) s = { ...s, comment: closedComment(s) };
  switch (s.tool) {
    case "pencil": return pol.marks ? startStroke(s, i.p, doc, env, fx) : s;
    case "comment": return pol.marks ? startCommentArea(s, i.p, doc, fx) : s;
    case "hand": return s;
    case "move":
      if (s.focus.mode === "focused") return s; // the focused page takes input directly
      if (t.kind === "stroke") return { ...s, selection: { kind: "stroke", id: t.strokeId } };
      if (t.kind === "handle") return pol.handles ? startResize(s, i, t.handle, doc, env, fx) : s;
      if (t.kind === "item") return startItemDrag(s, i, t.itemId, t.part, doc, env, fx);
      fx.push({ type: "capture", pointerId: i.p.pointerId });
      return { ...s, selection: items(i.shift ? selectedIds(s) : []), gesture: { kind: "marquee", pointerId: i.p.pointerId, originWorld: screenToWorld(i.p.client, s.camera), base: i.shift ? selectedIds(s) : [], restore: selectedIds(s), rect: null } };
  }
}

function startItemDrag(s: ViewState, i: Extract<CanvasInput, { type: "pointer-down" }>, id: ItemId, part: "surface" | "title", doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  const lead = doc.byId.get(id);
  if (!lead || lead.removing) return s;
  const was = selectedIds(s).includes(id);
  let sel = selectedIds(s);
  if (i.shift) sel = was ? sel.filter((x) => x !== id) : [...sel, id];
  else if (!was) sel = [id];
  // UNVERIFIED (POINTER_HAND_PEN_SPEC §4.1): literal reading of the shipped coupling for Shift-press on a selected item.
  const dragSet = sel.includes(id) ? sel : [id];
  const initial = new Map<ItemId, Point>();
  for (const x of dragSet) { const it = doc.byId.get(x); if (it && !it.removing) initial.set(x, { x: it.x, y: it.y }); }
  fx.push({ type: "capture", pointerId: i.p.pointerId });
  return { ...s, selection: items(sel), gesture: {
    kind: "item-drag", pointerId: i.p.pointerId, gestureId: env.newId(), origin: i.p.client, leadId: id, clickReduces: part === "surface" && was && !i.shift,
    initial, leadRect: lead.rect, targets: doc.items.filter((it) => !initial.has(it.id) && !it.removing).map((it) => it.rect),
    dragging: false, preview: null, guides: [], lastBroadcastAt: -Infinity, unsent: false, reorder: policy(s, doc).drag === "reorder", slot: null } };
}

function startResize(s: ViewState, i: Extract<CanvasInput, { type: "pointer-down" }>, handle: Handle, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  const its = selectedIds(s).map((id) => doc.byId.get(id)).filter((it) => !!it && !it.removing);
  if (its.length === 0) return s;
  const starts = new Map(its.map((it) => [it!.id, it!.rect]));
  const { box, limits } = groupBox([...starts.values()]);
  fx.push({ type: "capture", pointerId: i.p.pointerId });
  return { ...s, selection: items([...starts.keys()]), interacting: null, gesture: {
    kind: "item-resize", pointerId: i.p.pointerId, gestureId: env.newId(), origin: i.p.client, starts, kinds: [...new Set(its.map((it) => it!.kind))], handle, box, limits,
    targets: doc.items.filter((o) => !starts.has(o.id) && !o.removing).map((o) => o.rect), preview: null, guides: [], lastBroadcastAt: -Infinity, unsent: false } };
}

type GeometryGesture = Extract<Gesture, { kind: "item-drag" | "item-resize" }>;
/** Sends the preview to other clients at most every TRANSIENT_INTERVAL_MS. A throttled preview goes out on a later frame
 *  (tick), so a pointer that stops still shows its final geometry everywhere. */
function broadcast<G extends GeometryGesture>(g: G, now: number, fx: Effect[]): G {
  if (!g.preview) return g;
  if (now - g.lastBroadcastAt >= TRANSIENT_INTERVAL_MS) { fx.push({ type: "transient", gestureId: g.gestureId, rects: g.preview }); return { ...g, lastBroadcastAt: now, unsent: false }; }
  fx.push({ type: "request-frame" });
  return { ...g, unsent: true };
}

/** Same entries with the same values: the step changes nothing, so it renders and broadcasts nothing. */
function samePreview(a: ReadonlyMap<ItemId, Placement> | null, b: ReadonlyMap<ItemId, Placement>): boolean {
  if (!a || a.size !== b.size) return false;
  for (const [id, p] of b) { const q = a.get(id); if (!q || q.x !== p.x || q.y !== p.y || q.w !== p.w || q.h !== p.h) return false; }
  return true;
}

function startStroke(s: ViewState, p: PointerSample, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  const w = screenToWorld(p.client, s.camera);
  const hit = topItemAt(doc.items.filter((it) => !it.removing), w);
  if (!hit && !policy(s, doc).worldMarks) return s; // marks on a Presentation or Document go on a page
  const anchorOrigin = hit ? { x: hit.x, y: hit.y } : { x: 0, y: 0 };
  const draft: StrokeDraft = { id: env.newId(), anchor: hit ? { kind: "item", itemId: hit.id } : { kind: "world" },
    points: [strokePoint(p, s.camera, anchorOrigin)], color: s.pencil.color, size: round2(s.pencil.size / s.camera.z) };
  fx.push({ type: "capture", pointerId: p.pointerId });
  return { ...s, gesture: { kind: "stroke", pointerId: p.pointerId, origin: p.client, anchorOrigin, draft, drawing: false, frameRequested: false } };
}

// ── Comments ──

/** Where a press in Comment mode lands: the topmost item under the point (the Pencil anchoring rule), else the world. */
const positionUnder = (w: Point, doc: BaseDoc): ThreadPosition => {
  const hit = topItemAt(doc.items.filter((it) => !it.removing), w);
  return positionAt(w, hit && { itemId: hit.id, rect: hit.rect });
};

function startCommentArea(s: ViewState, p: PointerSample, doc: BaseDoc, fx: Effect[]): ViewState {
  if (s.comment.draft && s.comment.composing) return s;
  const w = screenToWorld(p.client, s.camera);
  if (!policy(s, doc).worldMarks && !topItemAt(doc.items.filter((it) => !it.removing), w)) return s;
  fx.push({ type: "capture", pointerId: p.pointerId });
  return { ...s, gesture: { kind: "comment-area", pointerId: p.pointerId, origin: p.client, start: w, rect: null } };
}

/** A circled region anchors to the topmost item under its centre, clipped to that item, else to the world. */
function draftFor(g: Extract<Gesture, { kind: "comment-area" }>, doc: BaseDoc, worldMarks: boolean): ThreadPosition | null {
  const live = doc.items.filter((it) => !it.removing);
  if (!g.rect) return worldMarks || topItemAt(live, g.start) ? positionUnder(g.start, doc) : null;
  const r = g.rect, hit = topItemAt(live, { x: r.x + r.w / 2, y: r.y + r.h / 2 });
  if (!hit && !worldMarks) return null;
  const b = hit?.rect, x = b ? Math.max(r.x, b.x) : r.x, y = b ? Math.max(r.y, b.y) : r.y;
  const clipped = b ? { x, y, w: Math.min(r.x + r.w, b.x + b.w) - x, h: Math.min(r.y + r.h, b.y + b.h) - y } : r;
  const at = areaAt(clipped, hit ? { itemId: hit.id, rect: b! } : null);
  // A straight-line drag circles nothing: it places a pin, like a click.
  return at.area && at.area.w > 0 && at.area.h > 0 ? at : positionUnder(g.start, doc);
}

function startPinDrag(s: ViewState, p: PointerSample, threadId: ThreadId, doc: BaseDoc, fx: Effect[]): ViewState {
  const t = doc.threadById.get(threadId);
  const start = t && threadPoint(t, (id) => doc.byId.get(id)?.rect);
  if (!t || !start) return s;
  fx.push({ type: "capture", pointerId: p.pointerId });
  // An unsaved or removing thread opens but never moves: a move would name a thread the service does not have.
  return { ...s, gesture: { kind: "pin-drag", pointerId: p.pointerId, threadId, origin: p.client, start, movable: !isUnsaved(t) && !t.removing, preview: null } };
}

function submitComment(s: ViewState, raw: string, expectedText: string | undefined, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  const text = raw.trim();
  if (!text) return s;
  if (presenting(s, doc)) return s;
  const { draft, activeThreadId, editingCommentId } = s.comment;
  if (editingCommentId) {
    if (!activeThreadId || expectedText === undefined) return s;
    fx.push({ type: "submit", op: { type: "editComment", threadId: activeThreadId, commentId: editingCommentId, text, expectedText } });
    return { ...s, comment: { ...s.comment, editingCommentId: null, composing: false } };
  }
  if (draft) {
    fx.push({ type: "submit", op: { type: "addThread", thread: { id: draft.id, anchor: draft.anchor, x: draft.x, y: draft.y, ...(draft.area ? { area: draft.area } : {}), comment: { id: env.newId(), text } } } });
    return { ...s, comment: { ...s.comment, draft: null, activeThreadId: draft.id, expanded: false, composing: false } };
  }
  const t = activeThreadId ? doc.threadById.get(activeThreadId) : undefined;
  // A reply waits for its thread to be saved, so no reply is ever ordered before the thread it answers.
  if (t && !isUnsaved(t) && !t.removing) fx.push({ type: "submit", op: { type: "addComment", threadId: t.id, comment: { id: env.newId(), text } } });
  return { ...s, comment: { ...s.comment, composing: false } };
}

/** What a pin shows. The shell and the test hook both read this, so neither re-derives it. `doc` is the render doc. */
export interface ThreadPresentation { readonly visible: boolean; readonly active: boolean; readonly dimmed: boolean; readonly point: Point | null }
export function presentThread(t: DisplayThread, s: ViewState, doc: BaseDoc): ThreadPresentation {
  const g = s.gesture;
  const point = g?.kind === "pin-drag" && g.threadId === t.id && g.preview ? g.preview : threadPoint(t, (id) => doc.byId.get(id)?.rect);
  const active = s.comment.activeThreadId === t.id && s.comment.expanded;
  const item = t.anchor.kind === "item" ? doc.byId.get(t.anchor.itemId) : undefined;
  const hiddenByFocus = (s.focus.mode === "focused" && item?.id !== s.focus.itemId) || presenting(s, doc);
  return { point, active, visible: point !== null && !hiddenByFocus && (!t.resolved || s.comment.showResolved),
    dimmed: t.removing || !!item?.removing || t.sync === "failed" };
}
/** Panel rows: newest first, resolved ones only with the filter on. */
export function panelThreads(doc: BaseDoc, s: ViewState): readonly DisplayThread[] {
  return doc.threads.filter((t) => !t.resolved || s.comment.showResolved).reverse();
}

const strokePoint = (p: PointerSample, c: Camera, ao: Point): StrokePoint => {
  const w = screenToWorld(p.client, c);
  return [round2(w.x - ao.x), round2(w.y - ao.y), p.pointerType !== "mouse" && p.pressure > 0 ? p.pressure : 0.5];
};

function gestureMove(s: ViewState, g: Gesture, i: Extract<CanvasInput, { type: "pointer-move" }>, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  const last = i.samples.at(-1);
  if (!last) return s;
  const c = last.client;
  switch (g.kind) {
    case "pan": {
      const moved = g.moved || Math.hypot(c.x - g.origin.x, c.y - g.origin.y) > PAN_MOVED_PX;
      if (g.onClick.kind === "next-slide") return { ...s, gesture: { ...g, last: c, moved } };
      const dx = policy(s, doc).wheel === "vertical" ? 0 : c.x - g.last.x;
      const n = userCamera(s, pan(s.camera, dx, c.y - g.last.y), doc, fx);
      return { ...n, gesture: { ...g, last: c, moved } };
    }
    case "item-drag": {
      if (!g.dragging && Math.hypot(c.x - g.origin.x, c.y - g.origin.y) < DRAG_THRESHOLD_PX) return s;
      let dx = (c.x - g.origin.x) / s.camera.z, dy = (c.y - g.origin.y) / s.camera.z;
      let guides: Guide[] = [];
      if (g.reorder && doc.layout !== "canvas") {
        // The dragged pages follow the pointer; the drop slot is the one rule both the bar and the commit use.
        const preview = new Map<ItemId, Placement>();
        for (const [id, p] of g.initial) preview.set(id, { x: Math.round(p.x + dx), y: Math.round(p.y + dy) });
        const slot = slotAmong(doc.layout, doc.items, new Set(g.initial.keys()), screenToWorld(c, s.camera), s.viewport.width);
        return { ...s, interacting: null, gesture: { ...g, dragging: true, preview, slot } };
      }
      if (!i.mod) {
        const r = snapLead({ ...g.leadRect, x: g.leadRect.x + dx, y: g.leadRect.y + dy }, g.targets, SNAP_SCREEN_PX / s.camera.z);
        dx += r.dx; dy += r.dy; guides = r.guides;
      }
      const preview = new Map<ItemId, Placement>();
      for (const [id, p] of g.initial) preview.set(id, { x: Math.round(p.x + dx), y: Math.round(p.y + dy) });
      if (g.dragging && samePreview(g.preview, preview)) return s;
      return { ...s, interacting: null, gesture: broadcast({ ...g, dragging: true, preview, guides }, env.now(), fx) };
    }
    case "item-resize": {
      if (!g.preview && Math.hypot(c.x - g.origin.x, c.y - g.origin.y) < DRAG_THRESHOLD_PX) return s;
      const delta = { x: (c.x - g.origin.x) / s.camera.z, y: (c.y - g.origin.y) / s.camera.z };
      const r = resizeRect(g.box, g.handle, delta, keepsAspect(g.kinds, g.handle, i.shift), i.mod ? [] : g.targets, SNAP_SCREEN_PX / s.camera.z, g.limits);
      const preview = new Map<ItemId, Placement>();
      for (const [id, start] of g.starts) { const q = g.starts.size === 1 ? r.rect : scaleRect(start, g.box, r.rect); preview.set(id, { x: q.x, y: q.y, w: q.w, h: q.h }); }
      if (samePreview(g.preview, preview)) return s;
      return { ...s, gesture: broadcast({ ...g, preview, guides: r.guides }, env.now(), fx) };
    }
    case "marquee": {
      const rect = normalizedRect(g.originWorld, screenToWorld(c, s.camera));
      const hit = doc.items.filter((it) => !it.removing && intersects(it.rect, rect)).map((it) => it.id);
      return { ...s, selection: items([...new Set([...g.base, ...hit])]), gesture: { ...g, rect } };
    }
    case "stroke": {
      let drawing = g.drawing;
      const pts = [...g.draft.points];
      for (const p of i.samples) {
        if (Math.hypot(p.client.x - g.origin.x, p.client.y - g.origin.y) >= STROKE_DRAW_PX) drawing = true;
        const q = strokePoint(p, s.camera, g.anchorOrigin), prev = pts.at(-1)!;
        if (Math.hypot(q[0] - prev[0], q[1] - prev[1]) >= STROKE_SPACING_PX / s.camera.z) pts.push(q);
      }
      let frameRequested = g.frameRequested;
      if (drawing && !frameRequested) { fx.push({ type: "request-frame" }); frameRequested = true; }
      return { ...s, gesture: { ...g, drawing, frameRequested, draft: { ...g.draft, points: pts } } };
    }
    case "comment-area": {
      if (!g.rect && Math.hypot(c.x - g.origin.x, c.y - g.origin.y) < PIN_DRAG_PX) return s;
      return { ...s, gesture: { ...g, rect: normalizedRect(g.start, screenToWorld(c, s.camera)) } };
    }
    case "pin-drag": {
      if (!g.movable || (!g.preview && Math.hypot(c.x - g.origin.x, c.y - g.origin.y) < PIN_DRAG_PX)) return s;
      return { ...s, gesture: { ...g, preview: { x: g.start.x + (c.x - g.origin.x) / s.camera.z, y: g.start.y + (c.y - g.origin.y) / s.camera.z } } };
    }
  }
}

function gestureEnd(s: ViewState, g: Gesture, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  fx.push({ type: "release", pointerId: g.pointerId });
  const done = { ...s, gesture: null };
  switch (g.kind) {
    case "pan":
      if (g.moved) return done;
      if (g.onClick.kind === "next-slide") return presentStep(done, doc, "next");
      return g.onClick.kind === "select" ? { ...done, selection: items([g.onClick.itemId]) } : { ...done, selection: items([]) };
    case "item-drag": {
      if (!g.dragging) return g.clickReduces ? { ...done, selection: items([g.leadId]) } : done;
      if (g.reorder) {
        const ids = doc.items.filter((it) => g.initial.has(it.id)).map((it) => it.id);
        if (g.slot !== null && ids.length && reorderedZ(doc.items, ids, { index: g.slot }).size) fx.push({ type: "submit", op: { type: "reorderItems", itemIds: ids, to: { index: g.slot } } });
        return done;
      }
      const moves = [...(g.preview ?? [])].filter(([id, p]) => doc.byId.has(id) && (p.x !== g.initial.get(id)!.x || p.y !== g.initial.get(id)!.y)).map(([itemId, p]) => ({ itemId, x: p.x, y: p.y }));
      // Hand the final positions to the pending ledger before the preview disappears, so nothing flickers. Other clients
      // get the final positions now and keep them until the op settles, so they never flash back to the start.
      if (moves.length) {
        fx.push({ type: "transient", gestureId: g.gestureId, rects: g.preview });
        fx.push({ type: "submit", op: { type: "moveItems", moves }, endsPreview: g.gestureId });
      } else fx.push({ type: "transient", gestureId: g.gestureId, rects: null });
      return done;
    }
    case "item-resize": {
      const op = g.preview ? geometryOp(g.starts, g.preview, doc) : null;
      if (op) { fx.push({ type: "transient", gestureId: g.gestureId, rects: g.preview }); fx.push({ type: "submit", op, endsPreview: g.gestureId }); }
      else if (g.preview) fx.push({ type: "transient", gestureId: g.gestureId, rects: null });
      return done;
    }
    case "marquee": return done;
    case "stroke": {
      if (!g.drawing) return { ...selectTool(done, "move"), gesture: null }; // a tap returns to Move
      let pts = g.draft.points;
      if (pts.length > STROKE_MAX_POINTS) { const k = Math.ceil(pts.length / STROKE_MAX_POINTS); pts = pts.filter((_, idx) => idx % k === 0); }
      fx.push({ type: "submit", op: { type: "addStroke", stroke: { ...g.draft, points: pts } } });
      return done;
    }
    case "comment-area": {
      const at = draftFor(g, doc, policy(s, doc).worldMarks);
      return at ? { ...done, comment: { ...s.comment, activeThreadId: null, expanded: true, editingCommentId: null, composing: false, draft: { id: env.newId(), ...at } } } : done;
    }
    case "pin-drag": {
      if (!g.preview) {
        const open = s.comment.activeThreadId === g.threadId && s.comment.expanded ? null : g.threadId;
        if (open === null) return { ...done, comment: closedComment(s) };
        return { ...done, comment: { ...s.comment, draft: null, parkedDraft: s.comment.draft && s.comment.composing ? s.comment.draft : s.comment.parkedDraft, activeThreadId: open, expanded: open !== null, editingCommentId: null, composing: false } };
      }
      const t = doc.threadById.get(g.threadId);
      const next = positionUnder(g.preview, doc);
      if (t && (JSON.stringify(t.anchor) !== JSON.stringify(next.anchor) || t.x !== next.x || t.y !== next.y))
        fx.push({ type: "submit", op: { type: "moveThread", threadId: g.threadId, anchor: next.anchor, x: next.x, y: next.y } });
      return done;
    }
  }
}

/** A resize commit: the sizes, plus moves for items whose origin shifted. One revision, one undo entry. */
function geometryOp(starts: ReadonlyMap<ItemId, Rect>, preview: ReadonlyMap<ItemId, Placement>, doc: BaseDoc): Operation | null {
  const moves: { itemId: ItemId; x: number; y: number }[] = [], sizes: { itemId: ItemId; width: number; height: number }[] = [];
  for (const [itemId, a] of starts) {
    const p = preview.get(itemId);
    if (!p || !doc.byId.has(itemId)) continue;
    const w = p.w ?? a.w, h = p.h ?? a.h;
    if (p.x !== a.x || p.y !== a.y) moves.push({ itemId, x: p.x, y: p.y });
    if (w !== a.w || h !== a.h) sizes.push({ itemId, width: w, height: h });
  }
  const move: Operation = { type: "moveItems", moves }, resize: Operation = { type: "resizeItems", sizes };
  return moves.length && sizes.length ? { type: "batch", ops: [move, resize] } : sizes.length ? resize : moves.length ? move : null;
}

/** pointercancel or Escape. Nothing was committed, so nothing is restored on the service. */
function gestureCancel(s: ViewState, g: Gesture, fx: Effect[]): ViewState {
  fx.push({ type: "release", pointerId: g.pointerId });
  if ((g.kind === "item-drag" && g.dragging && !g.reorder) || (g.kind === "item-resize" && g.preview)) fx.push({ type: "transient", gestureId: g.gestureId, rects: null });
  if (g.kind === "marquee") return { ...s, gesture: null, selection: items(g.restore) };
  return { ...s, gesture: null };
}

// ── Camera ──

/** Every person-driven camera change goes through here. */
function userCamera(s: ViewState, proposal: Camera, doc: BaseDoc, fx: Effect[]): ViewState {
  if (s.animation && s.focus.mode === "focused") return s; // input during focus-in is dropped
  let n = s;
  if (s.focus.mode === "returning") n = { ...n, animation: null, focus: { mode: "none" } };
  let camera: Camera = { ...proposal, z: clampZoom(proposal.z) };
  if (n.focus.mode === "focused") {
    const it = doc.byId.get(n.focus.itemId);
    if (it) { const c0 = fitItem(it.rect, n.viewport, { zoom: camera.z }); camera = fitItem(it.rect, n.viewport, { zoom: camera.z, offset: { x: camera.x - c0.x, y: camera.y - c0.y } }); }
  }
  fx.push({ type: "settle-timer" });
  return { ...n, camera, autoFit: false, moving: true, following: null };
}

/** Brings a participant's work into view. Unless forced, nothing moves while it sits inside the middle 80% of the view, while the
 *  person is busy or in focus mode. Keeps the zoom when the rect fits, else fits it. */
function keepInView(s: ViewState, r: Rect, force: boolean, env: Env, fx: Effect[]): ViewState {
  if (busy(s) || s.focus.mode !== "none") return s;
  const v = viewportWorldRect(s.camera, s.viewport), mx = v.w * 0.1, my = v.h * 0.1;
  const inside = r.x >= v.x + mx && r.y >= v.y + my && r.x + r.w <= v.x + v.w - mx && r.y + r.h <= v.y + v.h - my;
  if (inside && !force) return s;
  const z = s.camera.z, fits = r.w * z <= s.viewport.width * 0.8 && r.h * z <= s.viewport.height * 0.8;
  const to = fits ? { x: s.viewport.width / 2 - (r.x + r.w / 2) * z, y: s.viewport.height / 2 - (r.y + r.h / 2) * z, z } : fitAll(r, s.viewport);
  return to ? animateTo({ ...s, autoFit: false }, to, "none", env, fx) : s;
}

function tick(s: ViewState, now: number, doc: BaseDoc, fx: Effect[]): ViewState {
  let n = s;
  if (n.gesture?.kind === "stroke" && n.gesture.frameRequested) n = { ...n, gesture: { ...n.gesture, frameRequested: false } };
  if ((n.gesture?.kind === "item-drag" || n.gesture?.kind === "item-resize") && n.gesture.unsent) n = { ...n, gesture: broadcast(n.gesture, now, fx) };
  if (n.wheel.scheduled) {
    const w = n.wheel;
    n = { ...n, wheel: { dx: 0, dy: 0, zoom: 0, anchor: w.anchor, scheduled: false } };
    let cam = pan(n.camera, -w.dx, -w.dy);
    if (w.zoom !== 0) cam = zoomAround(cam, Math.exp(w.zoom), w.anchor);
    if (w.dx !== 0 || w.dy !== 0 || w.zoom !== 0) n = userCamera(n, cam, doc, fx);
  }
  if (n.animation) {
    const a = n.animation, t = Math.min(1, (now - a.startedAt) / FOCUS_ANIM_MS);
    if (t >= 1) {
      n = { ...n, camera: a.to, animation: null, focus: a.then === "finish-return" ? { mode: "none" } : n.focus };
      fx.push({ type: "publish-context" });
    } else { n = { ...n, camera: lerpCamera(a.from, a.to, focusEase(t)) }; fx.push({ type: "request-frame" }); }
  }
  return n;
}

function animateTo(s: ViewState, to: Camera, then: CameraAnimation["then"], env: Env, fx: Effect[]): ViewState {
  if (env.reducedMotion) { fx.push({ type: "publish-context" }); return { ...s, camera: to, animation: null, focus: then === "finish-return" ? { mode: "none" } : s.focus }; }
  fx.push({ type: "request-frame" });
  return { ...s, animation: { from: s.camera, to, startedAt: env.now(), then } };
}

function enterFocus(s: ViewState, id: ItemId, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  const it = doc.byId.get(id);
  if (!it) return s;
  // The person's focus shortcut can interrupt a held pointer. Release capture and its remote preview before focusing.
  if (s.gesture) s = gestureCancel(s, s.gesture, fx);
  const restore = s.focus.mode === "focused" ? s.focus.restore : { camera: s.camera, autoFit: s.autoFit };
  const n: ViewState = { ...s, focus: { mode: "focused", itemId: id, restore }, autoFit: true, selection: items([id]), interacting: null, gesture: null };
  return animateTo(n, fitItem(it.rect, s.viewport, { fit: doc.layout === "canvas" ? "scroll" : "contain" }), "none", env, fx);
}

function exitFocus(s: ViewState, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  if (s.focus.mode !== "focused") return s;
  if (presenting(s, doc)) return exitPresent(s, doc, fx);
  const { itemId, restore } = s.focus;
  const bounds = boundsOf(doc.items.map((i) => i.rect));
  const to = restore.autoFit && bounds ? fitFor(s, doc, bounds)! : restore.camera;
  const n: ViewState = { ...s, autoFit: restore.autoFit, focus: { mode: "returning", itemId }, interacting: null, selection: items(doc.byId.has(itemId) ? [itemId] : []) };
  return animateTo(n, to, "finish-return", env, fx);
}

/** Prunes missing ids; refits while auto-fit is on and no gesture is active. */
function reconcile(s: ViewState, doc: BaseDoc, fx?: Effect[]): ViewState {
  let n = s;
  const ids = selectedIds(n).filter((id) => doc.byId.has(id));
  if (n.selection.kind === "items" && ids.length !== n.selection.ids.length) n = { ...n, selection: items(ids) };
  if (n.selection.kind === "stroke" && !doc.strokes.some((x) => x.id === (n.selection as { id: string }).id)) n = { ...n, selection: items([]) };
  if (n.interacting && !doc.byId.has(n.interacting)) n = { ...n, interacting: null };
  if (n.gesture?.kind === "item-drag" && !doc.byId.has(n.gesture.leadId)) n = gestureCancel(n, n.gesture, fx ?? []);
  if (n.gesture?.kind === "item-resize" && [...n.gesture.starts.keys()].some((id) => !doc.byId.has(id))) n = gestureCancel(n, n.gesture, fx ?? []);
  if (n.editing?.kind === "item-title" && !doc.byId.has(n.editing.itemId)) n = { ...n, editing: null };
  // A gone thread closes its card, and so does one someone resolved while the filter hides resolved threads.
  // A draft whose item is gone is dropped, never moved to the world.
  const parked = n.comment.parkedDraft;
  if (parked?.anchor.kind === "item" && !doc.byId.has(parked.anchor.itemId)) n = { ...n, comment: { ...n.comment, parkedDraft: null } };
  const c = n.comment, active = c.activeThreadId ? doc.threadById.get(c.activeThreadId) : undefined;
  if ((c.activeThreadId && (!active || (active.resolved && !c.showResolved))) || (c.draft?.anchor.kind === "item" && !doc.byId.has(c.draft.anchor.itemId))) n = { ...n, comment: closedComment(n) };
  if (n.comment.editingCommentId && !active?.comments.some((c) => c.id === n.comment.editingCommentId)) n = { ...n, comment: { ...n.comment, editingCommentId: null, composing: false } };
  if (n.gesture?.kind === "pin-drag" && !doc.threadById.has(n.gesture.threadId)) n = gestureCancel(n, n.gesture, fx ?? []);
  if (n.focus.mode === "focused" && !doc.byId.has(n.focus.itemId)) {
    // A presented slide someone removed: Present moves to the slide now in its place, or ends with an empty deck.
    if (presenting(n, doc) && doc.items.length) n = { ...n, focus: { ...n.focus, itemId: doc.items[Math.min(presentIndex(n, doc), doc.items.length - 1)]!.id } };
    else n = { ...n, focus: { mode: "none" }, autoFit: n.focus.restore.autoFit, animation: null, pages: presenting(n, doc) ? SCROLL : n.pages };
  }
  if (n.autoFit && !n.gesture) {
    if (n.focus.mode === "focused") { const it = doc.byId.get(n.focus.itemId); if (it && !n.animation) n = { ...n, camera: presenting(n, doc) ? fitExact(it.rect, n.viewport) : fitItem(it.rect, n.viewport, { fit: doc.layout === "canvas" ? "scroll" : "contain" }) }; }
    else if (n.focus.mode === "none") { const c = fitFor(n, doc, boundsOf(doc.items.map((i) => i.rect))); if (c) n = { ...n, camera: c }; }
  }
  return n;
}

function applyViewCommand(s: ViewState, cmd: ViewCommand, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  if (cmd.kind === "focus") return enterFocus(s, cmd.itemId, doc, env, fx);
  if (cmd.kind === "exit-focus") return exitFocus(s, doc, env, fx);
  const rects = cmd.itemIds.map((id) => doc.byId.get(id)?.rect).filter((r): r is Rect => !!r);
  const c = fitAll(boundsOf(rects), s.viewport);
  if (!c) return s;
  const n = s.focus.mode === "focused" ? { ...s, focus: { mode: "none" } as FocusState } : s;
  return animateTo({ ...n, autoFit: false, selection: items(rects.length ? cmd.itemIds.filter((id) => doc.byId.has(id)) : selectedIds(n)) }, c, "none", env, fx);
}

// ── Tools, keys and commands ──

/** POINTER_HAND_PEN_SPEC §3. Never deletes content. */
/** Choosing Comment again returns to Move. */
const toggled = (s: ViewState, tool: ToolId): ToolId => (tool === "comment" && s.tool === "comment" ? "move" : tool);

export function selectTool(s: ViewState, tool: ToolId): ViewState {
  let n: ViewState = { ...s, tool, selection: s.selection.kind === "stroke" ? items([]) : s.selection };
  if (tool === "pencil" || tool === "comment") n = { ...n, selection: items([]) };
  if (tool !== "move") n = { ...n, interacting: null };
  return n;
}

function escape(s: ViewState, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  if (s.gesture) return gestureCancel(s, s.gesture, fx);
  if (presenting(s, doc)) return s.comment.panelOpen ? { ...s, comment: { ...closedComment(s), panelOpen: false } } : exitPresent(s, doc, fx);
  if (s.selection.kind === "stroke") return { ...s, selection: items([]) };
  if (s.comment.draft !== null || s.comment.activeThreadId !== null) return { ...s, comment: closedComment(s) };
  if (s.interacting) { fx.push({ type: "blur-active" }); return { ...s, interacting: null }; }
  if (s.focus.mode === "focused") return exitFocus(s, doc, env, fx);
  if (s.tool === "move") return selectedIds(s).length ? { ...s, selection: items([]) } : s;
  return selectTool(s, "move");
}

const ARROWS: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
/** Arrow steps: 1 world unit, 10 with Shift; panning moves the view 40 px, 200 with Shift. */
export const NUDGE = 1, NUDGE_SHIFT = 10, KEY_PAN_PX = 40, KEY_PAN_SHIFT_PX = 200;

/** The item Tab (or Shift+Tab) moves to, in reading order (top to bottom, then left to right). Null past either end, so
 *  Tab then leaves the canvas for the toolbar instead of trapping keyboard focus. */
export function nextItem(s: ViewState, doc: BaseDoc, back: boolean): ItemId | null {
  const order = doc.items.filter((i) => !i.removing).sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
  if (!order.length) return null;
  const cur = s.focus.mode === "focused" ? s.focus.itemId : selectedIds(s).at(-1);
  const at = cur ? order.findIndex((i) => i.id === cur) : -1;
  const i = at < 0 ? (back ? order.length - 1 : 0) : at + (back ? -1 : 1);
  return order[i]?.id ?? null;
}

/** Keeps zoom and centres `r` when any part of it is out of view. */
function reveal(s: ViewState, r: Rect, env: Env, fx: Effect[]): ViewState {
  const v = viewportWorldRect(s.camera, s.viewport);
  if (r.x >= v.x && r.y >= v.y && r.x + r.w <= v.x + v.w && r.y + r.h <= v.y + v.h) return s;
  const z = s.camera.z;
  return animateTo({ ...s, autoFit: false }, { x: s.viewport.width / 2 - (r.x + r.w / 2) * z, y: s.viewport.height / 2 - (r.y + r.h / 2) * z, z }, "none", env, fx);
}

function keyDown(s: ViewState, k: Extract<CanvasInput, { type: "key-down" }>, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  if (k.editable) return s;
  // A focused button, link or pin keeps Space, Enter, Tab and the arrows; Escape and shortcuts still reach the canvas.
  if (k.control && (k.code === "Space" || k.key === "Enter" || k.key === "Tab" || k.key in ARROWS)) return s;
  // Present takes only its own keys and Escape: nothing edits a slide while presenting.
  if (presenting(s, doc)) {
    if (k.key === "Escape") return escape(s, doc, env, fx);
    const to = !k.mod ? PRESENT_KEYS[k.key] : undefined;
    return to ? presentStep(s, doc, to) : s;
  }
  if (k.code === "ShiftLeft" || k.code === "ShiftRight") return s.shiftPanning ? s : { ...s, shiftPanning: true };
  if (k.key === "Escape") return escape(s, doc, env, fx);
  const arrow = ARROWS[k.key];
  if (arrow) {
    const step = k.shift ? NUDGE_SHIFT : NUDGE, px = k.shift ? KEY_PAN_SHIFT_PX : KEY_PAN_PX;
    if (!k.mod && s.selection.kind === "items" && !s.selection.ids.length && s.focus.mode === "none" && !s.gesture)
      return userCamera(s, pan(s.camera, -arrow[0] * px, -arrow[1] * px), doc, fx);
    // Pages are placed by order: arrows step the selection between pages, and Mod+arrows (resize) do nothing.
    if (policy(s, doc).arrows === "step-page") return k.mod || s.focus.mode !== "none" ? s : stepPage(s, doc, arrow, env, fx);
    return k.mod ? command(s, { kind: "resize-by", dw: arrow[0] * step, dh: arrow[1] * step }, doc, env, fx)
      : command(s, { kind: "nudge", dx: arrow[0] * step, dy: arrow[1] * step }, doc, env, fx);
  }
  if (k.key === "Tab" && !k.mod) return command(s, { kind: "select-next", back: k.shift }, doc, env, fx);
  if (k.mod) {
    const key = k.key.toLowerCase();
    if (k.code === "BracketRight" || k.code === "BracketLeft") return command(s, { kind: "reorder", to: k.code === "BracketRight" ? "forward" : "backward" }, doc, env, fx);
    if (key === "=" || key === "+") return command(s, { kind: "zoom-in" }, doc, env, fx);
    if (key === "-") return command(s, { kind: "zoom-out" }, doc, env, fx);
    if (key === "0") return command(s, { kind: "zoom-100" }, doc, env, fx);
    if (key === "1") return command(s, { kind: "fit-all" }, doc, env, fx);
    if (key === "z") return command(s, { kind: k.shift ? "redo" : "undo" }, doc, env, fx);
    if (key === "c" && k.shift) return command(s, { kind: "copy-image" }, doc, env, fx);
    if (key === "a" && s.focus.mode === "none") return { ...s, selection: items(doc.items.filter((i) => !i.removing).map((i) => i.id)) };
    return s;
  }
  if (k.shift && k.code === "Digit1") return command(s, { kind: "fit-all" }, doc, env, fx);
  if (k.shift && k.code === "Digit2") return command(s, { kind: "zoom-to-selection" }, doc, env, fx);
  if (k.key === "Delete" || k.key === "Backspace") return command(s, { kind: "delete" }, doc, env, fx);
  const one = selectedIds(s).length === 1 ? doc.byId.get(selectedIds(s)[0]!) : undefined;
  // Enter renames, as in the library and Finder. F focuses the selected item, and again leaves focus.
  if (k.key === "Enter" && !k.shift && one && !one.removing && s.focus.mode === "none") return command(s, { kind: "edit", editing: { kind: "item-title", itemId: one.id } }, doc, env, fx);
  if (k.key.toLowerCase() === "f" && !k.shift) {
    if (s.focus.mode === "focused") return exitFocus(s, doc, env, fx);
    return one && !one.removing ? command(s, { kind: "focus", itemId: one.id }, doc, env, fx) : s;
  }
  if (k.code === "BracketRight" || k.code === "BracketLeft") return command(s, { kind: "reorder", to: k.code === "BracketRight" ? "front" : "back" }, doc, env, fx);
  const tool = TOOLS.find((t) => t.key === k.key.toLowerCase() && t.available(s.capabilities) && toolAllowed(s, doc, t.id));
  return tool ? selectTool(s, toggled(s, tool.id)) : s;
}

function command(s: ViewState, c: Command, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  const center = { x: s.viewport.width / 2, y: s.viewport.height / 2 };
  switch (c.kind) {
    case "zoom-in": return userCamera(s, zoomAround(s.camera, ZOOM_STEP_IN, center), doc, fx);
    case "zoom-out": return userCamera(s, zoomAround(s.camera, ZOOM_STEP_OUT, center), doc, fx);
    case "zoom-100": return userCamera(s, zoomAround(s.camera, 1 / s.camera.z, center), doc, fx);
    case "fit-all": {
      if (s.focus.mode !== "none") return s;
      const cam = fitFor(s, doc, boundsOf(doc.items.map((i) => i.rect)));
      fx.push({ type: "publish-context" });
      return cam ? { ...s, camera: cam, autoFit: true } : { ...s, autoFit: true };
    }
    case "focus": return enterFocus(s, c.itemId, doc, env, fx);
    case "copy-image": { const it = copyableItem(s, doc); if (it) fx.push({ type: "copy-image", itemId: it.id }); return s; }
    case "exit-focus": return exitFocus(s, doc, env, fx);
    case "follow": { const n = { ...s, following: c.id }; return c.id && c.rect ? keepInView(n, c.rect, true, env, fx) : n; }
    case "locate": return keepInView({ ...s, following: null }, c.rect, true, env, fx);
    case "select-tool": return toolAllowed(s, doc, c.tool) ? selectTool(s, toggled(s, c.tool)) : s;
    case "open-thread": {
      const t = c.threadId ? doc.threadById.get(c.threadId) : undefined;
      if (!t) return { ...s, comment: closedComment(s) };
      let n: ViewState = { ...s, comment: { ...s.comment, draft: null, parkedDraft: s.comment.draft && s.comment.composing ? s.comment.draft : s.comment.parkedDraft, activeThreadId: t.id, expanded: true, editingCommentId: null, composing: false } };
      if (presenting(s, doc)) return s.focus.mode === "focused" && t.anchor.kind === "item" && t.anchor.itemId === s.focus.itemId ? n : s;
      const item = t.anchor.kind === "item" ? t.anchor.itemId : null;
      // A pin focus hides cannot be opened in place: leave focus first, and the return shows it.
      if (n.focus.mode === "focused" && n.focus.itemId !== item) return exitFocus(n, doc, env, fx);
      const p = threadPoint(t, (id) => doc.byId.get(id)?.rect);
      const v = viewportWorldRect(n.camera, n.viewport);
      if (p && n.focus.mode === "none" && !(p.x >= v.x && p.x <= v.x + v.w && p.y >= v.y && p.y <= v.y + v.h)) {
        const z = n.camera.z;
        n = animateTo({ ...n, autoFit: false }, { x: n.viewport.width / 2 - p.x * z, y: n.viewport.height / 2 - p.y * z, z }, "none", env, fx);
      }
      return n;
    }
    case "resolve-thread": {
      const t = doc.threadById.get(c.threadId);
      if (!t || isUnsaved(t) || t.resolved === c.resolved) return s;
      fx.push({ type: "submit", op: { type: "resolveThread", threadId: t.id, resolved: c.resolved } });
      // Resolving closes the card; reopening keeps it open.
      return c.resolved ? { ...s, comment: closedComment(s) } : s;
    }
    case "delete-comment": {
      const t = doc.threadById.get(c.threadId);
      if (!t || isUnsaved(t)) return s;
      fx.push({ type: "submit", op: { type: "removeComment", threadId: t.id, commentId: c.commentId } });
      return t.comments[0]?.id === c.commentId ? { ...s, comment: closedComment(s) } : s;
    }
    case "comments-panel": return { ...s, comment: { ...s.comment, panelOpen: c.open } };
    case "edit-comment": return presenting(s, doc) ? s : { ...s, comment: { ...s.comment, editingCommentId: c.commentId, composing: false } };
    case "comment-filter": return { ...s, comment: { ...s.comment, showResolved: c.showResolved } };
    case "delete":
      if (s.selection.kind === "stroke") { fx.push({ type: "submit", op: { type: "removeStroke", strokeId: s.selection.id } }); return { ...s, selection: items([]) }; }
      if (s.focus.mode === "none" && s.selection.ids.length) { fx.push({ type: "submit", op: { type: "removeItems", itemIds: s.selection.ids } }); return { ...s, selection: items([]), interacting: null }; }
      return s;
    case "reorder": {
      const ids = selectedIds(s).filter((id) => { const it = doc.byId.get(id); return it && !it.removing; });
      // Nothing to move means nothing to submit: core would refuse it as a no-op.
      if (ids.length && reorderedZ(doc.items, ids, c.to).size) fx.push({ type: "submit", op: { type: "reorderItems", itemIds: ids, to: c.to } });
      return s;
    }
    case "nudge": {
      if (s.focus.mode !== "none" || s.gesture || doc.layout !== "canvas") return s;
      const its = selectedIds(s).map((id) => doc.byId.get(id)).filter((it) => !!it && !it.removing);
      if (!its.length) return s;
      // One op per press: holding an arrow sends one move per repeat, each from the newest pending position.
      fx.push({ type: "submit", op: { type: "moveItems", moves: its.map((it) => ({ itemId: it!.id, x: it!.x + c.dx, y: it!.y + c.dy })) } });
      return s;
    }
    case "resize-by": {
      if (s.focus.mode !== "none" || s.gesture || s.selection.kind === "stroke" || doc.layout !== "canvas") return s;
      const its = selectedIds(s).map((id) => doc.byId.get(id)).filter((it) => !!it && !it.removing);
      if (!its.length) return s;
      const starts = new Map(its.map((it) => [it!.id, it!.rect]));
      const { box, limits } = groupBox([...starts.values()]);
      const handle: Handle = c.dw !== 0 ? "e" : "s";
      const to = resizeRect(box, handle, { x: c.dw, y: c.dh }, false, [], 0, limits).rect;
      const preview = new Map<ItemId, Placement>([...starts].map(([id, r]) => { const q = its.length === 1 ? to : scaleRect(r, box, to); return [id, { x: q.x, y: q.y, w: q.w, h: q.h }]; }));
      const op = geometryOp(starts, preview, doc);
      if (op) fx.push({ type: "submit", op });
      return s;
    }
    case "select-next": {
      const id = nextItem(s, doc, c.back);
      if (!id) return s;
      if (s.focus.mode === "focused") return enterFocus(s, id, doc, env, fx);
      return reveal({ ...s, selection: items([id]), interacting: null }, doc.byId.get(id)!.rect, env, fx);
    }
    case "zoom-to-selection": {
      if (s.focus.mode !== "none") return s;
      const rects = selectedIds(s).map((id) => doc.byId.get(id)?.rect).filter((r): r is Rect => !!r);
      const cam = fitAll(boundsOf(rects), s.viewport);
      return cam ? animateTo({ ...s, autoFit: false }, cam, "none", env, fx) : s;
    }
    case "undo": fx.push({ type: "undo" }); return s;
    case "redo": fx.push({ type: "redo" }); return s;
    case "pencil-color": return { ...s, pencil: { ...s.pencil, color: c.color } };
    case "pencil-size": return { ...s, pencil: { ...s.pencil, size: c.size } };
    case "invert-scroll": return { ...s, invertScroll: c.on };
    case "edit": return { ...s, editing: c.editing };
    case "pages-view": return pagesView(s, c.view, doc, env, fx);
  }
}

// ── Presentations and Documents ──

/** The auto-fit camera: fit all on a canvas, width fit from the top on pages. */
function fitFor(s: ViewState, doc: BaseDoc, bounds: Rect | null): Camera | null {
  return policy(s, doc).fit === "top" ? fitTop(bounds, s.viewport) : fitAll(bounds, s.viewport);
}

/** Pencil and Comment are unavailable where marks cannot be made (the grid, Present). */
const toolAllowed = (s: ViewState, doc: BaseDoc, tool: ToolId): boolean => policy(s, doc).marks || tool === "move" || tool === "hand";

/** Index of the presented slide, or of the page at the top of the view. */
export function presentIndex(s: ViewState, doc: BaseDoc): number {
  if (s.focus.mode !== "none") { const i = doc.items.findIndex((it) => it.id === (s.focus as { itemId: ItemId }).itemId); if (i >= 0) return i; }
  const v = viewportWorldRect(s.camera, s.viewport);
  const i = doc.items.findIndex((it) => it.rect.y + it.rect.h > v.y + 1 && it.rect.x + it.rect.w > v.x && it.rect.x < v.x + v.w);
  return Math.max(0, i);
}

/** The scroll camera that puts page `id` at the top, keeping the current zoom. Uses core's column placement, so it is
 *  right whichever arrangement the doc was read in. */
function scrollTo(s: ViewState, doc: BaseDoc, id: ItemId): ViewState {
  if (doc.layout === "canvas") return s;
  const i = doc.items.findIndex((it) => it.id === id);
  if (i < 0) return s;
  const r = scrollRect(doc.layout, i, s.viewport.width), z = s.camera.z, margin = s.viewport.width < 640 ? 24 : 96;
  return { ...s, autoFit: false, camera: { z, x: s.viewport.width / 2 - (r.x + r.w / 2) * z, y: Math.max(72, margin) - r.y * z } };
}

/** Back to the scroll camera. Focus taken in the grid is grid-placed, so it ends here rather than follow a page that moves. */
function leaveGrid(s: ViewState): ViewState {
  const r = s.pages.restore;
  return { ...s, pages: SCROLL, focus: { mode: "none" }, animation: null, ...(r ? { camera: r.camera, autoFit: r.autoFit } : {}) };
}

function pagesView(s: ViewState, view: PagesView, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  if (doc.layout === "canvas" || view === s.pages.view || s.gesture || s.editing) return s;
  fx.push({ type: "publish-context" });
  // Leave the current view first, so each target starts from the scroll view.
  let n = s.pages.view === "present" ? exitPresent(s, doc, fx) : s.pages.view === "grid" ? leaveGrid(s) : s;
  if (view === "scroll") {
    const selected = selectedIds(n).at(-1);
    return selected && doc.byId.has(selected) ? scrollTo(n, doc, selected) : n;
  }
  const restore = { camera: n.camera, autoFit: n.autoFit };
  if (view === "grid") {
    const count = doc.items.length;
    const bounds = boundsOf(Array.from({ length: count }, (_, i) => gridRect(doc.layout as "slides" | "a4", i, n.viewport.width)));
    const cam = fitTop(bounds, n.viewport);
    n = { ...selectTool(n, toolAllowed({ ...n, pages: { view: "grid", restore } }, doc, n.tool) ? n.tool : "move"), pages: { view: "grid", restore }, focus: { mode: "none" }, animation: null, autoFit: true };
    return cam ? { ...n, camera: cam } : n;
  }
  // Present: slides only, from the selected slide, else the first in view.
  if (doc.layout !== "slides" || !doc.items.length) return n;
  const sel = selectedIds(n);
  const start = sel.length === 1 && doc.byId.has(sel[0]!) ? sel[0]! : doc.items[presentIndex({ ...n, focus: { mode: "none" } }, doc)]!.id;
  // Present shows the stored column, so fit the slide's stored place, not its cell in the grid this doc may be arranged as.
  const r = pageRect("slides", doc.items.findIndex((x) => x.id === start));
  const rect = { x: r.x, y: r.y, w: r.width, h: r.height };
  n = { ...selectTool(n, "move"), pages: { view: "present", restore }, focus: { mode: "focused", itemId: start, restore }, autoFit: true,
    selection: items([start]), interacting: null, animation: null, shiftPanning: false, comment: { ...closedComment(n), draft: null, parkedDraft: null, panelOpen: false, restore: s.comment } };
  return { ...n, camera: fitExact(rect, n.viewport) };
}

function presentStep(s: ViewState, doc: BaseDoc, to: "next" | "prev" | "first" | "last"): ViewState {
  if (!presenting(s, doc) || s.focus.mode !== "focused" || !doc.items.length) return s;
  const i = presentIndex(s, doc), last = doc.items.length - 1;
  const j = to === "next" ? Math.min(last, i + 1) : to === "prev" ? Math.max(0, i - 1) : to === "first" ? 0 : last;
  if (j === i) return s;
  const it = doc.items[j]!;
  return { ...s, comment: closedComment(s), focus: { ...s.focus, itemId: it.id }, selection: items([it.id]), camera: fitExact(it.rect, s.viewport) };
}

/** Escape, the Scroll control, or leaving fullscreen: back to the scroll view on the slide shown last. */
function exitPresent(s: ViewState, doc: BaseDoc, fx: Effect[]): ViewState {
  const id = s.focus.mode === "focused" ? s.focus.itemId : null;
  const r = s.pages.restore;
  let n: ViewState = { ...s, comment: s.comment.restore ? { ...s.comment, ...s.comment.restore, restore: null } : closedComment(s), pages: SCROLL, focus: { mode: "none" }, animation: null, ...(r ? { camera: r.camera, autoFit: r.autoFit } : {}) };
  const c = n.comment;
  const alive = (draft: CommentDraft | null) => !draft || draft.anchor.kind === "world" || doc.byId.has(draft.anchor.itemId);
  if (!alive(c.parkedDraft)) n = { ...n, comment: { ...n.comment, parkedDraft: null } };
  if (!alive(c.draft)) n = { ...n, comment: { ...n.comment, draft: null, composing: false } };
  const active = c.activeThreadId ? doc.threadById.get(c.activeThreadId) : null;
  if (c.activeThreadId && (!active || (active.resolved && !c.showResolved))) n = { ...n, comment: closedComment(n) };
  if (c.editingCommentId && !active?.comments.some((comment) => comment.id === c.editingCommentId)) n = { ...n, comment: { ...n.comment, editingCommentId: null, composing: false } };
  fx.push({ type: "publish-context" });
  if (id && doc.byId.has(id)) {
    n = { ...n, selection: items([id]) };
    const v = viewportWorldRect(n.camera, n.viewport), rect = scrollRect(doc.layout as "slides" | "a4", doc.items.findIndex(it => it.id === id), n.viewport.width);
    if (!(rect.y >= v.y && rect.y + Math.min(rect.h, v.h) <= v.y + v.h)) n = scrollTo(n, doc, id);
  }
  return n;
}

/** Arrows with a selection: the previous or next page; in the grid, Up and Down move a row. */
function stepPage(s: ViewState, doc: BaseDoc, arrow: readonly [number, number], env: Env, fx: Effect[]): ViewState {
  if (doc.layout === "canvas" || !doc.items.length) return s;
  const cur = selectedIds(s).at(-1);
  const at = doc.items.findIndex((it) => it.id === cur);
  const row = s.pages.view === "grid" ? gridColumns(doc.layout, s.viewport.width) : 1;
  const delta = arrow[1] !== 0 ? arrow[1] * row : arrow[0];
  const j = Math.max(0, Math.min(doc.items.length - 1, (at < 0 ? 0 : at) + delta));
  const it = doc.items[j]!;
  return reveal({ ...s, selection: items([it.id]), interacting: null }, it.rect, env, fx);
}

/** Dropped or pasted images on a Presentation or Document become pages: after the page under the drop point, after the
 *  sole selected page for a paste, else at the end. One batch, so one undo step. */
function dropPages(s: ViewState, input: Extract<CanvasInput, { type: "drop-images" }>, doc: BaseDoc, env: Env, fx: Effect[]): ViewState {
  const live = doc.items.filter((it) => !it.removing);
  const sel = selectedIds(s);
  const target = input.at ? topItemAt(live, screenToWorld(input.at, s.camera)) : sel.length === 1 ? doc.byId.get(sel[0]!) ?? null : null;
  const ops: Operation[] = input.images.map((img) => ({ type: "addItem", item: { kind: "reference-image", id: env.newId(), title: img.title,
    width: img.width, height: img.height, assetHash: img.hash, mediaType: img.mediaType } }));
  const ids = ops.map((o) => (o as Extract<Operation, { type: "addItem" }>).item.id);
  const at = target ? doc.items.indexOf(target) + 1 : doc.items.length;
  if (at < doc.items.length) ops.push({ type: "reorderItems", itemIds: ids, to: { index: at } });
  fx.push({ type: "submit", op: ops.length === 1 ? ops[0]! : { type: "batch", ops } });
  return { ...s, autoFit: false, selection: items(ids), interacting: null };
}

// ── Frame presentation (CANVAS_WORKSPACE_SPEC §4, §6) ──

export interface FramePresentation {
  readonly selected: boolean; readonly multiSelected: boolean; readonly interacting: boolean; readonly focused: boolean;
  readonly hiddenByFocus: boolean; readonly input: "shield" | "page"; readonly showActions: boolean;
}
/**
 * The page takes pointer input only when it is a ready live snapshot and it is interacting, or the Move tool is
 * active without Shift and it is the sole selection or the focused item. Everything else gets the shield.
 */
export function presentFrame(item: { readonly id: ItemId; readonly kind: string; readonly width: number; readonly removing: boolean }, s: ViewState, ready: boolean): FramePresentation {
  const ids = selectedIds(s);
  const selected = ids.includes(item.id);
  const focusedId = s.focus.mode === "focused" ? s.focus.itemId : null;
  const focused = focusedId === item.id;
  // Only the scroll view (every canvas is in it) lets a page take input: in the grid a press reorders or opens, and Present steps.
  const page = item.kind === "html-snapshot" && ready && !item.removing && s.gesture === null && s.pages.view === "scroll" &&
    (s.interacting === item.id || (s.tool === "move" && !s.shiftPanning && ((selected && ids.length === 1) || focused)));
  return {
    selected: selected && ids.length === 1, multiSelected: selected && ids.length > 1, interacting: s.interacting === item.id, focused,
    hiddenByFocus: focusedId !== null && !focused, input: page ? "page" : "shield",
    showActions: s.tool !== "pencil" && (focused || selected || s.interacting === item.id || (s.camera.z >= 0.35 && item.width * s.camera.z >= 160)),
  };
}
