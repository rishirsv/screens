// Grid layout and selection for every library grid. Pure: no DOM.
// Cells have a fixed size per view, so the visible window and marquee hits are index math, never a DOM scan.

export interface GridLayout {
  readonly columns: number;
  /** Cell width and height in CSS pixels, including the label for labelled cells. */
  readonly cellW: number; readonly cellH: number;
  readonly gap: number; readonly pad: number;
  readonly totalHeight: number;
}

/** tile: the wanted minimum cell width. aspect: thumbnail height / width. label: px under the thumbnail. */
export function gridLayout(count: number, o: { readonly width: number; readonly tile: number; readonly gap: number; readonly pad: number; readonly aspect: number; readonly label: number }): GridLayout {
  const inner = Math.max(1, o.width - 2 * o.pad);
  const columns = Math.max(1, Math.floor((inner + o.gap) / (o.tile + o.gap)));
  const cellW = (inner - (columns - 1) * o.gap) / columns;
  const cellH = cellW * o.aspect + o.label;
  const rows = Math.ceil(count / columns);
  return { columns, cellW, cellH, gap: o.gap, pad: o.pad, totalHeight: rows ? 2 * o.pad + rows * cellH + (rows - 1) * o.gap : 0 };
}

/** The index range to mount: visible rows plus overscan rows, as [first, last). */
export function gridWindow(count: number, g: GridLayout, scrollTop: number, height: number, overscanRows = 2): { readonly first: number; readonly last: number } {
  const rowH = g.cellH + g.gap;
  const firstRow = Math.max(0, Math.floor((scrollTop - g.pad) / rowH) - overscanRows);
  const lastRow = Math.ceil((scrollTop + height - g.pad) / rowH) + overscanRows;
  return { first: Math.min(count, firstRow * g.columns), last: Math.min(count, lastRow * g.columns) };
}

export function cellRect(g: GridLayout, i: number): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } {
  const r = Math.floor(i / g.columns), c = i % g.columns;
  return { x: g.pad + c * (g.cellW + g.gap), y: g.pad + r * (g.cellH + g.gap), w: g.cellW, h: g.cellH };
}

/** Indices of cells a content-space rectangle touches. O(rows × columns in the rect). */
export function cellsIn(g: GridLayout, count: number, r: { x: number; y: number; w: number; h: number }): number[] {
  const out: number[] = [];
  const rowH = g.cellH + g.gap, colW = g.cellW + g.gap;
  const r0 = Math.max(0, Math.floor((r.y - g.pad) / rowH)), r1 = Math.floor((r.y + r.h - g.pad) / rowH);
  const c0 = Math.max(0, Math.floor((r.x - g.pad) / colW)), c1 = Math.min(g.columns - 1, Math.floor((r.x + r.w - g.pad) / colW));
  for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) {
    const i = row * g.columns + col; if (i >= count) continue;
    const b = cellRect(g, i);
    if (b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y) out.push(i);
  }
  return out;
}

/** Arrow-key focus movement in a grid of `count` cells. */
export function moveFocus(i: number, key: string, columns: number, count: number): number {
  const d = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : key === "ArrowDown" ? columns : key === "ArrowUp" ? -columns : key === "Home" ? -Infinity : key === "End" ? Infinity : 0;
  return Math.max(0, Math.min(count - 1, i + d));
}

/** Click selection: plain replaces, ⌘ or a checkbox toggles, ⇧ extends a run from the anchor. */
export function clickSelect(ids: readonly string[], sel: ReadonlySet<string>, anchor: number | null, i: number, mode: "replace" | "toggle" | "range"): { readonly selection: Set<string>; readonly anchor: number } {
  const id = ids[i]!;
  if (mode === "toggle") { const next = new Set(sel); if (next.has(id)) next.delete(id); else next.add(id); return { selection: next, anchor: i }; }
  if (mode === "range" && anchor !== null) {
    const next = new Set(sel);
    for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) next.add(ids[k]!);
    return { selection: next, anchor };
  }
  return { selection: new Set([id]), anchor: i };
}
