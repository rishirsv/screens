// Native Screens annotations. Pins share the canvas camera; conversations are screen-space chrome.
// All writes dispatch through the engine and service. Unsent text belongs to the view, not a mounted textarea.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { threadArea, threadPoint, type Author, type Rect } from "@screens/core";
import { isUnsaved, panelThreads, presentThread, renderDocOf, type BaseDoc, type Command, type DisplayThread, type ViewState } from "../engine/index.ts";
import type { CanvasRuntime } from "./runtime.ts";
import { Icon } from "./icons.tsx";

const authorName = (a: Author) => a.kind === "agent" ? a.name.charAt(0).toUpperCase() + a.name.slice(1) : "You";
const Avatar = ({ author }: { author: Author }) => <span className={author.kind === "agent" ? "avatar agent" : "avatar"}>{authorName(author).charAt(0)}</span>;
const time = (t: number) => isUnsaved({ createdAt: t }) ? "" : new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dispatch = (rt: CanvasRuntime, command: Command) => rt.dispatch({ type: "command", command });
function useScrollActivity() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (el: HTMLElement) => {
    el.dataset.scrolling = "";
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { delete el.dataset.scrolling; }, 700);
  };
}
const targetOf = (t: DisplayThread, doc: BaseDoc) => t.anchor.kind === "item" ? doc.byId.get(t.anchor.itemId)?.title ?? "" : "Canvas";

export function CommentLayer({ rt, doc, view }: { rt: CanvasRuntime; doc: BaseDoc; view: ViewState }) {
  const draft = view.comment.draft, g = view.gesture;
  const rectOf = (id: string) => doc.byId.get(id)?.rect;
  const point = draft && threadPoint(draft, rectOf), area = draft && threadArea(draft, rectOf);
  return <>
    {doc.threads.map((t, i) => <Pin key={t.id} rt={rt} t={t} number={i + 1} doc={doc} view={view} />)}
    {g?.kind === "comment-area" && g.rect && <Area r={g.rect} active />}
    {area && <Area r={area} active />}
    {point && <div className="comment-pin new screens-pin screens-pin-draft" style={{ left: point.x, top: point.y }}><Icon name="comment" /></div>}
  </>;
}

const Area = ({ r, active, dimmed, thread }: { r: Rect; active?: boolean; dimmed?: boolean; thread?: string }) =>
  <div className={active ? "screens-comment-area active" : "screens-comment-area"} aria-hidden="true" data-area-thread={thread} style={{ left: r.x, top: r.y, width: r.w, height: r.h, opacity: dimmed ? 0.45 : undefined }} />;

function Pin({ rt, t, number, doc, view }: { rt: CanvasRuntime; t: DisplayThread; number: number; doc: BaseDoc; view: ViewState }) {
  const p = presentThread(t, view, doc);
  if (!p.visible || !p.point) return null;
  const first = t.comments[0]!;
  const sync = t.sync === "failed" || t.comments.some((c) => c.sync === "failed") ? "failed"
    : t.sync === "pending" || t.comments.some((c) => c.sync === "pending") ? "pending" : "committed";
  const area = threadArea(t, (id) => doc.byId.get(id)?.rect), base = threadPoint(t, (id) => doc.byId.get(id)?.rect);
  const shown = area && base ? { ...area, x: area.x + p.point.x - base.x, y: area.y + p.point.y - base.y } : null;
  const open = () => dispatch(rt, { kind: "open-thread", threadId: p.active ? null : t.id });
  return <>
    {shown && <Area r={shown} active={p.active} dimmed={p.dimmed || t.resolved} thread={t.id} />}
    <div className={["comment-pin", "screens-pin", p.active && "active", t.resolved && "resolved"].filter(Boolean).join(" ")}
      data-hit={`thread:${t.id}`} data-thread={t.id} data-sync={sync}
      data-preview={!p.active && (view.tool === "comment" || view.comment.activeThreadId === t.id) ? "" : undefined}
      style={{ left: p.point.x, top: p.point.y, opacity: p.dimmed ? 0.45 : 1 }}>
      <span className="screens-pin-number" role="button" tabIndex={0} aria-label={`Comment ${number} by ${authorName(first.author)}`} aria-expanded={p.active}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}>{number}</span>
      {!p.active && <button className="screens-comment-preview" aria-label={`Open comment ${number}`} onClick={open}>
        <span>{first.text}</span>{t.comments.length > 1 && <span className="screens-muted">{t.comments.length - 1} {t.comments.length === 2 ? "reply" : "replies"}</span>}
        {sync === "failed" && <span className="screens-muted">Not saved</span>}
        {sync === "pending" && <span className="spinner screens-mini-spinner" aria-label="Saving" />}
      </button>}
    </div>
  </>;
}

