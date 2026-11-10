// The format bar: the controls of the selected piece, floating beside it on the page in focus mode.
// It shows what the page computed for the piece and writes inline styles through the editor's edit, like any piece edit.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditInput, ItemId, PieceNode } from "@screens/core";
import type { CanvasRuntime, PieceBox } from "./runtime.ts";
import { Icon } from "./icons.tsx";

type Edit = Omit<EditInput, "at">;
/** Generic stacks offered after the page's own fonts. */
const STACKS: readonly (readonly [string, string])[] = [["Sans", "system-ui, sans-serif"], ["Serif", "Georgia, serif"], ["Mono", "ui-monospace, monospace"]];
const ALIGN = ["left", "center", "right"] as const;

/** #rrggbb of a computed color, or null when it is fully transparent or not an rgb color. */
export function hexOf(color: string): string | null {
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(color.trim());
  if (!m || (m[4] !== undefined && parseFloat(m[4]) === 0)) return null;
  return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
}

/** Whether the piece carries text of its own, so type controls mean something on it. */
export const hasType = (n: PieceNode): boolean => n.kind === "text" || n.kind === "control" || ["li", "td", "th"].includes(n.tag) || (n.kind === "box" && n.leaf && n.text.trim() !== "");

export interface TableActions { readonly addRow: () => void; readonly addColumn: () => void }

export function FormatBar({ rt, itemId, node, box, table, onEdit, onRemove }: { rt: CanvasRuntime; itemId: ItemId; node: PieceNode; box: PieceBox; table: TableActions | null;
  onEdit: (e: Edit) => void; onRemove: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Beside the piece in stage pixels: above it, below when there is no room, and always inside the stage.
  const place = () => {
    const el = ref.current, stage = rt.stage, it = rt.doc().byId.get(itemId);
    if (!el || !stage || !it) return;
    const { x, y, z } = rt.view.camera, left = x + (it.x + box.x) * z, top = y + (it.y + box.y) * z;
    const bw = el.offsetWidth, bh = el.offsetHeight, sw = stage.clientWidth, sh = stage.clientHeight;
    // A piece scrolled out of view takes its bar with it.
    el.style.visibility = left > sw || top > sh || left + box.w * z < 0 || top + box.h * z < 0 ? "hidden" : "";
    const above = top - bh - 12, below = top + box.h * z + 12;
    const ty = above >= 56 ? above : below + bh <= sh - 8 ? below : Math.max(56, sh - bh - 8);
    const tx = Math.max(8, Math.min(sw - bw - 8, left + (box.w * z - bw) / 2));
    el.style.transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px)`;
  };
  useLayoutEffect(place);
  useEffect(() => rt.onPaint(place));

  const type = hasType(node), image = node.tag === "img" || node.tag === "video", shape = node.kind === "box";
  const style = (s: Record<string, string | null>) => onEdit({ style: s });
  const bold = box.weight >= 600;
  const family = box.font.split(",")[0]!.trim().replace(/["']/g, "");
  const fonts = [...new Set([family, ...box.fonts].filter(Boolean))];
  return (
    <div ref={ref} className="chrome shell screens-format" role="toolbar" aria-label="Format" data-format={node.pid}>
      {type && <>
        <select className="screens-format-font" aria-label="Font" value={family} onChange={(e) => style({ "font-family": e.target.value || null })} onKeyDown={(e) => e.stopPropagation()}>
          {fonts.map((f) => <option key={f} value={f === family ? f : `"${f}"`}>{f}</option>)}
          {STACKS.map(([name, stack]) => <option key={name} value={stack}>{name}</option>)}
        </select>
        <button className="tool" aria-label="Smaller text" title="Smaller text" onClick={() => style({ "font-size": `${stepSize(box.size, -1)}px` })}><Icon name="minus" /></button>
        <SizeInput value={Math.round(box.size)} onCommit={(n) => style({ "font-size": `${n}px` })} />
        <button className="tool" aria-label="Larger text" title="Larger text" onClick={() => style({ "font-size": `${stepSize(box.size, 1)}px` })}><Icon name="plus" /></button>
        <span className="shell-divider" />
        <button className="tool" aria-label="Bold" title="Bold" aria-pressed={bold} onClick={() => style({ "font-weight": bold ? "400" : "700" })}><Icon name="bold" /></button>
        <button className="tool" aria-label="Italic" title="Italic" aria-pressed={box.italic} onClick={() => style({ "font-style": box.italic ? "normal" : "italic" })}><Icon name="italic" /></button>
        <span className="shell-divider" />
        {ALIGN.map((a) => (
          <button key={a} className="tool" aria-label={`Align ${a}`} title={`Align ${a}`} aria-pressed={alignOf(box.align) === a} onClick={() => style({ "text-align": a })}><Icon name={`align-${a}`} /></button>
        ))}
        <span className="shell-divider" />
        <Color label="Text color" value={box.color} onCommit={(c) => style({ color: c })} />
      </>}
      {shape && <Color label="Fill" value={box.fill} fill onCommit={(c) => style({ "background-color": c })} />}
      {image && <button className="tool" aria-label="Crop to fill" title="Crop to fill" aria-pressed={box.fit === "cover"} onClick={() => style({ "object-fit": box.fit === "cover" ? "contain" : "cover" })}><Icon name="crop" /></button>}
      {table && <>
        <span className="shell-divider" />
        <button className="tool" aria-label="Add row" title="Add row" onClick={table.addRow}><Icon name="row-plus" /></button>
        <button className="tool" aria-label="Add column" title="Add column" onClick={table.addColumn}><Icon name="column-plus" /></button>
      </>}
      <span className="shell-divider" />
      <button className="tool" aria-label="Delete" title="Delete" onClick={onRemove}><Icon name="trash" /></button>
    </div>
  );
}

const alignOf = (a: string) => (a === "start" || a === "-webkit-auto" ? "left" : a === "end" ? "right" : a);
/** One step on the type scale: about a tenth of the size, so small text moves by a pixel and a headline by several. */
const stepSize = (size: number, dir: 1 | -1) => Math.max(6, Math.round(size) + dir * Math.max(1, Math.round(size / 10)));

function SizeInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => { const n = Math.round(Number(v)); if (Number.isFinite(n) && n >= 6 && n <= 800 && n !== value) onCommit(n); else setV(String(value)); };
  return <input className="screens-format-size" aria-label="Text size" inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setV(String(value)); e.currentTarget.blur(); } e.stopPropagation(); }} />;
}

/** A swatch over the system color picker. It commits on the native change event, which fires when the picker closes, so
 *  dragging in it is one edit. React's onChange would fire on every move. */
function Color({ label, value, fill, onCommit }: { label: string; value: string; fill?: boolean; onCommit: (hex: string) => void }) {
  const hex = hexOf(value);
  const ref = useRef<HTMLInputElement>(null), commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const el = ref.current!, changed = () => commit.current(el.value);
    el.addEventListener("change", changed);
    return () => el.removeEventListener("change", changed);
  }, []);
  useEffect(() => { ref.current!.value = hex ?? "#ffffff"; }, [hex]);
  return (
    <label className="tool screens-format-color" title={label}>
      <span className={`screens-swatch${fill ? " fill" : ""}`} style={{ background: hex ?? "transparent" }} />
      <input ref={ref} type="color" aria-label={label} defaultValue={hex ?? "#ffffff"} />
    </label>
  );
}
