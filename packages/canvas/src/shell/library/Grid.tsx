import { useContentUrl } from "../content.tsx";
// One virtualized grid for every library view and the Media drawer: fixed cells, selection, marquee, keyboard and drag sources.

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cellRect, cellsIn, clickSelect, gridLayout, gridWindow, moveFocus, type GridLayout } from "../../library/grid.ts";
import { armDrag, justDragged, type DragPayload } from "./drag.ts";

export interface GridSel { readonly selection: ReadonlySet<string>; readonly anchor: number | null; readonly focus: number }
export interface GridHandle { scrollToIndex(i: number): void; cellElement(id: string): HTMLElement | null; focus(): void; readonly columns: number }

export interface GridProps<T> {
  readonly items: readonly T[];
  readonly idOf: (t: T) => string;
  /** The accessible name of a cell. */
  readonly labelOf?: (t: T) => string;
  readonly render: (t: T, ctx: { selected: boolean; focused: boolean; index: number }) => ReactNode;
  readonly tile: number; readonly aspect: number; readonly label: number; readonly gap: number; readonly pad?: number;
  readonly sel: GridSel;
  readonly onSel: (s: GridSel) => void;
  readonly onOpen?: (i: number) => void;
  readonly onMenu?: (i: number, x: number, y: number) => void;
  readonly payload?: (ids: readonly string[]) => DragPayload | null;
  /** Select mode for touch: taps toggle and a drag across tiles selects a run. */
  readonly selectMode?: boolean;
  readonly initialScroll?: number;
  readonly onScroll?: (top: number) => void;
  readonly onKey?: (e: React.KeyboardEvent, focused: number) => boolean;
  readonly empty?: ReactNode;
  readonly label_?: string;
  readonly className?: string;
}

