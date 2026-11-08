import { ContentImage } from "../content.tsx";
// The focused media view: one image large, browse with arrows, filmstrip or swipe; the inspector edits its details.

import { useEffect, useRef, useState } from "react";
import { usedIn, type LibraryCatalog, type MediaEntry, type MediaPatch } from "@screens/core";
import type { LibraryClient } from "@screens/client";
import { Icon } from "../icons.tsx";
import { navigate } from "./nav.ts";

export function MediaFocus({ items, index, catalog, lib, inspector, onInspector, onIndex, onClose, onAddToScreen }: {
  items: readonly MediaEntry[]; index: number; catalog: LibraryCatalog; lib: LibraryClient;
  inspector: boolean; onInspector: (open: boolean) => void;
  onIndex: (i: number) => void; onClose: (i: number) => void;
  onAddToScreen: (m: MediaEntry, screenId: string | null) => void;
}) {
  const m = items[index];
  const img = useRef<HTMLImageElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const [choosing, setChoosing] = useState(false);
  const chooser = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!choosing) return;
    const outside = (e: PointerEvent) => { if (!chooser.current?.contains(e.target as Node)) setChoosing(false); };
    addEventListener("pointerdown", outside);
    return () => removeEventListener("pointerdown", outside);
  }, [choosing]);
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);

  if (!m) return null;
  const step = (d: number) => onIndex((index + d + items.length) % items.length);
  let swipe: number | null = null;

  return (
    <div ref={root} className="screens-focus" role="dialog" aria-label={m.title} tabIndex={-1}
      onKeyDown={(e) => {
        if (choosing) { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setChoosing(false); } return; }
        if ((e.target as HTMLElement).closest("input, textarea, select")) return;
        if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
        else if (e.key === "Escape" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onClose(index); }
        else if (e.key.toLowerCase() === "i" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); onInspector(!inspector); }
      }}>
      <div className="screens-focus-main">
        <header className="screens-view-head">
          <div className="screens-row"><button className="icon-button" aria-label="Back to Media" onClick={() => onClose(index)}><Icon name="back" /></button></div>
          <h1 title={m.title}>{m.title}</h1>
          <div className="screens-row screens-head-actions">
            <div className="screens-destination" ref={chooser}>
              <button className="button small" aria-expanded={choosing} onClick={() => setChoosing(!choosing)}>Add to Screen</button>
              {choosing && <div className="menu screens-destination-menu" role="group" aria-label="Choose a Screen">
                {Object.values(catalog.screens).filter(s => s.archivedAt === null).sort((a, b) => a.facts.title.localeCompare(b.facts.title)).map(s =>
                  <button key={s.id} className="menu-item" title={s.facts.title} onClick={() => { setChoosing(false); onAddToScreen(m, s.id); }}>{s.facts.title}</button>)}
                {!Object.values(catalog.screens).some(s => s.archivedAt === null) && <p className="screens-muted">No Screens yet</p>}
                <button className="menu-item" onClick={() => { setChoosing(false); onAddToScreen(m, null); }}>New Screen</button>
              </div>}
            </div>
            <button className="icon-button" aria-label="Inspector" aria-pressed={inspector} title="Inspector (I)" onClick={() => onInspector(!inspector)}><Icon name="panel" /></button>
          </div>
        </header>
        <div className="screens-focus-stage"
          onPointerDown={(e) => { swipe = e.clientX; }}
          onPointerUp={(e) => { if (swipe !== null && Math.abs(e.clientX - swipe) > 50) step(e.clientX < swipe ? 1 : -1); swipe = null; }}>
          {items.length > 1 && <button className="icon-button screens-focus-prev" aria-label="Previous" onClick={() => step(-1)}><Icon name="back" /></button>}
          <ContentImage ref={img} key={m.id} hash={m.assetHash} browserUrl={`/content/${m.assetHash}`} alt={m.title} draggable={false} decoding="async" />
          {items.length > 1 && <button className="icon-button screens-focus-next" aria-label="Next" onClick={() => step(1)}><Icon name="chevron" /></button>}
        </div>
        {items.length > 1 && (
          <div className="screens-filmstrip" role="tablist" aria-label="Media">
            {filmWindow(items.length, index).map((k) => (
              <button key={items[k]!.id} role="tab" aria-selected={k === index} aria-label={items[k]!.title} onClick={() => onIndex(k)}>
                <ContentImage hash={items[k]!.assetHash} browserUrl={`/thumb/${items[k]!.assetHash}`} alt="" loading="lazy" decoding="async" draggable={false} />
              </button>
            ))}
          </div>
        )}
      </div>
      {inspector && <Inspector key={m.id} m={m} catalog={catalog} lib={lib} />}
    </div>
  );
}

