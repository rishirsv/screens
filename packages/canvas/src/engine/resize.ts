// Resize-handle geometry: which edges a handle moves, aspect, minimum size and edge snapping. Pure.

import { ITEM_SIZE_MAX, type Point, type Rect } from "@screens/core";
import { GUIDE_EPSILON, type Guide } from "./snap.ts";

export type Handle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
/** Smallest frame a handle makes, in world units. Core allows 1; a frame this small is still grabbable. */
export const RESIZE_MIN = 24;

const isCorner = (h: Handle) => h.length === 2;
/** -1 moves the left (top) edge, 1 the right (bottom) edge, 0 neither. */
const sx = (h: Handle) => (h.includes("w") ? -1 : h.includes("e") ? 1 : 0);
const sy = (h: Handle) => (h.includes("n") ? -1 : h.includes("s") ? 1 : 0);

/** Corner handles keep the aspect when the resized items include a reference image, unless Shift; everything else is
 *  free unless Shift. */
export const keepsAspect = (kinds: readonly string[], h: Handle, shift: boolean): boolean => (kinds.includes("reference-image") && isCorner(h)) !== shift;

/** Size bounds for the box a handle resizes, in world units. */
export interface SizeLimits { readonly minW: number; readonly minH: number; readonly maxW: number; readonly maxH: number }

/** The bounds of `rects` and how far that box may shrink or grow so every rect, scaled with it, stays within
 *  [RESIZE_MIN, ITEM_SIZE_MAX]. One rect gives exactly those limits. */
export function groupBox(rects: readonly Rect[]): { box: Rect; limits: SizeLimits } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, minW = Infinity, minH = Infinity, maxW = 0, maxH = 0;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    minW = Math.min(minW, r.w); minH = Math.min(minH, r.h); maxW = Math.max(maxW, r.w); maxH = Math.max(maxH, r.h);
  }
  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (rects.length === 1) return { box, limits: { minW: RESIZE_MIN, minH: RESIZE_MIN, maxW: ITEM_SIZE_MAX, maxH: ITEM_SIZE_MAX } };
  // The smallest rect reaches RESIZE_MIN (rounded up, so rounding never takes it below) and the largest ITEM_SIZE_MAX.
  return { box, limits: {
    minW: Math.ceil(box.w * RESIZE_MIN / minW), minH: Math.ceil(box.h * RESIZE_MIN / minH),
    maxW: Math.floor(box.w * ITEM_SIZE_MAX / maxW), maxH: Math.floor(box.h * ITEM_SIZE_MAX / maxH),
  } };
}

/** `r` placed in `to` where it sat in `from`, scaled with it. Edges round to whole units, so items that touched still touch. */
export function scaleRect(r: Rect, from: Rect, to: Rect): Rect {
  const fx = to.w / from.w, fy = to.h / from.h;
  const x0 = Math.round(to.x + (r.x - from.x) * fx), x1 = Math.round(to.x + (r.x + r.w - from.x) * fx);
  const y0 = Math.round(to.y + (r.y - from.y) * fy), y1 = Math.round(to.y + (r.y + r.h - from.y) * fy);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/**
 * The rect a handle drag gives: only the handle's edges move, by `delta` world units, and the opposite edge or corner
 * stays put. Sizes clamp to `limits` ([RESIZE_MIN, ITEM_SIZE_MAX] by default). With keepAspect, a corner follows whichever axis grew or shrank
 * more, and an edge handle grows the other side around the centre. Snapping (targets non-empty) pulls the moving edges
 * to target edges and centres within `threshold`; under aspect, the leading axis keeps its snap and the other follows.
 * Rounded to whole units.
 */
export function resizeRect(start: Rect, h: Handle, delta: Point, keepAspect: boolean, targets: readonly Rect[], threshold: number,
  limits: SizeLimits = { minW: RESIZE_MIN, minH: RESIZE_MIN, maxW: ITEM_SIZE_MAX, maxH: ITEM_SIZE_MAX }): { rect: Rect; guides: Guide[] } {
  const ax = sx(h), ay = sy(h);
  const clampW = (v: number) => Math.min(limits.maxW, Math.max(limits.minW, v)), clampH = (v: number) => Math.min(limits.maxH, Math.max(limits.minH, v));
  // Moving edge positions, snapped.
  let ex = ax > 0 ? start.x + start.w + delta.x : ax < 0 ? start.x + delta.x : null;
  let ey = ay > 0 ? start.y + start.h + delta.y : ay < 0 ? start.y + delta.y : null;
  if (targets.length) {
    if (ex !== null) ex += nearest(ex, targets, (t) => [t.x, t.x + t.w / 2, t.x + t.w], threshold);
    if (ey !== null) ey += nearest(ey, targets, (t) => [t.y, t.y + t.h / 2, t.y + t.h], threshold);
  }
  let w = ex === null ? start.w : clampW(ax > 0 ? ex - start.x : start.x + start.w - ex);
  let hh = ey === null ? start.h : clampH(ay > 0 ? ey - start.y : start.y + start.h - ey);
  if (keepAspect) {
    const ratio = start.w / start.h;
    // The leading axis: the only one an edge handle moves, or the one a corner changed more, relative to its size.
    const widthLeads = ay === 0 || (ax !== 0 && Math.abs(w / start.w - 1) >= Math.abs(hh / start.h - 1));
    if (widthLeads) { hh = clampH(w / ratio); w = clampW(hh * ratio); } else { w = clampW(hh * ratio); hh = clampH(w / ratio); }
  }
  w = Math.round(w); hh = Math.round(hh);
  // Anchor: the edge opposite each moving edge stays; an axis the handle does not move stays, or centres under aspect.
  const x = ax > 0 ? start.x : ax < 0 ? start.x + start.w - w : keepAspect ? Math.round(start.x + (start.w - w) / 2) : start.x;
  const y = ay > 0 ? start.y : ay < 0 ? start.y + start.h - hh : keepAspect ? Math.round(start.y + (start.h - hh) / 2) : start.y;
  const rect: Rect = { x, y, w, h: hh };
  return { rect, guides: targets.length ? edgeGuides(rect, ax, ay, targets) : [] };
}

function nearest(v: number, targets: readonly Rect[], of: (t: Rect) => number[], threshold: number): number {
  let off = 0, dist = Infinity;
  for (const t of targets) for (const p of of(t)) { const d = p - v; if (Math.abs(d) <= threshold && Math.abs(d) < dist) { dist = Math.abs(d); off = d; } }
  return off;
}

function edgeGuides(r: Rect, ax: number, ay: number, targets: readonly Rect[]): Guide[] {
  const out: Guide[] = [];
  const ex = ax > 0 ? r.x + r.w : ax < 0 ? r.x : null, ey = ay > 0 ? r.y + r.h : ay < 0 ? r.y : null;
  for (const t of targets) {
    if (ex !== null && [t.x, t.x + t.w / 2, t.x + t.w].some((v) => Math.abs(v - ex) < GUIDE_EPSILON))
      out.push({ axis: "x", pos: ex, start: Math.min(r.y, t.y), end: Math.max(r.y + r.h, t.y + t.h) });
    if (ey !== null && [t.y, t.y + t.h / 2, t.y + t.h].some((v) => Math.abs(v - ey) < GUIDE_EPSILON))
      out.push({ axis: "y", pos: ey, start: Math.min(r.x, t.x), end: Math.max(r.x + r.w, t.x + t.w) });
  }
  return out;
}
