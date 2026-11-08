// Agents on the canvas: cursors, target rings, captions, placeholders for objects on their way, the roster, off-screen
// markers and the live region. Draws presence only; a placeholder is never a saved item (dashed means not saved).

import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Participant, ScreenState } from "@screens/client";
import type { ItemId, Rect } from "@screens/core";
import type { DisplayItem } from "../engine/index.ts";
import type { CanvasRuntime } from "./runtime.ts";
import { activityOf, anchorOf, colorOf, isIdle, PRESENCE_IDLE_FADE_MS, type Anchor } from "./presence.ts";
import { Icon } from "./icons.tsx";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const initial = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

/** Re-renders when the next participant crosses the idle line, so faded cursors need no message from the service. */
function useIdleClock(roster: readonly Participant[], skew: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = Date.now();
    const next = roster.filter((p) => !p.call).map((p) => p.activeAt + skew + PRESENCE_IDLE_FADE_MS - t).filter((d) => d > 0);
    if (!next.length) return;
    const h = setTimeout(() => setNow(Date.now()), Math.min(...next) + 50);
    return () => clearTimeout(h);
  }, [roster, skew, now]);
  return now;
}

interface Placed { readonly p: Participant; readonly a: Anchor | null; readonly slot: number }
function place(roster: readonly Participant[], items: ReadonlyMap<ItemId, DisplayItem>): Placed[] {
  const taken = new Map<string, number>();
  return roster.map((p) => {
    const a = anchorOf(p, items), slot = a ? taken.get(a.key) ?? 0 : 0;
    if (a) taken.set(a.key, slot + 1);
    return { p, a, slot };
  });
}

/** World layer: rings and captions on targets, placeholders, reveals and cursors. */
export const PresenceLayer = memo(function PresenceLayer({ rt, roster, skew, items, hidden, drafts, following }: {
  rt: CanvasRuntime; roster: readonly Participant[]; skew: number; items: readonly DisplayItem[]; hidden: ReadonlySet<string>;
  drafts: ScreenState["drafts"]; following: string | null;
}) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const now = useIdleClock(roster, skew);
  const placed = place(roster, byId);
  const reveals = useReveals(roster, byId);
  const live = liveDrafts(roster, drafts, following);
  const fa = rt.client.get().frameAccess;
  const draftFrame = (p: Participant) => {
    const d = drafts.get(p.id);
    return d && fa && live.has(p.id) ? rt.client.transportKind === "app" ? <AppDraftFrame key={`d:${p.id}`} name={p.name} text={d.text} rev={d.rev} /> : <DraftFrame key={`d:${p.id}`} name={p.name} text={d.text} rev={d.rev} src={`${fa.origin}/draft/${rt.client.screenId}?cap=${fa.capability}`} origin={fa.origin} /> : null;
  };
  return (
    <div className="presence-layer">
      {placed.map(({ p }) => {
        const inc = p.incoming;
        if (!inc || (inc.itemId && byId.has(inc.itemId))) return null;
        const r = inc.rect;
        return (
          <div key={`in:${p.id}`} className="presence-placeholder" data-presence-placeholder={p.name} data-phase={inc.phase}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h, "--pc": colorOf(p) } as CSSProperties}>
            <div className="frame-title"><span>{p.name} · {inc.phase === "checking" ? "Checking" : activityOf(p) ?? "Designing"}</span>{drafts.get(p.id)?.itemId === null && <span className="presence-draft-tag">Draft</span>}</div>
            <div className="presence-surface">{(drafts.get(p.id)?.itemId === null && draftFrame(p)) || <div className="presence-skeleton"><i /><i /><i /></div>}</div>
          </div>
        );
      })}
      {placed.map(({ p }) => {
        // A draft of an existing item: over the saved frame, dashed and labelled, taking no input so the frame stays selectable.
        const d = drafts.get(p.id), it = d?.itemId ? byId.get(d.itemId) : undefined;
        if (!it) return null;
        return (
          <div key={`du:${p.id}`} className="presence-placeholder presence-draft-over" data-presence-placeholder={p.name} data-phase="drafting"
            style={{ left: it.x, top: it.y, width: it.width, height: it.height, "--pc": colorOf(p) } as CSSProperties}>
            <div className="frame-title"><span>{p.name} · {activityOf(p) ?? "Updating"}</span><span className="presence-draft-tag">Draft</span></div>
            <div className="presence-surface">{draftFrame(p)}</div>
          </div>
        );
      })}
      {placed.map(({ p, a, slot }) => {
        if (!a || a.kind !== "item" || hidden.has(p.id)) return null;
        const r = a.rect;
        return <div key={`t:${p.id}`} className="presence-ring" style={{ left: r.x, top: r.y, width: r.w, height: r.h, "--pc": colorOf(p), outlineOffset: `calc(${4 + 3 * slot}px * var(--inv, 1))` } as CSSProperties} />;
      })}
      {reveals.map((v) => (
        <div key={`r:${v.itemId}`} style={{ "--pc": v.color } as CSSProperties}>
          <div className="presence-reveal" style={{ left: v.rect.x, top: v.rect.y, width: v.rect.w, height: v.rect.h }} />
          <div className="presence-burst" style={{ left: v.rect.x + v.rect.w, top: v.rect.y + v.rect.h }}>
            {[0, 1, 2, 3, 4, 5].map((i) => <i key={i} style={{ "--dx": `${Math.cos(i * Math.PI / 3) * 22}px`, "--dy": `${Math.sin(i * Math.PI / 3) * 22}px` } as CSSProperties} />)}
          </div>
        </div>
      ))}
      {placed.map(({ p, a, slot }) => (!a || hidden.has(p.id) ? null : (
        <Cursor key={`c:${p.id}`} rt={rt} p={p} anchor={a} slot={slot} idle={isIdle(p, skew, now)} />
      )))}
    </div>
  );
});

