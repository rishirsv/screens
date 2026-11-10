// The piece editor in focus mode: the Layers panel, the format bar beside the selected piece, and edits made on the page.
// Pieces are read from the committed source every time it changes; edits go to the service as editObject and show as
// saved only once it commits them.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pieceTree, styleDeclarations, type EditInput, type ItemId, type PieceNode } from "@screens/core";
import type { CanvasRuntime, PieceBox } from "./runtime.ts";
import { FormatBar, type TableActions } from "./Format.tsx";
import { Icon } from "./icons.tsx";

const DETAILS_KEY = "screens.pieceDetails";
const store = {
  get(): boolean { try { return localStorage.getItem(DETAILS_KEY) === "1"; } catch { return false; } },
  set(open: boolean) { try { localStorage.setItem(DETAILS_KEY, open ? "1" : "0"); } catch { /* ignore */ } },
};
/** Recent entry sources by hash. Each edit makes a new one, so only the last few are kept. */
const SOURCES_KEPT = 8;
const sources = new Map<string, Promise<string>>();
const sourceOf = (hash: string, rt: CanvasRuntime) => {
  let p = sources.get(hash);
  if (p) { sources.delete(hash); sources.set(hash, p); return p; }
  p = rt.client.readContent(hash).then((bytes) => new TextDecoder().decode(bytes));
  sources.set(hash, p); p.catch(() => sources.delete(hash));
  while (sources.size > SOURCES_KEPT) sources.delete(sources.keys().next().value!);
  return p;
};

type Edit = Omit<EditInput, "at">;
const KIND_ICON: Record<PieceNode["kind"], string> = { box: "square", text: "type", image: "image", control: "click" };
const TAG_TITLE: Readonly<Record<string, string>> = { img: "Image", picture: "Image", video: "Video", audio: "Audio", canvas: "Canvas", svg: "Graphic", hr: "Divider", ul: "List", ol: "List",
  li: "Item", table: "Table", tr: "Row", td: "Cell", th: "Cell", header: "Header", footer: "Footer", nav: "Navigation", section: "Section", figure: "Figure", form: "Form" };
/** What a row is called: its name, else its own text, else what the author's class or the tag says it is. A group is never
 *  titled with the run-together text of everything inside it. */
const labelOf = (n: PieceNode): string => {
  if (n.name) return n.name;
  if (n.kind !== "box" || n.leaf) { if (n.label) return n.label; }
  return n.classes[0]?.replace(/[-_]+/g, " ") ?? TAG_TITLE[n.tag] ?? (n.kind !== "box" ? n.tag : n.children.length ? "Group" : "Shape");
};
const fillOf = (n: PieceNode) => { const d = styleDeclarations(n.style); return d.find(([k]) => k === "background-color")?.[1] ?? d.find(([k]) => k === "background")?.[1] ?? ""; };
/** Layout only: an unnamed box around a single piece. The panel lists what it holds in its place. */
const isWrapper = (n: PieceNode) => n.kind === "box" && !n.name && !n.hidden && n.children.length === 1 && !["table", "tr", "ul", "ol"].includes(n.tag);
/** The children a row shows: its pieces, with wrappers replaced by what they hold. */
const shownChildren = (n: PieceNode): PieceNode[] => n.children.flatMap((c) => (isWrapper(c) ? shownChildren(c) : [c]));
/** A piece whose text can be typed on the page: it holds text and no elements. */
const typable = (n: PieceNode) => n.leaf && !n.unclosed && n.kind !== "image" && !["input", "textarea", "select", "hr"].includes(n.tag);
/** Rows open at first: everything on a page small enough to read at once, else the top level. */
const OPEN_ALL_UNDER = 40;

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
type InsertKind = "text" | "rectangle" | "ellipse" | "table";
const INSERTS: readonly { readonly kind: InsertKind; readonly label: string; readonly icon: string }[] = [
  { kind: "text", label: "Text", icon: "type" }, { kind: "rectangle", label: "Rectangle", icon: "square" }, { kind: "ellipse", label: "Ellipse", icon: "circle" }, { kind: "table", label: "Table", icon: "table" },
];
/** A new piece, absolutely positioned in the middle of a w by h page so it can be dragged into place. big: a slide's scale. */
function insertHtml(kind: InsertKind, pid: string, w: number, h: number, big: boolean): string {
  const k = big ? 2.5 : 1, at = (pw: number, ph: number) => `position: absolute; left: ${Math.round((w - pw) / 2)}px; top: ${Math.round((h - ph) / 2)}px`;
  if (kind === "text") return `<p data-pid="${pid}" data-name="Text" style="${at(160 * k, 24 * k)}; margin: 0; font-size: ${16 * k}px">Text</p>`;
  if (kind === "table") {
    const cell = `padding: ${6 * k}px ${10 * k}px; border: 1px solid #c8c8ce; min-width: ${72 * k}px; height: ${20 * k}px`;
    const row = (tag: string) => `<tr>${`<${tag} style="${cell}; text-align: left"></${tag}>`.repeat(3)}</tr>`;
    return `<table data-pid="${pid}" data-name="Table" style="${at(280 * k, 96 * k)}; border-collapse: collapse; font-size: ${14 * k}px">${row("th")}${row("td")}${row("td")}</table>`;
  }
  return `<div data-pid="${pid}" data-name="${kind === "ellipse" ? "Ellipse" : "Rectangle"}" style="${at(160 * k, 96 * k)}; width: ${160 * k}px; height: ${96 * k}px; background-color: #c8c8ce${kind === "ellipse" ? "; border-radius: 50%" : ""}"></div>`;
}

