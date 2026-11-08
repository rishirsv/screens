// Camera math (CANVAS_WORKSPACE_SPEC §5). screen = camera + world·z. Pure.

import type { Point, Rect } from "@screens/core";

export interface Camera { readonly x: number; readonly y: number; readonly z: number }
export interface Size { readonly width: number; readonly height: number }

export const ZOOM_MIN = 0.05, ZOOM_MAX = 8, ZOOM_STEP_IN = 1.25, ZOOM_STEP_OUT = 0.8, WHEEL_ZOOM_K = 0.01;
export const FOCUS_ANIM_MS = 360;
export const CAMERA_SETTLE_MS = 200;

export const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
export const screenToWorld = (p: Point, c: Camera): Point => ({ x: (p.x - c.x) / c.z, y: (p.y - c.y) / c.z });
export const worldToScreen = (p: Point, c: Camera): Point => ({ x: c.x + p.x * c.z, y: c.y + p.y * c.z });

/** Keeps the world point under `anchor` fixed. */
export function zoomAround(c: Camera, k: number, anchor: Point): Camera {
  const z = clampZoom(c.z * k), r = z / c.z;
  return { x: anchor.x - (anchor.x - c.x) * r, y: anchor.y - (anchor.y - c.y) * r, z };
}
/** Screen pixels, never divided by zoom (POINTER_HAND_PEN_SPEC §5). */
export const pan = (c: Camera, dx: number, dy: number): Camera => ({ x: c.x + dx, y: c.y + dy, z: c.z });

export const viewportWorldRect = (c: Camera, v: Size): Rect => ({ x: -c.x / c.z, y: -c.y / c.z, w: v.width / c.z, h: v.height / c.z });

/** Margin 24 below 640 px wide, else 96; never enlarges past 100%. Null for empty bounds. */
export function fitAll(b: Rect | null, v: Size): Camera | null {
  if (!b) return null;
  const p = v.width < 640 ? 24 : 96;
  const z = clampZoom(Math.min(1, (v.width - 2 * p) / Math.max(1, b.w), (v.height - 2 * p) / Math.max(1, b.h)));
  return { z, x: v.width / 2 - (b.x + b.w / 2) * z, y: v.height / 2 - (b.y + b.h / 2) * z };
}

/** Focus fit: margin 16 below 700 px wide, else 48; capped at 2. Scroll fits tall objects to width, up to 100%, starting at the top.
 *  An explicit zoom/offset keeps the person's adjustment, clamped to the item. */
export function fitItem(r: Rect, v: Size, { zoom, offset, fit = "contain" }: { readonly zoom?: number; readonly offset?: Point; readonly fit?: "contain" | "scroll" } = {}): Camera {
  const m = v.width < 700 ? 16 : 48;
  const width = (v.width - 2 * m) / Math.max(1, r.w), height = (v.height - 2 * m) / Math.max(1, r.h);
  const contain = Math.min(2, width, height);
  const z = clampZoom(zoom ?? (fit === "scroll" ? Math.max(contain, Math.min(1, width)) : contain));
  const cx = v.width / 2 - (r.x + r.w / 2) * z, cy = v.height / 2 - (r.y + r.h / 2) * z;
  if (!offset) return { x: cx, y: fit === "scroll" && zoom === undefined && r.h * z > v.height - 2 * m ? m - r.y * z : cy, z };
  const lim = (scaled: number, view: number) => Math.max(0, (scaled - view) / 2 + 48);
  const lx = lim(r.w * z, v.width), ly = lim(r.h * z, v.height);
  return { z, x: cx + Math.max(-lx, Math.min(lx, offset.x)), y: cy + Math.max(-ly, Math.min(ly, offset.y)) };
}

/** cubic-bezier(0.22, 1, 0.36, 1), solved for x = t. */
export function focusEase(t: number): number {
  if (t <= 0) return 0; if (t >= 1) return 1;
  const [x1, y1, x2, y2] = [0.22, 1, 0.36, 1];
  const bx = (s: number) => 3 * x1 * s * (1 - s) ** 2 + 3 * x2 * s * s * (1 - s) + s ** 3;
  const by = (s: number) => 3 * y1 * s * (1 - s) ** 2 + 3 * y2 * s * s * (1 - s) + s ** 3;
  let lo = 0, hi = 1, s = t;
  for (let i = 0; i < 30; i++) { s = (lo + hi) / 2; if (bx(s) < t) lo = s; else hi = s; }
  return by(s);
}

export function lerpCamera(a: Camera, b: Camera, t: number): Camera {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}