/** At most two drafts render live: the followed agent's, then the most advanced. The rest keep their skeleton. */
const LIVE_DRAFTS = 2;
function liveDrafts(roster: readonly Participant[], drafts: ScreenState["drafts"], following: string | null): ReadonlySet<string> {
  const ids = roster.filter((p) => drafts.has(p.id)).sort((a, b) => Number(b.id === following) - Number(a.id === following) || drafts.get(b.id)!.rev - drafts.get(a.id)!.rev);
  return new Set(ids.slice(0, LIVE_DRAFTS).map((p) => p.id));
}

/** Makes a half-written page paint: drops a tag cut off mid-way and closes an open <style>. Scripts never run in a draft. */
export function healDraft(html: string): string {
  let out = html;
  const lt = out.lastIndexOf("<");
  if (lt > out.lastIndexOf(">")) out = out.slice(0, lt);
  const lower = out.toLowerCase(), style = lower.lastIndexOf("<style");
  if (style > lower.lastIndexOf("</style")) out += "</style>";
  return out;
}

function AppDraftFrame({ name, text, rev }: { name: string; text: string; rev: number }) {
  // At most twice a second, like DraftFrame: a steady stream of parts still shows progress instead of waiting for a pause.
  const [shown, setShown] = useState({ text, rev });
  const latest = useRef({ text, rev }); latest.current = { text, rev };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), shownAt = useRef(0);
  useEffect(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => { timer.current = null; shownAt.current = Date.now(); setShown(latest.current); }, Math.max(0, 500 - (Date.now() - shownAt.current)));
  }, [text, rev]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const csp = "default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; worker-src 'none'";
  return <iframe className="presence-draft" title={`${name}'s draft`} sandbox="" srcDoc={`<meta http-equiv="Content-Security-Policy" content="${csp}">${healDraft(shown.text)}`} tabIndex={-1} data-presence-draft={name} data-draft-shown={shown.rev} />;
}

/** The draft host page on the frame origin. Text goes in by postMessage at most twice a second; the page answers with the
 *  part it is showing (data-draft-shown). */
