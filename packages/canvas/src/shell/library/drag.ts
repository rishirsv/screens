// Pointer drag with stacks for the library, the Media drawer and the canvas drop target.
// Sources start a drag from a pointerdown; targets register an element. A drag never changes anything until it drops.

import type { DroppedImage } from "../../engine/index.ts";

export interface DragPayload {
  readonly kind: "screen" | "folder" | "media";
  readonly ids: readonly string[];
  /** For media: what the canvas needs to place it. */
  readonly images?: readonly DroppedImage[];
  readonly from: "grid" | "drawer";
}
export interface DropSpec {
  /** A short hint ("Move to Fitness"), or null to refuse this payload. */
  accepts(p: DragPayload): string | null;
  drop(p: DragPayload, client: { x: number; y: number }): void;
  /** Called after the drag hovers here for SPRING_MS. */
  spring?(): void;
}

export const SPRING_MS = 700;
const THRESHOLD = 6;
const targets = new WeakMap<Element, DropSpec>();
let active = false, endedAt = 0;

/** Ref callback for a drop target. */
export function dropTarget(spec: DropSpec): (el: HTMLElement | null) => void {
  return (el) => { if (el) targets.set(el, spec); };
}
/** True right after a drag ended, so the click it produced is ignored. */
export const justDragged = () => performance.now() - endedAt < 50;
export const dragging = () => active;

const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function findTarget(x: number, y: number): { el: HTMLElement; spec: DropSpec } | null {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el) { const spec = targets.get(el); if (spec) return { el, spec }; el = el.parentElement; }
  return null;
}

/** Arms a drag from a pointerdown. It starts after THRESHOLD px; before that the pointer is an ordinary click. */
export function armDrag(e: PointerEvent | React.PointerEvent, payload: () => DragPayload, thumbs: () => readonly HTMLElement[], onStart?: () => void): void {
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY, pointerId = e.pointerId;
  let started = false, ghost: HTMLDivElement | null = null, hint: HTMLDivElement | null = null, p: DragPayload | null = null, srcs: readonly HTMLElement[] = [];
  let over: { el: HTMLElement; spec: DropSpec } | null = null, springTimer: ReturnType<typeof setTimeout> | null = null;
  const home = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect?.() ?? null;

  const place = (x: number, y: number) => { if (ghost) ghost.style.transform = `translate(${x - 40}px, ${y - 40}px)`; };
  const setOver = (t: typeof over) => {
    if (t?.el === over?.el) return;
    over?.el.removeAttribute("data-drop-over");
    if (springTimer) { clearTimeout(springTimer); springTimer = null; }
    over = t;
    if (t) {
      t.el.setAttribute("data-drop-over", "");
      if (t.spec.spring) springTimer = setTimeout(() => { if (over === t) { t.el.setAttribute("data-spring", ""); setTimeout(() => t.el.removeAttribute("data-spring"), 400); t.spec.spring!(); } }, SPRING_MS);
    }
    if (hint) { hint.textContent = t && p ? t.spec.accepts(p) ?? "" : ""; hint.hidden = !hint.textContent; }
  };
  const start = () => {
    started = true; active = true; p = payload(); srcs = thumbs().filter(Boolean);
    onStart?.();
    for (const s of srcs) s.setAttribute("data-drag-source", "");
    ghost = document.createElement("div"); ghost.className = "screens-drag-ghost"; ghost.setAttribute("aria-hidden", "true");
    srcs.slice(0, 3).forEach((s, k) => {
      const card = document.createElement("div"); card.className = "card";
      card.style.transform = `rotate(${(k - (Math.min(3, srcs.length) - 1) / 2) * 6}deg)`; card.style.zIndex = String(3 - k);
      const img = s.querySelector("img"); if (img) card.appendChild(img.cloneNode());
      ghost!.appendChild(card);
    });
    if (p.ids.length > 1) { const c = document.createElement("div"); c.className = "count"; c.textContent = String(p.ids.length); ghost.appendChild(c); }
    hint = document.createElement("div"); hint.className = "hint"; hint.hidden = true; ghost.appendChild(hint);
    document.body.appendChild(ghost);
  };
  const finish = (dropAt: { x: number; y: number } | null) => {
    removeEventListener("pointermove", move, true); removeEventListener("pointerup", up, true); removeEventListener("pointercancel", cancel, true); removeEventListener("keydown", key, true);
    if (springTimer) clearTimeout(springTimer);
    if (!started) return;
    active = false; endedAt = performance.now();
    for (const s of srcs) s.removeAttribute("data-drag-source");
    const t = over; over?.el.removeAttribute("data-drop-over");
    const g = ghost;
    if (dropAt && t && p && t.spec.accepts(p)) { g?.remove(); t.spec.drop(p, dropAt); return; }
    // A miss or Esc: the stack flies home.
    if (!g) return;
    if (!home || reduce()) { g.remove(); return; }
    g.animate([{ transform: g.style.transform, opacity: 1 }, { transform: `translate(${home.left + home.width / 2 - 40}px, ${home.top + home.height / 2 - 40}px) scale(.85)`, opacity: 0.2 }],
      { duration: 240, easing: "cubic-bezier(.16,1,.3,1)" }).onfinish = () => g.remove();
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    if (!started) { if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < THRESHOLD) return; start(); }
    place(ev.clientX, ev.clientY);
    const t = findTarget(ev.clientX, ev.clientY);
    setOver(t && p && t.spec.accepts(p) ? t : null);
  };
  const up = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish({ x: ev.clientX, y: ev.clientY }); };
  const cancel = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish(null); };
  const key = (ev: KeyboardEvent) => { if (ev.key === "Escape" && started) { ev.stopPropagation(); ev.preventDefault(); finish(null); } };
  addEventListener("pointermove", move, true); addEventListener("pointerup", up, true); addEventListener("pointercancel", cancel, true); addEventListener("keydown", key, true);
}
