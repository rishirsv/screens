// Stroke outline and bounds (POINTER_HAND_PEN_SPEC §6.3). Pure.
// The outline uses perfect-freehand (MIT) with the reference settings. That it matches the
// reference bundle's compiled function is an inference until golden-trace comparison.

import { getStroke } from "perfect-freehand";
import type { Rect, StrokePoint } from "@screens/core";

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export function strokePath(points: readonly StrokePoint[], size: number): string {
  const simulatePressure = points.every((p) => p[2] === points[0]![2]);
  const outline = getStroke(points.map((p) => [p[0], p[1], p[2]]), { size, thinning: 0.6, smoothing: 0.5, streamline: 0.5, last: true, simulatePressure });
  if (outline.length < 2) return "";
  // Closed quadratic path through outline points and their midpoints.
  const f = (n: number) => round2(n);
  let d = `M${f(outline[0]![0]!)},${f(outline[0]![1]!)} Q`;
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i]!, [x1, y1] = outline[(i + 1) % outline.length]!;
    d += `${f(x0!)},${f(y0!)} ${f((x0! + x1!) / 2)},${f((y0! + y1!) / 2)} `;
  }
  return d + "Z";
}

/** Min/max of points extended by size/2. */
export function strokeBounds(points: readonly StrokePoint[], size: number): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const h = size / 2;
  return { x: x0 - h, y: y0 - h, w: x1 - x0 + size, h: y1 - y0 + size };
}