function DraftFrame({ name, text, rev, src, origin }: { name: string; text: string; rev: number; src: string; origin: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ text, rev }); latest.current = { text, rev };
  const ready = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | null>(null), sentAt = useRef(0);
  const post = () => {
    timer.current = null; sentAt.current = Date.now();
    ref.current?.contentWindow?.postMessage({ kind: "draft", rev: latest.current.rev, html: healDraft(latest.current.text) }, origin);
  };
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== ref.current?.contentWindow || !e.data) return;
      if (e.data.kind === "draft-ready") { ready.current = true; post(); }
      else if (e.data.kind === "draft-shown" && ref.current) ref.current.dataset.draftShown = String(Number(e.data.rev) || 0);
    };
    addEventListener("message", on);
    return () => { removeEventListener("message", on); if (timer.current) clearTimeout(timer.current); };
  }, [origin]);
  useEffect(() => {
    if (!ready.current || timer.current) return;
    timer.current = setTimeout(post, Math.max(0, 500 - (Date.now() - sentAt.current)));
  }, [text, rev]);
  return <iframe ref={ref} className="presence-draft" title={`${name}'s draft`} src={src} tabIndex={-1} data-presence-draft={name} />;
}

/** An object that was a placeholder and is now saved gets a short glow and a burst where the placeholder was. */
function useReveals(roster: readonly Participant[], items: ReadonlyMap<ItemId, DisplayItem>) {
  const awaited = useRef(new Map<ItemId, string>());
  const [shown, setShown] = useState<readonly { itemId: ItemId; rect: Rect; color: string }[]>([]);
  for (const p of roster) if (p.incoming?.itemId) awaited.current.set(p.incoming.itemId, colorOf(p));
  const landed = [...awaited.current].filter(([id]) => items.has(id));
  useEffect(() => {
    if (!landed.length) return;
    for (const [id] of landed) awaited.current.delete(id);
    if (reducedMotion()) return;
    const add = landed.map(([itemId, color]) => ({ itemId, color, rect: items.get(itemId)!.rect }));
    setShown((s) => [...s, ...add]);
    // Not cleared on re-render: the next render must not cancel this reveal's end.
    setTimeout(() => setShown((s) => s.filter((x) => !add.includes(x))), 1300);
  });
  return shown;
}

/** An agent's cursor rests at its target's top-right corner (a placeholder's bottom-right), stacked 28 px per extra agent.
 *  Its label carries the name and what it is doing, at screen size, so it reads at any zoom.
 *  Moving to a new target travels an arc; the same target moving (a drag) follows at once. Writes the DOM directly. */
function Cursor({ rt, p, anchor, slot, idle }: { rt: CanvasRuntime; p: Participant; anchor: Anchor; slot: number; idle: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<{ x: number; y: number; key: string } | null>(null);
  const frame = useRef(0);
  const r = anchor.rect;
  const x = r.x + r.w, y = anchor.kind === "incoming" ? r.y + r.h : r.y;
  useLayoutEffect(() => {
    const el = ref.current!;
    const from = last.current, set = (px: number, py: number) => { el.style.transform = `translate(${px}px, ${py}px)`; last.current = { x: px, y: py, key: anchor.key }; };
    cancelAnimationFrame(frame.current);
    if (!from || from.key === anchor.key || reducedMotion()) { set(x, y); last.current = { x, y, key: anchor.key }; return; }
    const z = rt.view.camera.z, dx = x - from.x, dy = y - from.y, dist = Math.hypot(dx, dy) * z;
    const ms = Math.min(650, Math.max(250, 250 + 0.25 * dist)), side = p.color % 2 ? 1 : -1;
    const cx = from.x + dx / 2 - dy * 0.18 * side, cy = from.y + dy / 2 + dx * 0.18 * side, t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms), e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2, u = 1 - e;
      set(u * u * from.x + 2 * u * e * cx + e * e * x, u * u * from.y + 2 * u * e * cy + e * e * y);
      if (k < 1) frame.current = requestAnimationFrame(step);
      else { last.current = { x, y, key: anchor.key }; const l = el.querySelector(".presence-label"); l?.classList.remove("bump"); void (l as HTMLElement | null)?.offsetWidth; l?.classList.add("bump"); }
    };
    last.current = { ...from, key: anchor.key };
    frame.current = requestAnimationFrame(step);
  }, [x, y, anchor.key]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const busy = !!p.call;
  return (
    <div ref={ref} className={idle ? "presence-cursor idle" : "presence-cursor"} data-presence-cursor={p.name} data-anchor={anchor.itemId ?? "incoming"} aria-hidden
      style={{ "--pc": colorOf(p) } as CSSProperties}>
      <div style={{ marginTop: slot * 28 }}>
        <svg width="18" height="20" viewBox="0 0 18 20"><path d="M1 1 L16 8.5 L9 10.5 L6.5 18 Z" fill={colorOf(p)} stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" /><circle cx="14" cy="16" r="2.4" fill="#fff" /><circle cx="14" cy="16" r="1.3" fill={colorOf(p)} /></svg>
        <span className="presence-label"><b>{p.name}</b>{activityOf(p) && <span>{activityOf(p)}</span>}{busy && <span className="activity-dots"><i /><i /><i /></span>}</span>
      </div>
    </div>
  );
}

