// Lead-frame snapping and guides (POINTER_HAND_PEN_SPEC §4.2). Pure.

import type { Rect } from "@screens/core";

export const SNAP_SCREEN_PX = 8;
export const GUIDE_EPSILON = 0.5;
export interface Guide { readonly axis: "x" | "y"; readonly pos: number; readonly start: number; readonly end: number }

const xs = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
const ys = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];

/**
 * Snaps only the lead rect; the caller applies (dx, dy) to the whole group and rounds afterwards.
 * Each axis takes the nearest offset with |offset| ≤ threshold; strict < keeps the first found on ties.
 */
export function snapLead(lead: Rect, targets: readonly Rect[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const best = (from: number[], tos: (r: Rect) => number[]) => {
    let off = 0, dist = Infinity;
    for (const t of targets) for (const l of from) for (const v of tos(t)) {
      const d = v - l;
      if (Math.abs(d) <= threshold && Math.abs(d) < dist) { dist = Math.abs(d); off = d; }
    }
    return off;
  };
  const dx = best(xs(lead), xs), dy = best(ys(lead), ys);
  const s: Rect = { x: lead.x + dx, y: lead.y + dy, w: lead.w, h: lead.h };
  const guides: Guide[] = [];
  for (const t of targets) {
    for (const l of xs(s)) if (xs(t).some((v) => Math.abs(v - l) < GUIDE_EPSILON))
      guides.push({ axis: "x", pos: l, start: Math.min(s.y, t.y), end: Math.max(s.y + s.h, t.y + t.h) });
    for (const l of ys(s)) if (ys(t).some((v) => Math.abs(v - l) < GUIDE_EPSILON))
      guides.push({ axis: "y", pos: l, start: Math.min(s.x, t.x), end: Math.max(s.x + s.w, t.x + t.w) });
  }
  return { dx, dy, guides };
}