/** At most 15 filmstrip cells around the current one. */
function filmWindow(n: number, i: number): number[] {
  const half = 7, from = Math.max(0, Math.min(i - half, n - 15)), to = Math.min(n, from + 15);
  return Array.from({ length: to - from }, (_, k) => from + k);
}

function Inspector({ m, catalog, lib }: { m: MediaEntry; catalog: LibraryCatalog; lib: LibraryClient }) {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const save = (patch: MediaPatch) => {
    setStatus("saving");
    // Shown as saved only once the service commits it.
    lib.submit({ type: "updateMedia", mediaId: m.id, patch }).settled().then((o) => setStatus(o.status === "committed" ? "saved" : "failed"));
  };
  const text = (k: "title" | "description" | "app" | "platform" | "screenType" | "source") => (v: string) => {
    const cur = k === "title" ? m.title : m.meta[k];
    if (v.trim() !== cur) save({ [k]: v } as MediaPatch);
  };
  const used = usedIn(catalog, m.id);
  return (
    <aside className="screens-inspector panel" aria-label="Details">
      <div className="panel-body">
        <Field label="Title" value={m.title} onCommit={text("title")} />
        <Field label="Description" value={m.meta.description} onCommit={text("description")} multiline />
        <Tags tags={m.meta.tags} onChange={(tags) => save({ tags })} />
        <div className="screens-field-pair">
          <Field label="App" value={m.meta.app} onCommit={text("app")} />
          <Field label="Platform" value={m.meta.platform} onCommit={text("platform")} />
        </div>
        <Field label="Screen type" value={m.meta.screenType} onCommit={text("screenType")} />
        <Field label="Source" value={m.meta.source} onCommit={text("source")} />
        <Field label="Captured" type="date" value={m.meta.capturedAt === null ? "" : new Date(m.meta.capturedAt).toISOString().slice(0, 10)}
          onCommit={(v) => { const t = v ? Date.parse(`${v}T00:00:00Z`) : null; if (t !== m.meta.capturedAt && (t === null || Number.isFinite(t))) save({ capturedAt: t }); }} />
        <div className="screens-field">
          <span className="screens-field-label">Used in</span>
          {used.length ? used.map((s) => <button key={s.id} className="screens-link" onClick={() => navigate({ kind: "screen", id: s.id })}>{s.facts.title}</button>)
            : <span className="screens-muted">Not in a Screen</span>}
        </div>
        <div className="screens-field screens-muted">{m.width} × {m.height} · {new Date(m.addedAt).toLocaleDateString()}{m.addedBy.kind === "agent" ? " · added by agent" : ""}</div>
        <div className="screens-save-state" role="status" data-state={status}>{status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "failed" ? "Couldn't save" : ""}</div>
      </div>
    </aside>
  );
}

function Field({ label, value, onCommit, multiline, type }: { label: string; value: string; onCommit: (v: string) => void; multiline?: boolean; type?: "date" }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const id = `f-${label.replace(/\s/g, "")}`;
  const props = { id, value: v, onChange: (e: { target: { value: string } }) => setV(e.target.value), onBlur: () => onCommit(v),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" && !multiline) (e.target as HTMLElement).blur(); if (e.key === "Escape") { setV(value); e.stopPropagation(); } } };
  return (
    <label className="screens-field" htmlFor={id}>
      <span className="screens-field-label">{label}</span>
      {multiline ? <textarea className="screens-input" rows={3} {...props} /> : <input className="screens-input" type={type} {...props} />}
    </label>
  );
}

function Tags({ tags, onChange }: { tags: readonly string[]; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="screens-field">
      <span className="screens-field-label">Tags</span>
      <div className="screens-tokens">
        {tags.map((t, i) => <span key={t} className="screens-token">{t}<button aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((_, k) => k !== i))}><Icon name="x" /></button></span>)}
        <input aria-label="Add tag" placeholder="Add tag" value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === ",") && draft.trim()) { e.preventDefault(); onChange([...tags, draft.trim()]); setDraft(""); }
            else if (e.key === "Backspace" && !draft && tags.length) onChange(tags.slice(0, -1));
            e.stopPropagation();
          }} />
      </div>
    </div>
  );
}
