// Presentations and Documents in the canvas: which arrangement is shown, and the one table of per-view rules. Pure.
// Core places pages in one column (pageRect). The grid is a canvas-only arrangement of the same pages.

import { PAGE_GAP, PAGE_SIZE, type ItemId, type Layout, type PagedLayout, type Point, type Rect } from "@screens/core";
import type { BaseDoc, DisplayItem } from "./display.ts";
import type { Camera, Size } from "./camera.ts";
import { clampZoom } from "./camera.ts";

export type PagesView = "scroll" | "grid" | "present";
/** The view a paged Screen shows. restore: the scroll camera and auto-fit to return to after the grid or Present. */
export interface PagesState { readonly view: PagesView; readonly restore: { readonly camera: Camera; readonly autoFit: boolean } | null }
export const SCROLL: PagesState = { view: "scroll", restore: null };

/** World units between grid cells: wide enough at grid zoom for each page's title above it. */
export const GRID_GAP = 240;
/** Maximum columns at wide desktop sizes; compact windows use fewer columns. */
export const GRID_COLUMNS: { readonly [L in PagedLayout]: number } = { slides: 4, a4: 5 };
/** Slides kept rendered as posters on each side of the presented one, so a step shows a sharp poster at once. */
export const PRESENT_PRELOAD = 3;
/** Present's only key table. Escape goes through the escape chain. */
export const PRESENT_KEYS: Readonly<Record<string, "next" | "prev" | "first" | "last">> = {
  ArrowRight: "next", ArrowDown: "next", " ": "next", PageDown: "next", Enter: "next",
  ArrowLeft: "prev", ArrowUp: "prev", PageUp: "prev", Backspace: "prev",
  Home: "first", End: "last",
};

/** The one table of per-view behaviour. Gesture, key, render and fit code read it instead of branching on layout. */
export interface PagesPolicy {
  /** What a Move press and drag on an item does. */
  readonly drag: "move" | "reorder" | "pan";
  readonly handles: boolean;
  readonly snap: boolean;
  /** Pencil and Comment off any item: allowed on a canvas only. */
  readonly worldMarks: boolean;
  readonly marks: boolean;
  readonly fit: "all" | "top" | "exact";
  /** Edits, tool keys and undo keys act. False only while presenting. */
  readonly editable: boolean;
  /** Arrow keys with a selection: nudge on a canvas, step to the previous or next page otherwise. */
  readonly arrows: "nudge" | "step-page";
  /** Wheel without a modifier: free pan, or vertical only. */
  readonly wheel: "free" | "vertical";
}

const CANVAS: PagesPolicy = { drag: "move", handles: true, snap: true, worldMarks: true, marks: true, fit: "all", editable: true, arrows: "nudge", wheel: "free" };
const POLICY: Readonly<Record<PagesView, PagesPolicy>> = {
  scroll: { drag: "pan", handles: false, snap: false, worldMarks: false, marks: true, fit: "top", editable: true, arrows: "step-page", wheel: "vertical" },
  grid: { drag: "reorder", handles: false, snap: false, worldMarks: false, marks: false, fit: "top", editable: true, arrows: "step-page", wheel: "vertical" },
  present: { drag: "pan", handles: false, snap: false, worldMarks: false, marks: false, fit: "exact", editable: false, arrows: "step-page", wheel: "vertical" },
};
export const policyOf = (layout: Layout, view: PagesView): PagesPolicy => (layout === "canvas" ? CANVAS : POLICY[view]);

/** Grid cell of page `index`: full page size with viewport-dependent columns. */
export const gridColumns = (layout: PagedLayout, viewportWidth = 1280): number => Math.max(1, Math.min(GRID_COLUMNS[layout], Math.floor((viewportWidth - 32) / 240)));

export function gridRect(layout: PagedLayout, index: number, viewportWidth?: number): Rect {
  const { width, height } = PAGE_SIZE[layout], cols = gridColumns(layout, viewportWidth);
  return { x: (index % cols) * (width + GRID_GAP), y: Math.floor(index / cols) * (height + GRID_GAP), w: width, h: height };
}

