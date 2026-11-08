// Where a comment pin is. The only code that maps between a stored thread position and a world point.
// The canvas passes its display rects (so pins ride along in drag previews); MCP and screens-cli pass docRects(doc).

import type { ItemId, Point, Rect, ScreenDoc, ThreadAnchor, ThreadArea } from "./model.ts";

export interface ThreadPosition { readonly anchor: ThreadAnchor; readonly x: number; readonly y: number; readonly area?: ThreadArea }

/** World point of a pin's tip. null only while its item is missing from `rectOf`. */
export function threadPoint(p: ThreadPosition, rectOf: (id: ItemId) => Rect | undefined): Point | null {
  if (p.anchor.kind === "world") return { x: p.x, y: p.y };
  const r = rectOf(p.anchor.itemId);
  return r ? { x: r.x + p.x * r.w, y: r.y + p.y * r.h } : null;
}

/** The position for a world point: normalized on `on` when given, else the world. */
export function positionAt(world: Point, on: { readonly itemId: ItemId; readonly rect: Rect } | null): ThreadPosition {
  if (!on) return { anchor: { kind: "world" }, x: round(world.x, 2), y: round(world.y, 2) };
  const r = on.rect;
  return { anchor: { kind: "item", itemId: on.itemId }, x: clamp01(round((world.x - r.x) / r.w, 6)), y: clamp01(round((world.y - r.y) / r.h, 6)) };
}

/** World rect of a thread's circled region. null without an area, or while its item is missing from `rectOf`. */
export function threadArea(p: ThreadPosition, rectOf: (id: ItemId) => Rect | undefined): Rect | null {
  if (!p.area) return null;
  const at = threadPoint(p, rectOf);
  if (!at) return null;
  if (p.anchor.kind === "world") return { x: at.x, y: at.y, w: p.area.w, h: p.area.h };
  const r = rectOf(p.anchor.itemId)!;
  return { x: at.x, y: at.y, w: p.area.w * r.w, h: p.area.h * r.h };
}

/** The position for a world rect drawn around a region: the pin at its top-left, the area its size, on `on` when given. */
export function areaAt(world: Rect, on: { readonly itemId: ItemId; readonly rect: Rect } | null): ThreadPosition {
  const at = positionAt({ x: world.x, y: world.y }, on);
  if (!on) return { ...at, area: { w: round(world.w, 2), h: round(world.h, 2) } };
  const r = on.rect;
  return { ...at, area: { w: clamp01(round(Math.min(world.w, r.x + r.w - world.x) / r.w, 6)), h: clamp01(round(Math.min(world.h, r.y + r.h - world.y) / r.h, 6)) } };
}

/** A circled area moved from one anchor to another, keeping its world size. Unchanged while either item's size is unknown. */
export function reanchorArea(area: ThreadArea, from: ThreadAnchor, to: ThreadAnchor, sizeOf: (id: ItemId) => { readonly w: number; readonly h: number } | undefined): ThreadArea {
  const size = (a: ThreadAnchor) => (a.kind === "world" ? { w: 1, h: 1 } : sizeOf(a.itemId));
  const a = size(from), b = size(to);
  if (!a || !b) return area;
  const r = (v: number) => Math.max(1e-6, Math.round(v * 1e6) / 1e6);
  return { w: r(area.w * a.w / b.w), h: r(area.h * a.h / b.h) };
}

/** Committed item rects, for threadPoint over a ScreenDoc. */
export function docRects(doc: ScreenDoc): (id: ItemId) => Rect | undefined {
  return (id) => { const it = doc.items[id]; return it ? { x: it.x, y: it.y, w: it.width, h: it.height } : undefined; };
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
/** Rounding at an edge may step a hair outside [0, 1]. */
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