/** One active surface, outside the transformed world. Camera-only paints also move it. */
export function CommentOverlay({ rt, doc, view }: { rt: CanvasRuntime; doc: BaseDoc; view: ViewState }) {
  const ref = useRef<HTMLDivElement>(null);
  const t = view.comment.activeThreadId ? doc.threadById.get(view.comment.activeThreadId) : undefined;
  const draft = view.comment.draft;
  const present = view.pages.view === "present";
  const visible = !present && !(view.viewport.width <= 700 && view.comment.panelOpen) && (!!draft || (!!t && view.comment.expanded && presentThread(t, view, doc).visible));
  useLayoutEffect(() => {
    const el = ref.current, stage = rt.stage;
    if (!el || !stage || !visible) return;
    const tokens = getComputedStyle(stage);
    const inset = parseFloat(tokens.getPropertyValue("--chrome-inset"));
    const gap = parseFloat(tokens.getPropertyValue("--space-1"));
    const pinSize = parseFloat(tokens.getPropertyValue("--control-md"));
    const paint = () => {
      const v = rt.view, source = v.comment.draft ?? (v.comment.activeThreadId ? rt.doc().threadById.get(v.comment.activeThreadId) : null);
      const gesture = v.gesture;
      const items = renderDocOf(rt.doc(), gesture?.kind === "item-drag" || gesture?.kind === "item-resize" ? gesture.preview : null);
      const p = source && threadPoint(source, (id) => items.byId.get(id)?.rect);
      if (!p) { el.style.visibility = "hidden"; return; }
      const compact = v.viewport.width <= 700;
      const active = !v.comment.draft && v.comment.activeThreadId ? items.threadById.get(v.comment.activeThreadId) : undefined;
      const anchor = active ? presentThread(active, v, items).point ?? p : p;
      const x = v.camera.x + anchor.x * v.camera.z, y = v.camera.y + anchor.y * v.camera.z;
      el.style.visibility = compact || (x >= 0 && y >= 0 && x <= stage.clientWidth && y <= stage.clientHeight) ? "visible" : "hidden";
      if (compact) { el.style.left = ""; el.style.top = ""; return; }
      const w = el.offsetWidth, h = el.offsetHeight;
      const clampX = (n: number) => Math.max(inset, Math.min(n, stage.clientWidth - w - inset));
      const clampY = (n: number) => Math.max(inset, Math.min(n, stage.clientHeight - h - inset));
      const origin = stage.getBoundingClientRect();
      const obstacles = [...stage.querySelectorAll<HTMLElement>(".screens-right, .screens-tools, .screens-zoom, .screens-pages-controls, .screens-canvas-head")]
        .filter((e) => e.offsetWidth && e.offsetHeight).map((e) => { const r = e.getBoundingClientRect(); return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }; });
      const candidates = [[x + pinSize + gap, y - pinSize], [x - w - gap, y - pinSize], [x + pinSize + gap, y - h], [x - w - gap, y - h], [x, y + gap]];
      const positions = candidates.map(([a, b]) => ({ x: clampX(a!), y: clampY(b!) }));
      const at = positions.find((p) => !obstacles.some((r) => p.x < r.x + r.w + gap && p.x + w + gap > r.x && p.y < r.y + r.h + gap && p.y + h + gap > r.y)) ?? positions[0]!;
      el.style.left = `${at.x}px`; el.style.top = `${at.y}px`;
    };
    paint();
    const unsub = rt.onPaint(paint), ro = new ResizeObserver(paint);
    ro.observe(el); ro.observe(stage);
    return () => { unsub(); ro.disconnect(); };
  }, [rt, visible, t, draft, view.comment.panelOpen, view.viewport.width]);
  useEffect(() => {
    if (!visible) return;
    const id = t?.id;
    return () => {
      if (document.activeElement === document.body || ref.current?.contains(document.activeElement)) {
        const pin = id ? rt.stage?.querySelector<HTMLElement>(`.screens-pin[data-thread="${CSS.escape(id)}"] .screens-pin-number`) : null;
        (pin ?? rt.stage)?.focus({ preventScroll: true });
      }
    };
  }, [visible, t?.id, rt]);
  if (!visible) return null;
  return <div ref={ref} className="chrome screens-comment-popover" role="region" aria-label={draft ? "New comment" : "Comment thread"}>
    {draft ? <Composer key={draft.id} rt={rt} label="New comment" draftKey={`new:${draft.id}`} disabled={false} />
      : t && <ThreadDetail key={t.id} rt={rt} t={t} view={view} target={targetOf(t, doc)} />}
  </div>;
}

