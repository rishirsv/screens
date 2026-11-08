// Rectangles, hit testing and the one item order. Pure.

import type { Point, Rect } from "@screens/core";

/** Strict overlap: touching edges do not count (marquee, scheduler). */
export const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Inclusive containment (pencil anchoring). */
export const containsPoint = (r: Rect, p: Point): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
export const normalizedRect = (a: Point, b: Point): Rect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
export function boundsOf(rs: readonly Rect[]): Rect | null {
  if (rs.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rs) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
/** THE item order: ascending z, then ascending id. Render order, hit order and pencil anchoring all use it. */
export function sortItems<T extends { readonly z: number; readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** Topmost item (last in sortItems order) whose rect contains p, inclusive. */
export function topItemAt<T extends { readonly z: number; readonly id: string; readonly rect: Rect }>(sorted: readonly T[], p: Point): T | null {
  for (let i = sorted.length - 1; i >= 0; i--) if (containsPoint(sorted[i]!.rect, p)) return sorted[i]!;
  return null;
}
