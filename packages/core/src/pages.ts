// Pages: the one placement rule for Presentations and Documents. Core's relayout and the canvas pending preview both
// use it, so a page is always where core will commit it. Pure.

import type { ItemId, PagedLayout } from "./model.ts";

/** Keyed by layout, so a new layout fails to compile until it has a size. */
export const PAGE_SIZE: { readonly [L in PagedLayout]: { readonly width: number; readonly height: number } } = {
  slides: { width: 1920, height: 1080 },
  a4: { width: 794, height: 1123 },
};
export const PAGED_LAYOUTS = Object.keys(PAGE_SIZE) as readonly PagedLayout[];
/** World units between pages. A starting value. */
export const PAGE_GAP = 64;

export const isPagedLayout = (v: unknown): v is PagedLayout => typeof v === "string" && (PAGED_LAYOUTS as readonly string[]).includes(v);

/** The single item order: ascending z, then id. reorderedZ, rendering, hit-testing and page placement all use it. */
export function byStack(a: { readonly id: ItemId; readonly z: number }, b: { readonly id: ItemId; readonly z: number }): number {
  return a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function pageOrder<T extends { readonly id: ItemId; readonly z: number }>(items: readonly T[]): T[] {
  return [...items].sort(byStack);
}

/** Page `index` in the column: x 0, stacked top to bottom PAGE_GAP apart, at the page size. */
export function pageRect(layout: PagedLayout, index: number): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const { width, height } = PAGE_SIZE[layout];
  return { x: 0, y: index * (height + PAGE_GAP), width, height };
}

/** A slide's poster is full resolution, so a slide shown as a poster at full screen in Present is sharp. Other layouts
 *  and canvases keep the validator's default cap (undefined). */
export const posterPixelsOf = (layout: PagedLayout | undefined): number | undefined =>
  layout === "slides" ? PAGE_SIZE.slides.width * PAGE_SIZE.slides.height : undefined;