function ThreadDetail({ rt, t, view, target, readOnly = false }: { rt: CanvasRuntime; t: DisplayThread; view: ViewState; target: string; readOnly?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolling = useScrollActivity();
  const followReplies = useRef(true);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const saved = !isUnsaved(t) && !t.removing;
  useLayoutEffect(() => { const el = scrollRef.current; if (el && followReplies.current) el.scrollTop = el.scrollHeight; }, [t.comments.length]);
  return <div className="screens-thread-open" data-thread-card={t.id}>
    <div className="screens-thread-head">
      <span className="comment-target" title={target}>{target}</span>
      {!readOnly && <button className="button small" disabled={!saved} onClick={() => dispatch(rt, { kind: "resolve-thread", threadId: t.id, resolved: !t.resolved })}>
        {!t.resolved && <Icon name="check" />}{t.resolved ? "Reopen" : "Resolve"}</button>}
      <button className="icon-button small" aria-label="Close" onClick={() => dispatch(rt, { kind: "open-thread", threadId: null })}><Icon name="x" /></button>
    </div>
    <div ref={scrollRef} className="screens-thread-messages screens-comment-scroll" role="region" aria-label="Conversation" tabIndex={0} onScroll={(e) => {
      const el = e.currentTarget;
      followReplies.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
      scrolling(el);
    }}>
      {t.comments.map((c, i) => <div key={c.id} className="comment-thread" data-comment={c.id} data-sync={c.sync} style={{ opacity: c.removing ? 0.45 : 1 }}>
        <div className="comment-head">
          <Avatar author={c.author} /><span className="comment-author">{authorName(c.author)}</span><span className="comment-time">{time(c.createdAt)}</span>
          {c.sync === "pending" && <span className="spinner screens-mini-spinner" aria-label="Saving" />}
          {c.sync === "failed" && <span className="comment-time" role="status">Not saved</span>}
          <span className="spacer" />
          {!readOnly && <>
            {c.author.kind === "person" && <button className="icon-button small" aria-label="Edit comment" disabled={!saved || c.sync !== "committed"} onClick={() => {
              const key = `edit:${c.id}`;
              if (!rt.commentDrafts.has(key)) rt.commentDrafts.set(key, { text: c.text, expectedText: c.text });
              dispatch(rt, { kind: "edit-comment", commentId: c.id });
            }}><Icon name="pencil" /></button>}
            <button className={confirmDelete === c.id ? "button small" : "icon-button small"} aria-label={i === 0 ? "Delete thread" : "Delete comment"}
              onBlur={() => setConfirmDelete(null)} disabled={!saved || c.sync !== "committed"}
              onClick={() => { if (i === 0 && confirmDelete !== c.id) setConfirmDelete(c.id); else { setConfirmDelete(null); dispatch(rt, { kind: "delete-comment", threadId: t.id, commentId: c.id }); } }}>{confirmDelete === c.id ? "Delete thread?" : <Icon name="trash" />}</button>
          </>}
        </div>
        {view.comment.editingCommentId === c.id && !readOnly
          ? <Composer key={`edit:${c.id}`} rt={rt} label="Edit comment" draftKey={`edit:${c.id}`} disabled={!saved || c.sync !== "committed"} edit />
          : <div className="comment-body">{c.text}</div>}
      </div>)}
    </div>
    {!readOnly && !view.comment.editingCommentId && <Composer key={`reply:${t.id}`} rt={rt} label="Reply" draftKey={`reply:${t.id}`} disabled={!saved} onSubmit={() => { followReplies.current = true; }} />}
  </div>;
}

function Composer({ rt, label, draftKey, disabled, edit = false, onSubmit }: { rt: CanvasRuntime; label: string; draftKey: string; disabled: boolean; edit?: boolean; onSubmit?: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const cached = rt.commentDrafts.get(draftKey);
  const [blank, setBlank] = useState(!cached?.text.trim());
  const resize = () => { const el = ref.current; if (el) { el.style.height = ""; el.style.height = `${Math.min(192, el.scrollHeight)}px`; } };
  useEffect(() => {
    if (disabled) return;
    const f = requestAnimationFrame(() => {
      ref.current?.focus({ preventScroll: true }); resize();
      if (rt.commentDrafts.get(draftKey)?.text.trim()) rt.dispatch({ type: "comment-composing", on: true });
    });
    return () => cancelAnimationFrame(f);
  }, [disabled, draftKey, rt]);
  const cancel = () => {
    rt.commentDrafts.delete(draftKey);
    rt.dispatch({ type: "comment-cancel" });
    rt.stage?.focus({ preventScroll: true });
  };
  const send = () => {
    const el = ref.current, value = rt.commentDrafts.get(draftKey);
    if (!el?.value.trim() || disabled) return;
    if (edit && el.value.trim() === value?.expectedText) { cancel(); return; }
    onSubmit?.();
    rt.dispatch({ type: "comment-submit", text: el.value, ...(edit ? { expectedText: value?.expectedText } : {}) });
    // The pending ledger now owns submitted text, including failed saves and Retry.
    rt.commentDrafts.delete(draftKey);
    if (!edit) { el.value = ""; el.style.height = ""; setBlank(true); }
    if (label === "New comment") rt.stage?.focus({ preventScroll: true });
  };
  return <div className={edit ? "screens-comment-editor" : "screens-comment-editor screens-comment-composer"}>
    <textarea ref={ref} aria-label={label} placeholder={label === "New comment" ? "Add a comment…" : label} defaultValue={cached?.text ?? ""} rows={1} maxLength={5000} disabled={disabled}
      onInput={(e) => {
        const text = e.currentTarget.value;
        rt.commentDrafts.set(draftKey, { ...rt.commentDrafts.get(draftKey), text });
        setBlank(!text.trim()); resize();
        const on = edit ? text !== rt.commentDrafts.get(draftKey)?.expectedText : !!text.trim();
        if (on !== rt.view.comment.composing) rt.dispatch({ type: "comment-composing", on });
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      }} />
    <div className="screens-comment-editor-actions">
      <button className="button small" onClick={cancel}>Cancel</button>
      <button className="button small primary" aria-label={edit ? "Save comment" : "Send"} disabled={blank || disabled} onClick={send}>{edit ? "Save" : label === "New comment" ? "Comment" : "Reply"}</button>
    </div>
  </div>;
}

/** Optional index; playback uses the same thread content without editing controls. */
export function CommentsPanel({ rt, doc, view }: { rt: CanvasRuntime; doc: BaseDoc; view: ViewState }) {
  const present = view.pages.view === "present";
  const scrolling = useScrollActivity();
  const compact = view.viewport.width <= 700;
  const rows = panelThreads(doc, view).filter((t) => !present || (view.focus.mode === "focused" && t.anchor.kind === "item" && t.anchor.itemId === view.focus.itemId));
  return <div id="screens-comments" className="panel screens-comments-panel" role="region" aria-label="Comments">
    <div className="panel-head"><span>Comments</span><span className="spacer" />
      {doc.threads.some((t) => t.resolved) && <label className="screens-check"><input type="checkbox" aria-label="Resolved" checked={view.comment.showResolved}
        onChange={(e) => dispatch(rt, { kind: "comment-filter", showResolved: e.currentTarget.checked })} />Resolved</label>}
      <button className="icon-button small" aria-label="Hide comments" onClick={() => dispatch(rt, { kind: "comments-panel", open: false })}><Icon name="x" /></button>
    </div>
    <div className="panel-body screens-comment-scroll" onScroll={(e) => scrolling(e.currentTarget)}>
      {compact && !present && view.comment.draft && <Composer key={view.comment.draft.id} rt={rt} label="New comment" draftKey={`new:${view.comment.draft.id}`} disabled={false} />}
      {!rows.length && !view.comment.draft && <span className="screens-muted">No open comments</span>}
      {rows.map((t) => {
        const first = t.comments[0]!, target = targetOf(t, doc), number = doc.threads.findIndex((x) => x.id === t.id) + 1;
        if ((present || compact) && view.comment.expanded && view.comment.activeThreadId === t.id) return <div key={t.id} data-thread-row={t.id}><ThreadDetail rt={rt} t={t} view={view} target={target} readOnly={present} /></div>;
        return <button key={t.id} className={t.resolved ? "comment-thread resolved screens-row-button" : "comment-thread screens-row-button"}
          data-thread-row={t.id} aria-label={`Open comment ${number}`} aria-pressed={view.comment.activeThreadId === t.id && view.comment.expanded}
          onClick={() => dispatch(rt, { kind: "open-thread", threadId: t.id })}>
          <span className="comment-head"><Avatar author={first.author} /><span className="comment-author">{authorName(first.author)}</span>
            <span className="comment-time">{time(first.createdAt)}</span><span className="comment-time">{t.comments.length > 1 ? `${t.comments.length - 1} ${t.comments.length === 2 ? "reply" : "replies"}` : ""}</span></span>
          <span className="comment-target" title={target}>{target}</span><span className="comment-body">{first.text}</span>
        </button>;
      })}
    </div>
  </div>;
}