function GridInner<T>(p: GridProps<T>, ref: React.Ref<GridHandle>) {
  const scroller = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [top, setTop] = useState(p.initialScroll ?? 0);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const ids = useMemo(() => p.items.map(p.idOf), [p.items]);
  const g: GridLayout = gridLayout(p.items.length, { width: size.width, tile: p.tile, gap: p.gap, pad: p.pad ?? 16, aspect: p.aspect, label: p.label });
  const win = gridWindow(p.items.length, g, top, size.height);
  const selRef = useRef(p.sel); selRef.current = p.sel;

  useLayoutEffect(() => {
    const el = scroller.current!;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el); setSize({ width: el.clientWidth, height: el.clientHeight });
    if (p.initialScroll) el.scrollTop = p.initialScroll;
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (p.sel.focus >= p.items.length && p.items.length) p.onSel({ ...p.sel, focus: p.items.length - 1 }); }, [p.items.length]);

  useImperativeHandle(ref, () => ({
    get columns() { return g.columns; },
    scrollToIndex(i) {
      const el = scroller.current; if (!el || i < 0) return;
      const r = cellRect(g, i);
      if (r.y < el.scrollTop) el.scrollTop = r.y - g.pad; else if (r.y + r.h > el.scrollTop + el.clientHeight) el.scrollTop = r.y + r.h - el.clientHeight + g.pad;
      setTop(el.scrollTop);
    },
    cellElement: (id) => scroller.current?.querySelector(`[data-tile="${CSS.escape(id)}"]`) ?? null,
    focus: () => scroller.current?.focus({ preventScroll: true }),
  }), [g]);

  const raf = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => { const t = scroller.current!.scrollTop; setTop(t); p.onScroll?.(t); });
  };

  const select = (i: number, mode: "replace" | "toggle" | "range") => {
    const r = clickSelect(ids, p.sel.selection, p.sel.anchor, i, mode);
    p.onSel({ selection: r.selection, anchor: r.anchor, focus: i });
  };

  const tileDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return;
    const id = ids[i]!;
    if (p.selectMode) {
      // Drag across tiles selects a run.
      e.preventDefault();
      const start = new Set(p.sel.selection); start.add(id); p.onSel({ selection: start, anchor: i, focus: i });
      const move = (ev: PointerEvent) => {
        const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest("[data-tile]") as HTMLElement | null;
        const k = el ? ids.indexOf(el.dataset.tile!) : -1;
        if (k >= 0) { const s = new Set(selRef.current.selection); for (let j = Math.min(i, k); j <= Math.max(i, k); j++) s.add(ids[j]!); p.onSel({ selection: s, anchor: i, focus: k }); }
      };
      const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
      addEventListener("pointermove", move); addEventListener("pointerup", up);
      return;
    }
    // A view that refuses drags (Archive) never arms one.
    if (!p.payload || !p.payload([id])) return;
    armDrag(e, () => {
      const s = selRef.current.selection.has(id) ? [...selRef.current.selection] : [id];
      return p.payload!(s) ?? p.payload!([id])!;
    }, () => {
      const s = selRef.current.selection.has(id) ? [...selRef.current.selection] : [id];
      return s.map((x) => scroller.current?.querySelector(`[data-tile="${CSS.escape(x)}"]`) as HTMLElement | null).filter((x): x is HTMLElement => !!x);
    }, () => { if (!selRef.current.selection.has(id)) select(i, "replace"); });
  };

  const tileClick = (e: React.MouseEvent, i: number) => {
    if (justDragged()) return;
    const check = (e.target as Element).closest(".screens-check-dot");
    select(i, p.selectMode || check || e.metaKey || e.ctrlKey ? "toggle" : e.shiftKey ? "range" : "replace");
    scroller.current?.focus({ preventScroll: true });
  };

  // Marquee from empty space, with the same pointer.
  const bgDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as Element).closest("[data-tile]")) return;
    const el = scroller.current!; el.focus({ preventScroll: true });
    const box = el.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => ({ x: ev.clientX - box.left, y: ev.clientY - box.top + el.scrollTop });
    const o = at(e), keep = e.shiftKey || e.metaKey ? new Set(p.sel.selection) : new Set<string>();
    if (!keep.size) p.onSel({ selection: new Set(), anchor: null, focus: p.sel.focus });
    const move = (ev: PointerEvent) => {
      const c = at(ev);
      const r = { x: Math.min(o.x, c.x), y: Math.min(o.y, c.y), w: Math.abs(c.x - o.x), h: Math.abs(c.y - o.y) };
      if (r.w + r.h < 4) return;
      setMarquee(r);
      const s = new Set(keep); for (const i of cellsIn(g, ids.length, r)) s.add(ids[i]!);
      p.onSel({ selection: s, anchor: null, focus: selRef.current.focus });
    };
    const up = () => { setMarquee(null); removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    if (p.onKey?.(e, p.sel.focus)) { e.preventDefault(); return; }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "a") { e.preventDefault(); p.onSel({ selection: new Set(ids), anchor: null, focus: p.sel.focus }); return; }
    if (e.key === "Escape" && p.sel.selection.size) { e.preventDefault(); p.onSel({ selection: new Set(), anchor: null, focus: p.sel.focus }); return; }
    if (/^Arrow|^Home$|^End$/.test(e.key) && ids.length) {
      e.preventDefault();
      const i = moveFocus(p.sel.focus, e.key, g.columns, ids.length);
      if (e.shiftKey) { const s = new Set(p.sel.selection); s.add(ids[i]!); p.onSel({ selection: s, anchor: p.sel.anchor ?? p.sel.focus, focus: i }); }
      else p.onSel({ selection: new Set([ids[i]!]), anchor: i, focus: i });
      const r = cellRect(g, i), el = scroller.current!;
      if (r.y < el.scrollTop) el.scrollTop = r.y - g.pad; else if (r.y + r.h > el.scrollTop + el.clientHeight) el.scrollTop = r.y + r.h - el.clientHeight + g.pad;
    }
  };

  const cells: ReactNode[] = [];
  for (let i = win.first; i < win.last; i++) {
    const t = p.items[i]!, id = ids[i]!, r = cellRect(g, i);
    const selected = p.sel.selection.has(id);
    cells.push(
      <div key={id} className="screens-cell" data-tile={id} role="option" aria-selected={selected} aria-label={p.labelOf?.(t)} aria-posinset={i + 1} aria-setsize={ids.length}
        data-focused={i === p.sel.focus ? "" : undefined} style={{ transform: `translate(${r.x}px, ${r.y}px)`, width: r.w, height: r.h }}
        onPointerDown={(e) => tileDown(e, i)} onClick={(e) => tileClick(e, i)} onDoubleClick={() => p.onOpen?.(i)}
        onContextMenu={(e) => { e.preventDefault(); if (!p.sel.selection.has(id)) select(i, "replace"); p.onMenu?.(i, e.clientX, e.clientY); }}>
        {p.render(t, { selected, focused: i === p.sel.focus, index: i })}
      </div>,
    );
  }

  return (
    <div ref={scroller} className={`screens-grid ${p.className ?? ""}`} tabIndex={0} role="listbox" aria-multiselectable="true" aria-label={p.label_}
      data-select-mode={p.selectMode ? "" : undefined} aria-activedescendant={undefined}
      onScroll={onScroll} onPointerDown={bgDown} onKeyDown={onKeyDown}>
      <div className="screens-grid-content" style={{ height: Math.max(g.totalHeight, 1) }}>
        {cells}
        {marquee && <div className="marquee" style={{ position: "absolute", left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
      </div>
      {p.items.length === 0 && p.empty}
    </div>
  );
}

export const Grid = forwardRef(GridInner) as <T>(p: GridProps<T> & { ref?: React.Ref<GridHandle> }) => ReturnType<typeof GridInner>;

/** A lazily loaded thumbnail with a skeleton until it decodes. */
/** src overrides the thumbnail URL (a page's on-demand poster); page draws it whole, at the page's shape. */
export function Thumb({ hash, alt = "", src, page }: { hash: string | null | undefined; alt?: string; src?: string; page?: string }) {
  const [loaded, setLoaded] = useState(false);
  const imageUrl = useContentUrl(hash, src ?? (hash ? `/thumb/${hash}` : undefined));
  if (!hash && !src) return <span className="screens-thumb empty" data-page={page} />;
  return (
    <span className={`screens-thumb${loaded ? "" : " placeholder"}`} data-page={page}>
      <img src={imageUrl} alt={alt} loading="lazy" decoding="async" draggable={false} onLoad={() => setLoaded(true)} style={{ opacity: loaded ? 1 : 0 }} />
    </span>
  );
}
