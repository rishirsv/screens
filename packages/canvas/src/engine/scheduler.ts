// Which snapshot frames are live (CANVAS_WORKSPACE_SPEC §8). Starting values, not measured budgets.

import type { ItemId } from "@screens/core";
import { viewportWorldRect, type Camera, type Size } from "./camera.ts";
import { intersects, overlapArea } from "./geometry.ts";
import type { DisplayItem } from "./display.ts";

export const LIVE_POLICY = {
  fine: { cap: 16, minPosterWidthPx: 160, pixelBudget: Infinity },
  coarse: { cap: 6, minPosterWidthPx: 320, pixelBudget: 12e6 },
} as const;
export const MAX_STARTS_PER_PASS = 2, LIVE_RETRY_MS = 150;
/** A completed batch may yield briefly before the next pair; slow batches retain the ordinary retry. */
export const READY_RETRY_MS = 16;

export interface LiveInputs {
  readonly items: readonly DisplayItem[]; readonly camera: Camera; readonly viewport: Size; readonly dpr: number;
  readonly pointer: "fine" | "coarse"; readonly previous: ReadonlySet<ItemId>; readonly interacting: ItemId | null; readonly focused: ItemId | null;
  /** Present: only the presented slide is live, so slides already shown do not keep running. */
  readonly presenting?: boolean;
}

/**
 * New candidates must intersect 1.5× the viewport, previously live ones 3×. Score = overlap × (wasLive ? 1.5 : 1).
 * Up to `cap`, at most 2 new starts per pass (retry after 150 ms). Interacting and focused frames are forced in,
 * so cap + 1 live frames is a documented exception, not a bug.
 */
export function rankLiveFrames(i: LiveInputs): { live: Set<ItemId>; retryAfterMs: number | null } {
  const pol = LIVE_POLICY[i.pointer];
  const html = i.items.filter((it) => it.kind === "html-snapshot" && !it.removing);
  if (i.focused && i.presenting) return { live: new Set(html.some((h) => h.id === i.focused) ? [i.focused] : []), retryAfterMs: null };
  if (i.focused) {
    const live = new Set([...i.previous].filter((id) => html.some((h) => h.id === id)));
    if (html.some((h) => h.id === i.focused)) live.add(i.focused);
    return { live, retryAfterMs: null };
  }
  const v = viewportWorldRect(i.camera, i.viewport);
  const grow = (k: number) => ({ x: v.x - v.w * k, y: v.y - v.h * k, w: v.w * (1 + 2 * k), h: v.h * (1 + 2 * k) });
  const near = grow(0.25), far = grow(1);
  const ranked = html
    .filter((it) => (!it.posterHash || it.width * i.camera.z >= pol.minPosterWidthPx) && intersects(it.rect, i.previous.has(it.id) ? far : near))
    .map((it) => ({ it, was: i.previous.has(it.id), score: overlapArea(it.rect, v) * (i.previous.has(it.id) ? 1.5 : 1) }))
    .sort((a, b) => b.score - a.score || Number(b.was) - Number(a.was) || b.it.width * b.it.height - a.it.width * a.it.height);
  const live = new Set<ItemId>();
  let pixels = 0, starts = 0, retry = false;
  for (const r of ranked) {
    if (live.size >= pol.cap) break;
    const px = r.it.width * r.it.height * i.camera.z ** 2 * i.dpr ** 2;
    if (live.size > 0 && pixels + px > pol.pixelBudget) continue;
    if (!r.was) { if (starts >= MAX_STARTS_PER_PASS) { retry = true; continue; } starts++; }
    live.add(r.it.id); pixels += px;
  }
  if (i.interacting && html.some((h) => h.id === i.interacting)) live.add(i.interacting);
  return { live, retryAfterMs: retry ? LIVE_RETRY_MS : null };
}