export function PieceEditor({ rt, itemId, panel }: { rt: CanvasRuntime; itemId: ItemId; panel: boolean }) {
  const committed = rt.client.get().committed?.items[itemId];
  const hash = committed?.kind === "html-snapshot" ? committed.assetManifest[committed.entry]?.hash ?? null : null;
  const [source, setSource] = useState<{ hash: string; text: string } | null>(null);
  /** The selected pieces. The panel details and the format bar act on a single one. */
  const [selection, setSelection] = useState<readonly string[]>([]);
  const selected = selection.length === 1 ? selection[0]! : null;
  const setSelected = (pid: string | null) => setSelection(pid ? [pid] : []);
  const toggle1 = (pid: string) => setSelection((s) => (s.includes(pid) ? s.filter((x) => x !== pid) : [...s, pid]));
  const [hovered, setHovered] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [box, setBox] = useState<PieceBox | null>(null);
  const [open, setOpen] = useState(store.get);
  /** The piece being typed into on the page, and edits made from the bar meanwhile: they save with its text. */
  const typing = useRef<{ pid: string; queued: Edit[] } | null>(null);
  const made = useRef<string | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  useEffect(() => {
    if (!hash) return;
    let live = true;
    sourceOf(hash, rt).then((text) => { if (live) setSource({ hash, text }); }, () => {});
    return () => { live = false; };
  }, [hash]);
  const tree = useMemo(() => (source ? pieceTree(source.text) : null), [source]);
  // Rows from an older source than the committed one are shown but take no edits until the new source arrives.
  const stale = !source || source.hash !== hash;
  const { byPid, parents } = useMemo(() => {
    const byPid = new Map<string, PieceNode>(), parents = new Map<string, PieceNode>();
    const walk = (n: PieceNode) => { byPid.set(n.pid, n); for (const c of n.children) { parents.set(c.pid, n); walk(c); } };
    if (tree) walk(tree);
    return { byPid, parents };
  }, [tree]);
  useEffect(() => {
    if (!tree || expanded) return;
    const all: string[] = [], top = shownChildren(tree).map((c) => c.pid);
    const walk = (n: PieceNode) => { for (const c of shownChildren(n)) { all.push(c.pid); walk(c); } };
    walk(tree);
    setExpanded(new Set(all.length <= OPEN_ALL_UNDER ? all : top));
  }, [tree, expanded]);
  const reveal = (pid: string) => { const path: string[] = []; for (let p = parents.get(pid); p; p = parents.get(p.pid)) path.push(p.pid); setExpanded((s) => new Set([...(s ?? []), ...path])); };

  /** Resolves true once the service commits the edits. */
  const submit = (pid: string, edits: readonly EditInput[]): Promise<boolean> => {
    if (stale) return Promise.resolve(false);
    setPending((s) => new Set([...s, pid]));
    return rt.client.submit({ type: "editObject", itemId, edits }).settled()
      .then((o) => o.status === "committed", () => false)
      .finally(() => setPending((s) => { const n = new Set(s); n.delete(pid); return n; }));
  };
  /** Resolves true once the service commits the edit. An edit to the piece being typed into waits for its text. */
  const edit = (pid: string, e: Edit): Promise<boolean> => {
    if (typing.current?.pid === pid) { typing.current.queued.push(e); rt.commitText(itemId); return Promise.resolve(true); }
    return submit(pid, [{ at: pid, ...e }]);
  };

  // A double-click on text starts typing there. One that lands while the new source is still arriving waits for it.
  const wanted = useRef<{ pid: string; at: number } | null>(null);
  const startTyping = () => {
    const w = wanted.current, n = w ? byPid.get(w.pid) : null;
    if (!w || stale || typing.current) return;
    wanted.current = null;
    if (!n || !typable(n) || performance.now() - w.at > 1500) return;
    typing.current = { pid: w.pid, queued: [] };
    setSelected(w.pid); reveal(w.pid); rt.editText(itemId, w.pid);
  };
  useEffect(startTyping, [byPid, stale]);

  // What the page reports. A click selects; a double-click on text starts typing there; the end of typing and the end of
  // a drag are saved only for the piece this editor started typing into or has selected.
  useEffect(() => rt.onPiece((e) => {
    if (e.itemId !== itemId) return;
    if (e.kind === "rect") { setBox(e.box); return; }
    if (e.kind === "click") {
      // A press on one of several selected pieces keeps them all, so the press can drag them together.
      if (!e.pid) setSelection([]);
      else if (e.shift) toggle1(e.pid);
      else if (!(selectionRef.current.length > 1 && selectionRef.current.includes(e.pid))) { setSelected(e.pid); reveal(e.pid); }
      return;
    }
    if (e.kind === "select") { setSelection(e.pids.filter((p) => byPid.has(p))); return; }
    if (e.kind === "dbl") { wanted.current = { pid: e.pid, at: performance.now() }; startTyping(); return; }
    if (e.kind === "text") {
      const t = typing.current;
      if (!t || t.pid !== e.pid) return;
      typing.current = null;
      const edits: EditInput[] = [...(e.text !== null ? [{ at: t.pid, text: e.text }] : []), ...t.queued.map((q) => ({ at: t.pid, ...q }))];
      if (edits.length) void submit(t.pid, edits);
      return;
    }
    if (e.kind !== "move") return;
    const px = (v: number) => `${Math.round(Math.max(-1e5, Math.min(1e5, v)))}px`;
    const edits = e.items.filter((m) => selectionRef.current.includes(m.pid) && byPid.has(m.pid)).flatMap((m): EditInput[] => {
      const style: Record<string, string> = {};
      if (m.x !== null && m.y !== null) Object.assign(style, { left: px(m.x), top: px(m.y) }, m.rel ? { position: "relative" } : { right: "auto", bottom: "auto" });
      if (m.w !== null) style.width = px(Math.max(1, m.w));
      if (m.h !== null) style.height = px(Math.max(1, m.h));
      return Object.keys(style).length ? [{ at: m.pid, style }] : [];
    });
    if (edits.length) void submit(edits[0]!.at as string, edits);
  }), [rt, itemId, byPid, parents, stale]);
  // The outline in the object follows the hovered row, else the selected one. It is redrawn after each reload.
  const load = rt.frames.load.get(itemId), gen = rt.frames.gen.get(itemId);
  useEffect(() => { rt.highlight(itemId, hovered ? [hovered] : selection); }, [rt, itemId, hovered, selection, load, gen]);
  useEffect(() => () => rt.highlight(itemId, []), [rt, itemId]);
  // The page draws the outline and handles at a fixed size on screen, so it hears about a change of zoom.
  useEffect(() => { let z = rt.view.camera.z; return rt.onPaint(() => { const now = rt.view.camera.z; if (Math.abs(now - z) > z * 0.05) { z = now; rt.highlight(itemId, hovered ? [hovered] : selectionRef.current); } }); }, [rt, itemId, hovered]);
  // A reloaded page has forgotten any typing in progress.
  useEffect(() => { typing.current = null; }, [gen]);
  // An object saved before pieces had ids lists them as ?0, ?1, …, which the page cannot outline. Stamp it once.
  const stampedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!source || stale || stampedFor.current === source.hash || ![...byPid.keys()].some((p) => p.startsWith("?"))) return;
    stampedFor.current = source.hash;
    void rt.client.submit({ type: "editObject", itemId, edits: [] });
  }, [rt, itemId, source, byPid, stale]);
  // A piece that disappeared (an agent removed it) is no longer selected. One just inserted is selected when its source arrives.
  useEffect(() => {
    const w = made.current;
    if (w && byPid.has(w)) { made.current = null; setSelected(w); reveal(w); }
    else if (tree && selection.some((p) => !byPid.has(p))) setSelection(selection.filter((p) => byPid.has(p)));
  }, [tree, byPid, selection]);

  if (!tree || committed?.kind !== "html-snapshot") return panel ? <aside className="panel screens-inspector screens-layers" aria-label="Layers"><div className="panel-head"><span>Layers</span></div></aside> : null;
  const sel = selected ? byPid.get(selected) ?? null : null;
  const isOpen = (pid: string) => expanded?.has(pid) ?? false;

  const rows: React.ReactNode[] = [];
  const walk = (n: PieceNode, depth: number) => {
    for (const c of shownChildren(n)) {
      const kids = shownChildren(c).length > 0, o = isOpen(c.pid);
      rows.push(
        <div key={c.pid} className={`layer-row${c.hidden ? " screens-hidden-row" : ""}`} role="treeitem" aria-selected={selection.includes(c.pid)} aria-level={depth + 1} aria-disabled={stale || undefined}
          aria-expanded={kids ? o : undefined} data-piece={c.pid} style={{ paddingLeft: 8 + depth * 14 }}
          onClick={(ev) => (ev.shiftKey || ev.metaKey || ev.ctrlKey ? toggle1(c.pid) : setSelected(c.pid))} onDoubleClick={() => setRenaming(c.pid)}
          onPointerEnter={() => setHovered(c.pid)} onPointerLeave={() => setHovered((h) => (h === c.pid ? null : h))}>
          {kids
            ? <button className="screens-disclosure" aria-label={o ? "Collapse" : "Expand"} onClick={(ev) => { ev.stopPropagation(); setExpanded((s) => { const x = new Set(s); if (x.has(c.pid)) x.delete(c.pid); else x.add(c.pid); return x; }); }}>
                <Icon name="chevron" className={`icon chevron${o ? " open" : ""}`} /></button>
            : <span className="screens-disclosure" />}
          <Icon name={KIND_ICON[c.kind]} className="icon kind" />
          {renaming === c.pid
            ? <NameInput initial={c.name ?? ""} placeholder={labelOf(c)} onDone={(v) => { setRenaming(null); if (v !== null && v !== (c.name ?? "")) void edit(c.pid, { name: v === "" ? null : v }); }} />
            : <span className="name" title={labelOf(c)}>{labelOf(c)}</span>}
          {pending.has(c.pid) && <span className="spinner screens-mini-spinner" aria-label="Saving" />}
          <span className="trail" style={c.hidden ? { opacity: 1 } : undefined}>
            <button className="icon-button small" aria-label={c.hidden ? `Show ${labelOf(c)}` : `Hide ${labelOf(c)}`} onClick={(ev) => { ev.stopPropagation(); void edit(c.pid, { hidden: !c.hidden }); }}>
              <Icon name={c.hidden ? "eye-off" : "eye"} />
            </button>
          </span>
        </div>,
      );
      if (o) walk(c, depth + 1);
    }
  };
  walk(tree, 0);

  // The new piece carries an id chosen here, so it can be selected as soon as its source arrives.
  const insert = (kind: InsertKind) => {
    const pid = `n${rt.env.newId().slice(0, 7)}`;
    made.current = pid;
    void submit("body", [{ write: insertHtml(kind, pid, committed.width, committed.height, rt.doc().layout === "slides") }]);
  };
  // A selected cell or row can grow its table. New cells copy the styles of the ones beside them.
  const tableOf = (n: PieceNode): TableActions | null => {
    const row = n.tag === "tr" ? n : ["td", "th"].includes(n.tag) ? parents.get(n.pid) : null;
    let table = row ? parents.get(row.pid) : null;
    while (table && table.tag !== "table") table = parents.get(table.pid);
    if (!row || row.tag !== "tr" || !table) return null;
    const cells = (r: PieceNode) => r.children.filter((c) => c.tag === "td" || c.tag === "th");
    const cellHtml = (like: PieceNode | undefined, tag: string) => `<${tag}${like?.style ? ` style="${escAttr(like.style)}"` : ""}></${tag}>`;
    const rowsIn: PieceNode[] = [];
    const collect = (x: PieceNode) => { for (const c of x.children) { if (c.tag === "tr") rowsIn.push(c); else if (c.tag !== "table") collect(c); } };
    collect(table);
    return {
      addRow: () => void submit(row.pid, [{ at: row.pid, pos: "after", write: `<tr>${cells(row).map((c) => cellHtml(c, "td")).join("")}</tr>` }]),
      addColumn: () => void submit(table.pid, rowsIn.filter((r) => !r.unclosed).map((r) => { const last = cells(r).at(-1); return { at: r.pid, pos: "end" as const, write: cellHtml(last, last?.tag ?? "td") }; })),
    };
  };

  const toggle = () => { const next = !open; setOpen(next); store.set(next); };
  return (
    <>
      {panel && <aside className="panel screens-inspector screens-layers" aria-label="Layers">
        <div className="panel-head">
          <span className="screens-panel-title">Layers</span><span className="spacer" />
          {INSERTS.map((i) => <button key={i.kind} className="icon-button small" aria-label={`Add ${i.label.toLowerCase()}`} title={`Add ${i.label.toLowerCase()}`} disabled={stale} onClick={() => insert(i.kind)}><Icon name={i.icon} /></button>)}
        </div>
        <div className="panel-body" role="tree" aria-label="Pieces">{rows.length ? rows : <span className="screens-muted">No pieces</span>}</div>
        {sel && (
          <div className="inspector-section screens-piece-details">
            <button className="inspector-section-head screens-details-head" aria-expanded={open} aria-label={`Details of ${labelOf(sel)}`} onClick={toggle}>
              <span className="name">{labelOf(sel)}</span><Icon name="chevron-down" className={`icon${open ? " open" : ""}`} />
            </button>
            {open && <Details key={sel.pid} n={sel} size={box?.pid === sel.pid ? box : null} onEdit={(e) => edit(sel.pid, e)} />}
          </div>
        )}
      </aside>}
      {sel && sel.pid !== "body" && box?.pid === sel.pid && box.w > 0 && load === "ready" && !stale && rt.stage && createPortal(
        <FormatBar rt={rt} itemId={itemId} node={sel} box={box} table={tableOf(sel)} onEdit={(e) => void edit(sel.pid, e)}
          onRemove={() => { setSelected(null); void submit(sel.pid, [{ at: sel.pid, remove: true }]); }} />, rt.stage)}
    </>
  );
}

