// Montage: where every item and stroke of a Screen lands in one overview image. Pure.
// The service draws the plan from stored posters; the legend is what lets an agent zoom (rect) or open one item.

import type { CanvasItem, ItemId, Rect, ScreenDoc, StrokeId, StrokePoint } from "./model.ts";
import { byStack } from "./pages.ts";

/** Output pixels of the longest side: the default, and the range a caller may ask for. */
export const MONTAGE_SIZE = 1600, MONTAGE_SIZE_MIN = 200, MONTAGE_SIZE_MAX = 4096;
/** Output pixels around the default region, so the labels above the top row fit. */
export const MONTAGE_PAD = 28;

export interface MontageItem {
  readonly id: ItemId;
  readonly title: string;
  readonly kind: CanvasItem["kind"];
  /** Where the item sits in the image, in image pixels: x0 = (item.x - world.x) * scale. May extend past the image. */
  readonly at: Rect;
  /** The part inside the image, rounded to whole pixels. This is the legend. */
  readonly visible: Rect;
  readonly partial: boolean;
}
export interface MontageStroke {
  readonly id: StrokeId;
  readonly points: readonly StrokePoint[];
  readonly size: number;
  readonly color: string;
  /** World origin of the points: (0, 0) for a world stroke, the item's x/y for an item stroke. */
  readonly origin: { readonly x: number; readonly y: number };
  /** World rect an item stroke is clipped to (its item), as the canvas does. */
  readonly clip: Rect | null;
}
export interface MontagePlan {
  /** The world region the whole image covers. image px = (world px - world.x) * scale. */
  readonly world: Rect;
  readonly scale: number;
  readonly width: number;
  readonly height: number;
  /** Back to front: the drawing order. */
  readonly items: readonly MontageItem[];
  /** Only strokes that reach into the region, counting their width. */
  readonly strokes: readonly MontageStroke[];
}

/** rect: the world region to show (default: every item and stroke, with room for labels). maxSize caps the longest side.
 *  Never scales above 1: past that a poster has nothing more to show, and get_poster is the full view. null: nothing to show. */
export function planMontage(doc: ScreenDoc, o: { readonly rect?: Rect; readonly maxSize?: number } = {}): MontagePlan | null {
  const max = Math.round(Math.min(MONTAGE_SIZE_MAX, Math.max(MONTAGE_SIZE_MIN, o.maxSize ?? MONTAGE_SIZE)));
  const items = Object.values(doc.items).sort(byStack);
  const strokes = Object.values(doc.strokes).filter((s) => s.points.length && (s.anchor.kind === "world" || doc.items[s.anchor.itemId]));
  const region = o.rect ?? contentBounds(items, strokes);
  if (!region || !(region.w > 0) || !(region.h > 0)) return null;
  const pad = o.rect ? 0 : MONTAGE_PAD;
  const scale = Math.min(1, (max - 2 * pad) / region.w, (max - 2 * pad) / region.h);
  const world = { x: region.x - pad / scale, y: region.y - pad / scale, w: region.w + 2 * pad / scale, h: region.h + 2 * pad / scale };
  const width = Math.max(1, Math.min(max, Math.round(world.w * scale))), height = Math.max(1, Math.min(max, Math.round(world.h * scale)));
  const placed: MontageItem[] = [];
  for (const it of items) {
    const at = { x: (it.x - world.x) * scale, y: (it.y - world.y) * scale, w: it.width * scale, h: it.height * scale };
    const x0 = Math.max(0, Math.round(at.x)), y0 = Math.max(0, Math.round(at.y));
    const x1 = Math.min(width, Math.round(at.x + at.w)), y1 = Math.min(height, Math.round(at.y + at.h));
    if (x1 <= x0 || y1 <= y0) continue;
    const partial = at.x < -0.5 || at.y < -0.5 || at.x + at.w > width + 0.5 || at.y + at.h > height + 0.5;
    placed.push({ id: it.id, title: it.title, kind: it.kind, at, visible: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, partial });
  }
  const drawn = strokes.flatMap((s): MontageStroke[] => {
    const it = s.anchor.kind === "item" ? doc.items[s.anchor.itemId]! : null;
    const m = { id: s.id, points: s.points, size: s.size, color: s.color, origin: it ? { x: it.x, y: it.y } : { x: 0, y: 0 },
      clip: it ? { x: it.x, y: it.y, w: it.width, h: it.height } : null };
    const area = m.clip ? intersect(world, m.clip) : world;
    return area && strokeTouches(m, area) ? [m] : [];
  });
  return { world, scale, width, height, items: placed, strokes: drawn };
}

const intersect = (a: Rect, b: Rect): Rect | null => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y), x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
};

/** Whether any segment of the stroke, widened by half its size, reaches into r. Segments, not just points: a stroke can
 *  cross a region with no sampled point inside it. */
function strokeTouches(s: MontageStroke, r: Rect): boolean {
  const h = s.size / 2, x0 = r.x - h, y0 = r.y - h, x1 = r.x + r.w + h, y1 = r.y + r.h + h;
  const pts = s.points.map(([x, y]) => [s.origin.x + x, s.origin.y + y] as const);
  if (pts.length === 1) pts.push(pts[0]!);
  for (let i = 1; i < pts.length; i++) {
    // Liang–Barsky: clip the segment to the widened rect; it touches when some part survives.
    const [ax, ay] = pts[i - 1]!, [bx, by] = pts[i]!, dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, hit = true;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]] as const) {
      if (p === 0) { if (q < 0) { hit = false; break; } continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) { hit = false; break; } if (t > t0) t0 = t; }
      else { if (t < t0) { hit = false; break; } if (t < t1) t1 = t; }
    }
    if (hit) return true;
  }
  return false;
}

/** Every item, plus world strokes (item strokes stay inside their item). */
function contentBounds(items: readonly CanvasItem[], strokes: readonly ScreenDoc["strokes"][string][]): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) { x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); x1 = Math.max(x1, it.x + it.width); y1 = Math.max(y1, it.y + it.height); }
  for (const s of strokes) {
    if (s.anchor.kind !== "world") continue;
    const h = s.size / 2;
    for (const [x, y] of s.points) { x0 = Math.min(x0, x - h); y0 = Math.min(y0, y - h); x1 = Math.max(x1, x + h); y1 = Math.max(y1, y + h); }
  }
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