/** Stage overlay: off-screen markers, the Follow border and the live region. */
export function PresenceOverlay({ rt, roster, items, following }: { rt: CanvasRuntime; roster: readonly Participant[]; items: readonly DisplayItem[]; following: string | null }) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const live = useAnnouncements(roster, byId);
  const anchors = new Map(roster.map((p) => [p.id, anchorOf(p, byId)]));
  const followed = roster.find((p) => p.id === following);
  return (
    <>
      <Pips rt={rt} roster={roster} anchors={anchors} />
      {followed && <div className="presence-following" style={{ "--pc": colorOf(followed) } as CSSProperties} data-presence-following={followed.name} />}
      <div className="sr-only" role="status" aria-live="polite" data-presence-live>{live}</div>
    </>
  );
}

/** The roster, in the top-right chrome: faces, then one row per agent. A row follows its agent (click again to stop);
 *  the eye hides its cursor. */
export function PresenceRoster({ rt, roster, skew, items, following, hidden }: {
  rt: CanvasRuntime; roster: readonly Participant[]; skew: number; items: readonly DisplayItem[]; following: string | null; hidden: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const now = useIdleClock(roster, skew);
  const byId = new Map(items.map((it) => [it.id, it]));
  const faces = roster.slice(0, 5), more = roster.length - faces.length;
  return (
      <div className="presence-roster">
        <button className="presence-faces" aria-expanded={open} aria-label="Agents on this Screen" title={roster.map((p) => p.name).join(", ")} onClick={() => setOpen(!open)}>
          {faces.map((p) => (
            <span key={p.id} className={["presence-face", p.call && "busy", isIdle(p, skew, now) && "idle"].filter(Boolean).join(" ")} style={{ "--pc": colorOf(p) } as CSSProperties}>{initial(p.name)}</span>
          ))}
          {more > 0 && <span className="presence-more">+{more}</span>}
        </button>
        {open && (
          <div className="presence-rows" role="list">
            {roster.map((p) => {
              const on = following === p.id;
              return (
                <div key={p.id} className="presence-row" role="listitem" data-presence-row={p.name} style={{ "--pc": colorOf(p) } as CSSProperties}>
                  <button className="presence-row-main" aria-label={`Follow ${p.name}`} aria-pressed={on} title={on ? "Stop following" : "Follow"}
                    onClick={() => rt.dispatch({ type: "command", command: { kind: "follow", id: on ? null : p.id, rect: on ? null : anchorOf(p, byId)?.rect ?? null } })}>
                    <i /><b>{p.name}</b><span>{activityOf(p) ?? (isIdle(p, skew, now) ? "Idle" : "Connected")}</span>
                  </button>
                  <button className="icon-button small" aria-label={hidden.has(p.id) ? `Show ${p.name}'s cursor` : `Hide ${p.name}'s cursor`} aria-pressed={hidden.has(p.id)}
                    onClick={() => rt.toggleHidden(p.id)}><Icon name={hidden.has(p.id) ? "eye-off" : "eye"} /></button>
                </div>
              );
            })}
          </div>
        )}
      </div>
  );
}

/** Markers at the stage edge for active participants whose work is out of view. Positioned on every camera paint, outside React. */
function Pips({ rt, roster, anchors }: { rt: CanvasRuntime; roster: readonly Participant[]; anchors: ReadonlyMap<string, Anchor | null> }) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const active = roster.filter((p) => anchors.get(p.id) && (p.call || p.status || p.incoming));
  useLayoutEffect(() => {
    const paint = () => {
      const { x: cx, y: cy, z } = rt.view.camera, { width: W, height: H } = rt.view.viewport, m = 16;
      for (const p of active) {
        const el = refs.current.get(p.id), a = anchors.get(p.id); if (!el || !a) continue;
        const sx = cx + (a.rect.x + a.rect.w / 2) * z, sy = cy + (a.rect.y + a.rect.h / 2) * z;
        const out = cx + (a.rect.x + a.rect.w) * z < 0 || cx + a.rect.x * z > W || cy + (a.rect.y + a.rect.h) * z < 0 || cy + a.rect.y * z > H;
        if (!out) { el.style.display = "none"; continue; }
        const px = Math.min(W - m - 11, Math.max(m + 11, sx)), py = Math.min(H - m - 11, Math.max(m + 11, sy));
        el.style.display = "grid"; el.style.left = `${px}px`; el.style.top = `${py}px`;
        el.style.setProperty("--angle", `${Math.atan2(sy - py, sx - px)}rad`);
        el.dataset.offscreen = sx > W ? "right" : sx < 0 ? "left" : sy < 0 ? "above" : "below";
      }
    };
    paint();
    return rt.onPaint(paint);
  });
  return <>{active.map((p) => (
    <button key={p.id} ref={(el) => { if (el) refs.current.set(p.id, el); else refs.current.delete(p.id); }} className="presence-pip" data-presence-pip={p.name}
      aria-label={`Show ${p.name}, off screen`} style={{ "--pc": colorOf(p) } as CSSProperties}
      onClick={() => { const a = anchors.get(p.id); if (a) rt.dispatch({ type: "command", command: { kind: "locate", rect: a.rect } }); }}>{initial(p.name)}</button>
  ))}</>;
}