function Details({ n, size, onEdit }: { n: PieceNode; size: { w: number; h: number } | null; onEdit: (e: Omit<EditInput, "at">) => Promise<boolean> }) {
  const fill = fillOf(n);
  return (
    <div className="screens-details">
      {n.leaf && n.kind !== "image" && n.tag !== "input" && <Field label="Text" value={n.text} onCommit={(v) => (v !== n.text ? onEdit({ text: v }) : null)} />}
      <Field label="Fill" value={fill} swatch={fill} onCommit={(v) => { const t = v.trim(); return t !== fill ? onEdit({ style: { "background-color": t === "" ? null : t, ...(fill && styleDeclarations(n.style).some(([k]) => k === "background") ? { background: null } : {}) } }) : null; }} />
      <div className="field-row"><label>Size</label><span className="screens-muted" data-size>{size ? `${size.w} × ${size.h}` : "–"}</span></div>
    </div>
  );
}

function Field({ label, value, swatch, onCommit }: { label: string; value: string; swatch?: string; onCommit: (v: string) => Promise<boolean> | null }) {
  const [v, setV] = useState(value);
  // A newer committed value replaces the draft only while it is not being edited. A refused edit shows the saved value again.
  const editing = useRef(false), cancelled = useRef(false), latest = useRef(value);
  latest.current = value;
  useEffect(() => { if (!editing.current) setV(value); }, [value]);
  const id = `piece-${label.toLowerCase()}`;
  return (
    <div className="field-row">
      <label htmlFor={id}>{label}</label>
      {swatch !== undefined && <span className="screens-swatch" style={{ background: swatch || "transparent" }} />}
      <input id={id} className="screens-input" value={v} onFocus={() => { editing.current = true; }}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { editing.current = false; if (cancelled.current) { cancelled.current = false; return; } void onCommit(v)?.then((ok) => { if (!ok && !editing.current) setV(latest.current); }); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLElement).blur(); if (e.key === "Escape") { cancelled.current = true; setV(value); (e.target as HTMLElement).blur(); } e.stopPropagation(); }} />
    </div>
  );
}

function NameInput({ initial, placeholder, onDone }: { initial: string; placeholder: string; onDone: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.select(); }, []);
  const finish = (v: string | null) => { if (!done.current) { done.current = true; onDone(v); } };
  return <input ref={ref} className="screens-input screens-name-input" defaultValue={initial} placeholder={placeholder} maxLength={80} aria-label="Layer name"
    onClick={(e) => e.stopPropagation()} onBlur={(e) => finish(e.target.value.trim())}
    onKeyDown={(e) => { if (e.key === "Enter") finish(e.currentTarget.value.trim()); if (e.key === "Escape") finish(null); e.stopPropagation(); }} />;
}
