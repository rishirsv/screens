// The layers inspector in focus mode: the pieces of the focused object, and the selected piece's details.
// Pieces are read from the committed source every time it changes; edits go to the service as editObject and show as
// saved only once it commits them.

import { useEffect, useMemo, useRef, useState } from "react";
import { pieceTree, styleDeclarations, type EditInput, type ItemId, type PieceNode } from "@screens/core";
import type { CanvasRuntime } from "./runtime.ts";
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

const KIND_ICON: Record<PieceNode["kind"], string> = { box: "square", text: "type", image: "image", control: "click" };
const labelOf = (n: PieceNode) => n.name ?? (n.label || n.tag);
const fillOf = (n: PieceNode) => { const d = styleDeclarations(n.style); return d.find(([k]) => k === "background-color")?.[1] ?? d.find(([k]) => k === "background")?.[1] ?? ""; };

export function LayersPanel({ rt, itemId }: { rt: CanvasRuntime; itemId: ItemId }) {
  const committed = rt.client.get().committed?.items[itemId];
  const hash = committed?.kind === "html-snapshot" ? committed.assetManifest[committed.entry]?.hash ?? null : null;
  const [source, setSource] = useState<{ hash: string; text: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [size, setSize] = useState<{ pid: string; w: number; h: number } | null>(null);
  const [open, setOpen] = useState(store.get);

  useEffect(() => {
    if (!hash) return;
    let live = true;
    sourceOf(hash, rt).then((text) => { if (live) setSource({ hash, text }); }, () => {});
    return () => { live = false; };
  }, [hash]);
  const tree = useMemo(() => (source ? pieceTree(source.text) : null), [source]);
  // Rows from an older source than the committed one are shown but take no edits until the new source arrives.
  const stale = !source || source.hash !== hash;
  const byPid = useMemo(() => { const m = new Map<string, PieceNode>(); const walk = (n: PieceNode) => { m.set(n.pid, n); n.children.forEach(walk); }; if (tree) walk(tree); return m; }, [tree]);

  // A click on a piece in the live object selects its row, and opens the branches above it.
  useEffect(() => rt.onPiece((e) => {
    if (e.itemId !== itemId) return;
    if (e.kind === "rect") { if (e.pid) setSize({ pid: e.pid, w: e.w ?? 0, h: e.h ?? 0 }); return; }
    if (!e.pid) return;
    setSelected(e.pid);
    if (tree) {
      const path: string[] = [];
      const find = (n: PieceNode): boolean => { if (n.pid === e.pid) return true; for (const c of n.children) if (find(c)) { path.push(n.pid); return true; } return false; };
      if (find(tree)) setExpanded((s) => new Set([...s, ...path]));
    }
  }), [rt, itemId, tree]);
  // The outline in the object follows the hovered row, else the selected one. It is redrawn after each reload.
  const load = rt.frames.load.get(itemId);
  useEffect(() => { rt.highlight(itemId, hovered ?? selected); }, [rt, itemId, hovered, selected, load, rt.frames.gen.get(itemId)]);
  useEffect(() => () => rt.highlight(itemId, null), [rt, itemId]);
  // An object saved before pieces had ids lists them as ?0, ?1, …, which the page cannot outline. Stamp it once.
  const stampedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!source || stale || stampedFor.current === source.hash || ![...byPid.keys()].some((p) => p.startsWith("?"))) return;
    stampedFor.current = source.hash;
    void rt.client.submit({ type: "editObject", itemId, edits: [] });
  }, [rt, itemId, source, byPid, stale]);
  // A piece that disappeared (an agent removed it) is no longer selected.
  useEffect(() => { if (selected && tree && !byPid.has(selected)) setSelected(null); }, [tree, byPid, selected]);

  /** Resolves true once the service commits the edit. */
  const edit = (pid: string, e: Omit<EditInput, "at">): Promise<boolean> => {
    if (stale) return Promise.resolve(false);
    setPending((s) => new Set([...s, pid]));
    return rt.client.submit({ type: "editObject", itemId, edits: [{ at: pid, ...e }] }).settled()
      .then((o) => o.status === "committed", () => false)
      .finally(() => setPending((s) => { const n = new Set(s); n.delete(pid); return n; }));
  };

  if (!tree) return <aside className="panel screens-inspector screens-layers" aria-label="Layers"><div className="panel-head"><span>Layers</span></div></aside>;
  const sel = selected ? byPid.get(selected) ?? null : null;

  const rows: React.ReactNode[] = [];
  const walk = (n: PieceNode, depth: number) => {
    for (const c of n.children) {
      const isOpen = expanded.has(c.pid);
      rows.push(
        <div key={c.pid} className={`layer-row${c.hidden ? " screens-hidden-row" : ""}`} role="treeitem" aria-selected={selected === c.pid} aria-level={depth + 1} aria-disabled={stale || undefined}
          aria-expanded={c.children.length ? isOpen : undefined} data-piece={c.pid} style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => setSelected(c.pid)} onDoubleClick={() => setRenaming(c.pid)}
          onPointerEnter={() => setHovered(c.pid)} onPointerLeave={() => setHovered((h) => (h === c.pid ? null : h))}>
          {c.children.length
            ? <button className="screens-disclosure" aria-label={isOpen ? "Collapse" : "Expand"} onClick={(ev) => { ev.stopPropagation(); setExpanded((s) => { const x = new Set(s); if (x.has(c.pid)) x.delete(c.pid); else x.add(c.pid); return x; }); }}>
                <Icon name="chevron" className={`icon chevron${isOpen ? " open" : ""}`} /></button>
            : <span className="screens-disclosure" />}
          <Icon name={KIND_ICON[c.kind]} className="icon kind" />
          {renaming === c.pid
            ? <NameInput initial={c.name ?? ""} placeholder={c.label || c.tag} onDone={(v) => { setRenaming(null); if (v !== null && v !== (c.name ?? "")) void edit(c.pid, { name: v === "" ? null : v }); }} />
            : <span className="name" title={labelOf(c)}>{labelOf(c)}</span>}
          {pending.has(c.pid) && <span className="spinner screens-mini-spinner" aria-label="Saving" />}
          <span className="trail" style={c.hidden ? { opacity: 1 } : undefined}>
            <button className="icon-button small" aria-label={c.hidden ? `Show ${labelOf(c)}` : `Hide ${labelOf(c)}`} onClick={(ev) => { ev.stopPropagation(); void edit(c.pid, { hidden: !c.hidden }); }}>
              <Icon name={c.hidden ? "eye-off" : "eye"} />
            </button>
          </span>
        </div>,
      );
      if (isOpen) walk(c, depth + 1);
    }
  };
  walk(tree, 0);

  const toggle = () => { const next = !open; setOpen(next); store.set(next); };
  return (
    <aside className="panel screens-inspector screens-layers" aria-label="Layers">
      <div className="panel-head"><span className="screens-panel-title">Layers</span></div>
      <div className="panel-body" role="tree" aria-label="Pieces">{rows.length ? rows : <span className="screens-muted">No pieces</span>}</div>
      {sel && (
        <div className="inspector-section screens-piece-details">
          <button className="inspector-section-head screens-details-head" aria-expanded={open} aria-label={`Details of ${labelOf(sel)}`} onClick={toggle}>
            <span className="name">{labelOf(sel)}</span><Icon name="chevron-down" className={`icon${open ? " open" : ""}`} />
          </button>
          {open && <Details key={sel.pid} n={sel} size={size?.pid === sel.pid ? size : null} onEdit={(e) => edit(sel.pid, e)} />}
        </div>
      )}
    </aside>
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