/** Joins, new statuses, saved objects and departures for a screen reader: at most one announcement every 4 s, grouped
 *  when more than two wait. Never cursors, calls or positions. */
function useAnnouncements(roster: readonly Participant[], items: ReadonlyMap<ItemId, DisplayItem>): string {
  const prev = useRef(new Map<string, Participant>());
  const queue = useRef<{ who: string; text: string }[]>([]);
  const lastAt = useRef(0);
  const [text, setText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const before = prev.current, after = new Map(roster.map((p) => [p.id, p]));
    const say = (who: string, t: string) => { queue.current = queue.current.filter((q) => q.who !== who); queue.current.push({ who, text: t }); };
    for (const p of roster) {
      const was = before.get(p.id);
      if (!was) say(p.name, `${p.name} joined`);
      else if (p.status?.text && p.status.text !== was.status?.text) say(p.name, `${p.name}: ${p.status.text}`);
      const saved = was?.incoming?.itemId && items.has(was.incoming.itemId) && !p.incoming?.itemId ? items.get(was.incoming.itemId)! : null;
      if (saved) say(p.name, `${p.name} saved ${saved.title}`);
    }
    for (const [id, p] of before) if (!after.has(id)) say(p.name, `${p.name} left`);
    prev.current = after;
    const flush = () => {
      timer.current = null;
      const q = queue.current; if (!q.length) return;
      queue.current = []; lastAt.current = Date.now();
      setText(q.length > 2 ? `${q.slice(0, -1).map((x) => x.who).join(", ")} and ${q.at(-1)!.who} updated` : q.map((x) => x.text).join(". "));
    };
    if (queue.current.length && !timer.current) timer.current = setTimeout(flush, Math.max(0, 4000 - (Date.now() - lastAt.current)));
  }, [roster, items]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return text;
}