export function scrollRect(layout: PagedLayout, index: number, viewportWidth = 1280): Rect {
  const { width, height } = PAGE_SIZE[layout];
  const margin = viewportWidth < 640 ? 24 : 96;
  const fitZoom = clampZoom(Math.min(1, (viewportWidth - 2 * margin) / width));
  const gap = Math.max(PAGE_GAP, 32 / fitZoom);
  return { x: 0, y: index * (height + gap), w: width, h: height };
}
/** Convert a displayed Scroll viewport to stored world units for agent context, compressing only the extra gaps. */
export function storedScrollViewport(layout: PagedLayout, viewport: Rect, viewportWidth: number): Rect {
  const height = PAGE_SIZE[layout].height;
  const stride = scrollRect(layout, 1, viewportWidth).y;
  const storedStride = height + PAGE_GAP;
  const mapY = (y: number) => {
    if (y < 0) return y;
    const index = Math.floor(y / stride), within = y - index * stride;
    return index * storedStride + (within <= height ? within : height + (within - height) * PAGE_GAP / (stride - height));
  };
  const y = mapY(viewport.y);
  return { ...viewport, y, h: mapY(viewport.y + viewport.h) - y };
}
const gridCache = new WeakMap<BaseDoc, Map<string, BaseDoc>>();
/** The arrangement the engine and shell read. Present keeps stored rects; Scroll reserves title clearance; Grid uses cells.
 *  Pins (item fractions) and strokes (item-relative points) follow their page. Nothing outside the canvas sees grid rects. */
export function shownDocOf(base: BaseDoc, view: PagesView, viewportWidth = 1280): BaseDoc {
  if (base.layout === "canvas" || view === "present") return base;
  const cols = `${view}:${view === "grid" ? gridColumns(base.layout, viewportWidth) : viewportWidth}`;
  const hit = gridCache.get(base)?.get(cols);
  if (hit) return hit;
  const layout = base.layout;
  const items = base.items.map((it, i): DisplayItem => { const r = view === "grid" ? gridRect(layout, i, viewportWidth) : scrollRect(layout, i, viewportWidth); return { ...it, x: r.x, y: r.y, rect: r }; });
  const shown = { ...base, items, byId: new Map(items.map((i) => [i.id, i])) };
  const cached = gridCache.get(base) ?? new Map<string, BaseDoc>();
  cached.set(cols, shown); gridCache.set(base, cached);
  return shown;
}

/**
 * Insertion slot for a world point over the grid, counted among the pages not being dragged: the cell under the point,
 * before or after it by its horizontal half. That count is exactly reorderItems' { index }, so a drag down has no
 * off-by-one, and the canvas and MCP share one meaning.
 */
export function slotAmong(layout: PagedLayout, items: readonly { readonly id: ItemId }[], moving: ReadonlySet<ItemId>, world: Point, viewportWidth?: number): number {
  const { width, height } = PAGE_SIZE[layout], cols = gridColumns(layout, viewportWidth);
  const col = Math.max(0, Math.min(cols - 1, Math.floor(world.x / (width + GRID_GAP))));
  const row = Math.max(0, Math.floor(world.y / (height + GRID_GAP)));
  const after = world.x - col * (width + GRID_GAP) > width / 2;
  const cell = Math.min(items.length, row * cols + col + (after ? 1 : 0));
  // Slots before `cell`, not counting the dragged pages.
  let slot = 0;
  for (let i = 0; i < cell; i++) if (!moving.has(items[i]!.id)) slot++;
  return slot;
}

/** Where the insertion bar goes for `slot`: centred in the gap before the slot-th page that is not moving, or after the
 *  last one. x is the bar's centre; the shell draws it a few screen pixels wide. */
export function slotBar(layout: PagedLayout, items: readonly { readonly id: ItemId }[], moving: ReadonlySet<ItemId>, slot: number, viewportWidth?: number): { readonly x: number; readonly y: number; readonly h: number } {
  const rest = items.map((it, i) => ({ it, i })).filter(({ it }) => !moving.has(it.id));
  const at = rest[slot]?.i, last = rest.at(-1)?.i;
  if (at === undefined && last !== undefined) { const r = gridRect(layout, last, viewportWidth); return { x: r.x + r.w + GRID_GAP / 2, y: r.y, h: r.h }; }
  const r = gridRect(layout, at ?? 0, viewportWidth);
  return { x: r.x - GRID_GAP / 2, y: r.y, h: r.h };
}

/** Width fit, never past 100%, first page's top at the margin. Independent of page count, so auto-fit never shrinks a
 *  long document as pages are added. */
export function fitTop(bounds: Rect | null, v: Size): Camera | null {
  if (!bounds) return null;
  const p = v.width < 640 ? 24 : 96;
  const z = clampZoom(Math.min(1, (v.width - 2 * p) / Math.max(1, bounds.w)));
  return { z, x: v.width / 2 - (bounds.x + bounds.w / 2) * z, y: Math.max(72, p) - bounds.y * z };
}

/** Present: the slide fills the viewport, no margin. */
export function fitExact(r: Rect, v: Size): Camera {
  const z = clampZoom(Math.min(v.width / Math.max(1, r.w), v.height / Math.max(1, r.h)));
  return { z, x: v.width / 2 - (r.x + r.w / 2) * z, y: v.height / 2 - (r.y + r.h / 2) * z };
}
