// Dev-only, read-only window.__screensTest for screens-cli. Compiled in only when the service runs with --dev
// (main.tsx, __SCREENS_TEST__). It reads state and locates targets; it never dispatches input or changes the
// runtime, so a person's real input stays the only way to change the canvas. It exposes no token or capability.
// No top-level side effects: production bundles tree-shake this module away.

import type { ItemId } from "@screens/core";
import type { ScreenState } from "@screens/client";
import { HANDLES, toJson, type CanvasInput, type Handle, type TraceEvent, type TraceFile, type ViewState } from "../engine/index.ts";
import { hitTargetOf, type CanvasRuntime } from "./runtime.ts";

export type ProbeRoot = "view" | "pending" | "frames" | "presence" | "history" | "dom";
export type TargetSpec =
  | { readonly kind: "item"; readonly id: ItemId; readonly part: "surface" | "title" | "focus" | Handle; readonly offset: { readonly x: number; readonly y: number } | null }
  | { readonly kind: "stroke"; readonly id: string }
  /** A thread's pin, or its row in the Comments panel. */
  | { readonly kind: "thread"; readonly id: string; readonly part: "pin" | "row" }
  /** A comment's Delete button in the open card. */
  | { readonly kind: "comment"; readonly id: string }
  | { readonly kind: "background"; readonly at: { readonly x: number; readonly y: number } | null }
  | { readonly kind: "world"; readonly at: { readonly x: number; readonly y: number } }
  | { readonly kind: "ui"; readonly label: string };
/** Viewport CSS px for real input, and whether the element there is the intended target. */
export interface Located { readonly x: number; readonly y: number; readonly ok: boolean; readonly coveredBy: string | null; readonly onScreen: boolean; readonly found: boolean }

/** Exhaustive over ViewState: a new view field fails typecheck until the probe includes it or says why not. */
export const VIEW_PROBE = {
  viewport: "include", pointer: "include", dpr: "include", theme: "include", camera: "include", autoFit: "include", moving: "include",
  animation: "summary", focus: "summary", tool: "include", spacePanning: "include", pencil: "include", selection: "summary", interacting: "include",
  gesture: "summary", wheel: "omit:transient wheel accumulator", editing: "summary", comment: "include", deferredCommand: "summary", following: "include",
  invertScroll: "include", capabilities: "include", pages: "include",
} as const satisfies Record<keyof ViewState, "include" | "summary" | `omit:${string}`>;

/** What the person sees of agents: cursors and what they rest on, their labels, placeholders and their phase, off-screen markers,
 *  the Follow border, the roster faces and the live region. Keyed by name with spaces as "-". */
function presenceDom(): Record<string, unknown> {
  const key = (el: Element, attr: string) => (el.getAttribute(attr) ?? "").replace(/\s+/g, "-");
  const all = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
  return {
    cursors: Object.fromEntries(all("[data-presence-cursor]").map((el) => [key(el, "data-presence-cursor"), el.classList.contains("idle") ? "idle" : el.dataset.anchor])),
    labels: Object.fromEntries(all("[data-presence-cursor]").map((el) => [key(el, "data-presence-cursor"), el.querySelector(".presence-label")?.textContent?.trim() ?? ""])),
    placeholders: Object.fromEntries(all("[data-presence-placeholder]").map((el) => [key(el, "data-presence-placeholder"), el.dataset.phase])),
    /** Draft frames: the part the frame says it shows, or "loading". Agents beyond the live limit have none. */
    drafts: Object.fromEntries(all("[data-presence-draft]").map((el) => [key(el, "data-presence-draft"), el.dataset.draftShown ? Number(el.dataset.draftShown) : "loading"])),
    pips: Object.fromEntries(all("[data-presence-pip]").filter((el) => el.style.display === "grid").map((el) => [key(el, "data-presence-pip"), el.dataset.offscreen])),
    following: document.querySelector("[data-presence-following]")?.getAttribute("data-presence-following") ?? null,
    faces: all(".presence-face").length,
    live: document.querySelector("[data-presence-live]")?.textContent ?? "",
  };
}

function summarizeView(v: ViewState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, how] of Object.entries(VIEW_PROBE) as [keyof ViewState, string][]) {
    if (how === "include") out[k] = toJson(v[k]);
    else if (how === "summary") out[k] = summary(v, k);
  }
  return out;
}
function summary(v: ViewState, k: keyof ViewState): unknown {
  switch (k) {
    case "animation": return v.animation ? v.animation.then : null;
    case "focus": return v.focus.mode === "none" ? "none" : `${v.focus.mode}:${v.focus.itemId}`;
    case "selection": return v.selection.kind === "items" ? [...v.selection.ids] : `stroke:${v.selection.id}`;
    case "gesture": return v.gesture ? v.gesture.kind : null;
    case "editing": return v.editing ? (v.editing.kind === "item-title" ? `item-title:${v.editing.itemId}` : v.editing.kind) : null;
    case "deferredCommand": return v.deferredCommand ? v.deferredCommand.kind : null;
    default: return null;
  }
}

const busyStatus = (s: string) => s === "uploading" || s === "sending" || s === "accepted";
/** The error toast's message, without its button labels. */
function toastText(): string | null {
  const t = document.querySelector(".toast.error"); if (!t) return null;
  const c = t.cloneNode(true) as Element; c.querySelectorAll("button").forEach((b) => b.remove());
  return c.textContent?.trim() || null;
}

export interface ScreensTestHook {
  readonly version: 1;
  readonly sessionId: string;
  probe(roots: readonly ProbeRoot[]): Record<string, unknown>;
  locate(t: TargetSpec): Located;
  idle(): boolean;
  readonly trace: { start(): void; stop(): TraceFile | null };
}

export function installTestHook(rt: CanvasRuntime): void {
  const client = rt.client;
  const itemEl = (id: string) => document.querySelector<HTMLElement>(`[data-item="${CSS.escape(id)}"]`);
  const describe = (el: Element | null) => !el ? "nothing" : `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}`;

  /** The canvas stage while a Screen is open; the whole window on a library page. */
  const bounds = () => (rt.stage?.isConnected ? rt.stage.getBoundingClientRect() : new DOMRect(0, 0, innerWidth, innerHeight));
  /** A visible point of el that is actually on top, preferring its centre. */
  const pointIn = (el: Element, accept: (hit: Element | null) => boolean): Located => {
    const stage = bounds();
    const r = el.getBoundingClientRect();
    const x0 = Math.max(r.left, stage.left), x1 = Math.min(r.right, stage.right), y0 = Math.max(r.top, stage.top), y1 = Math.min(r.bottom, stage.bottom);
    if (x1 <= x0 || y1 <= y0) return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, ok: false, coveredBy: null, onScreen: false, found: true };
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const tries: [number, number][] = [[cx, cy]];
    for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) tries.push([x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * j) / 6]);
    for (const [x, y] of tries) if (accept(document.elementFromPoint(x, y))) return { x, y, ok: true, coveredBy: null, onScreen: true, found: true };
    return { x: cx, y: cy, ok: false, coveredBy: describe(document.elementFromPoint(cx, cy)), onScreen: true, found: true };
  };
  const at = (x: number, y: number, accept: (hit: Element | null) => boolean): Located => {
    const stage = rt.stage!.getBoundingClientRect();
    const onScreen = x >= stage.left && x <= stage.right && y >= stage.top && y <= stage.bottom;
    const hit = document.elementFromPoint(x, y);
    const ok = onScreen && accept(hit);
    return { x, y, ok, coveredBy: ok ? null : describe(hit), onScreen, found: true };
  };
  const missing: Located = { x: 0, y: 0, ok: false, coveredBy: null, onScreen: false, found: false };
  const isBackground = (el: Element | null) => { const t = hitTargetOf(el); return t !== "excluded" && t.kind === "background"; };

  let trace: { initial: unknown; events: TraceEvent[]; last: ScreenState | null } | null = null;

  const hook: ScreensTestHook = {
    version: 1,
    sessionId: rt.viewId,
    probe(roots) {
      const st = client.get();
      const out: Record<string, unknown> = { stamp: { revision: st.committed?.revision ?? null, view: rt.viewId, connection: st.connection } };
      for (const root of roots) {
        if (root === "view") out.view = summarizeView(rt.view);
        else if (root === "pending") {
          const entries = [...st.pending.values()].sort((a, b) => a.seq - b.seq).map((e) => ({ opId: e.opId, type: e.op.type, status: e.outcome.status,
            code: e.outcome.status === "failed" ? e.outcome.error.code : null }));
          out.pending = { size: entries.length, sending: entries.filter((e) => busyStatus(e.status)).length, failed: entries.filter((e) => e.status === "failed").length, ...Object.fromEntries(entries.map((e, i) => [i, e])) };
        } else if (root === "frames") {
          const f: Record<string, unknown> = { live: rt.frames.live.size, iframes: document.querySelectorAll(".frame iframe").length };
          for (const id of Object.keys(st.committed?.items ?? {})) {
            const el = itemEl(id);
            f[id] = { live: rt.frames.live.has(id), load: rt.frames.load.get(id) ?? "poster", gen: rt.frames.gen.get(id) ?? 0, input: el?.dataset.input ?? null };
          }
          out.frames = f;
        } else if (root === "presence") {
          // size and session keys: other people's live drag previews. roster: agents on this Screen, keyed by name with spaces as "-".
          const roster = Object.fromEntries(st.roster.map((p) => [p.name.replace(/\s+/g, "-"), {
            color: p.color, status: p.status?.text ?? null, target: p.status?.target?.itemId ?? null, call: p.call?.verb ?? null,
            draft: p.draft ? { itemId: p.draft.itemId, rev: p.draft.rev, chars: p.draft.bytes, held: st.drafts.get(p.id)?.text.length ?? null } : null,
            incoming: p.incoming ? { phase: p.incoming.phase, x: p.incoming.rect.x, y: p.incoming.rect.y, w: p.incoming.rect.w, h: p.incoming.rect.h, itemId: p.incoming.itemId } : null,
          }]));
          out.presence = { size: st.remote.size, ...Object.fromEntries([...st.remote].map(([k, v]) => [k, v])), roster: { size: st.roster.length, ...roster } };
        }
        else if (root === "history") out.history = { ...st.history };
        else if (root === "dom") {
          const d: Record<string, unknown> = {
            toast: toastText(),
            reconnecting: !!document.querySelector(".toast:not(.error)"),
            saving: !!document.querySelector(".screens-saving"),
            /** Copy as image, as the toolbar button shows it: copying, copied, failed, or null at rest. */
            copy: document.querySelector<HTMLElement>("[data-copy-image]")?.dataset.state ?? null,
            title: document.querySelector(".screen-name")?.textContent?.trim() ?? null,
            empty: !!document.querySelector(".empty-state"),
            presence: presenceDom(),
            // Alignment guides as drawn, "x@pos" or "y@pos" in world units, and the box around several selected frames.
            guides: [...document.querySelectorAll<HTMLElement>(".guide")].map((g) => g.style.width.startsWith("calc") ? `x@${parseFloat(g.style.left)}` : `y@${parseFloat(g.style.top)}`),
            box: ((b) => b ? [parseFloat(b.style.left), parseFloat(b.style.top), parseFloat(b.style.width), parseFloat(b.style.height)] : null)(document.querySelector<HTMLElement>(".selection-box")),
            /** Items drawn with the saving spinner, committed or not: a dropped image shows here before its revision. */
            unsavedItems: [...document.querySelectorAll(".frame")].filter((el) => el.querySelector(".screens-mini-spinner")).length,
          };
          for (const id of Object.keys(st.committed?.items ?? {})) {
            const el = itemEl(id);
            if (!el) { d[id] = { rendered: false }; continue; }
            const surf = el.querySelector(".frame-surface"), img = surf?.querySelector<HTMLImageElement>(":scope > img"), frame = surf?.querySelector<HTMLIFrameElement>(":scope > iframe");
            // What the person sees in the item: the live page, a decoded poster, the gray placeholder, or a reference image.
            const surface = el.classList.contains("reference") ? "image" : frame && frame.style.opacity === "1" ? "live"
              : img && img.style.opacity !== "0" && img.complete && img.naturalWidth > 0 ? "poster" : surf?.querySelector(".screens-frame-placeholder") ? "placeholder" : "none";
            d[id] = { rendered: true, surface, poster: img?.getAttribute("src")?.match(/\/content\/([0-9a-f]{64})$/)?.[1] ?? null, sync: el.querySelector(".screens-mini-spinner") ? "pending" : el.classList.contains("failed") ? "failed" : "saved",
              selected: el.classList.contains("selected") || el.classList.contains("multi-selected"), title: el.querySelector(".frame-title span")?.textContent ?? null,
              visible: getComputedStyle(el).visibility !== "hidden" && el.style.opacity !== "0",
              // The size the frame is drawn at, in world units: a resize preview, local or remote, shows here first.
              width: parseFloat(el.style.width), height: parseFloat(el.style.height), z: Number(el.style.zIndex) };
          }
          // Comments: what the person sees of each thread. `at` is the pin tip in world units, rounded, as the canvas placed it.
          // Only the open card renders comments: one query, then lookups. texts and failed describe what that card shows.
          const card = document.querySelector<HTMLElement>("[data-thread-card]");
          const shown = new Map([...(card?.querySelectorAll<HTMLElement>("[data-comment]") ?? [])].map((el) => [el.dataset.comment!, el]));
          const pins = new Map([...document.querySelectorAll<HTMLElement>(".screens-pin[data-thread]")].map((el) => [el.dataset.thread!, el]));
          const areas = new Map([...document.querySelectorAll<HTMLElement>("[data-area-thread]")].map((el) => [el.dataset.areaThread!, el]));
          // Every circled region shown, in world units: the draft's, a gesture's and each thread's.
          d.areas = [...document.querySelectorAll<HTMLElement>(".screens-comment-area")].map((el) => [Math.round(parseFloat(el.style.width)), Math.round(parseFloat(el.style.height))]);
          for (const t of rt.doc().threads) {
            const pin = pins.get(t.id);
            const els = t.comments.map((c) => shown.get(c.id)).filter((el): el is HTMLElement => !!el);
            const area = areas.get(t.id);
            d[t.id] = { pin: pin ? "shown" : "hidden", active: pin?.classList.contains("active") ?? false, sync: t.sync,
              // The circled region as drawn, in world units, rounded.
              area: area ? [Math.round(parseFloat(area.style.width)), Math.round(parseFloat(area.style.height))] : null,
              at: pin ? [Math.round(parseFloat(pin.style.left)), Math.round(parseFloat(pin.style.top))] : null,
              texts: els.map((el) => el.querySelector(".comment-body")?.textContent ?? ""), failed: els.filter((el) => el.dataset.sync === "failed").length };
            for (const c of t.comments) { const el = shown.get(c.id); d[c.id] = el ? { rendered: true, sync: c.sync, text: el.querySelector(".comment-body")?.textContent ?? null } : { rendered: false }; }
          }
          const active = document.activeElement;
          const popover = document.querySelector<HTMLElement>(".screens-comment-popover");
          const pr = popover?.getBoundingClientRect();
          const messages = document.querySelector<HTMLElement>(".screens-thread-messages");
          d.popover = popover && pr ? { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height), visible: getComputedStyle(popover).visibility !== "hidden", scroll: messages?.scrollTop ?? 0 } : null;
          d.commentValue = document.querySelector<HTMLTextAreaElement>(".screens-comment-editor textarea")?.value ?? null;
          d.commentNumbers = [...pins.values()].map((el) => el.querySelector(".screens-pin-number")?.textContent);
          d.card = card?.dataset.threadCard ?? null;
          d.composer = active instanceof HTMLTextAreaElement ? active.getAttribute("aria-label") : null;
          // The layers inspector in focus mode: rows in order (pids), their labels, which are hidden or pending, and the details.
          const layerRows = [...document.querySelectorAll<HTMLElement>(".screens-layers [data-piece]")];
          const details = document.querySelector<HTMLElement>(".screens-piece-details");
          d.layers = document.querySelector(".screens-layers") ? {
            rows: layerRows.map((r) => r.dataset.piece), labels: layerRows.map((r) => r.querySelector(".name")?.textContent ?? ""),
            hidden: layerRows.filter((r) => r.classList.contains("screens-hidden-row")).map((r) => r.dataset.piece),
            pending: layerRows.filter((r) => r.querySelector(".screens-mini-spinner")).map((r) => r.dataset.piece),
            selected: layerRows.find((r) => r.getAttribute("aria-selected") === "true")?.dataset.piece ?? null,
            details: details ? { open: details.querySelector("[aria-expanded]")?.getAttribute("aria-expanded") === "true",
              text: details.querySelector<HTMLInputElement>("#piece-text")?.value ?? null, fill: details.querySelector<HTMLInputElement>("#piece-fill")?.value ?? null,
              size: details.querySelector("[data-size]")?.textContent ?? null } : null,
          } : null;
          d.panel = document.querySelector(".screens-comments-panel") ? [...document.querySelectorAll<HTMLElement>("[data-thread-row]")].map((r) => r.dataset.threadRow) : null;
          out.dom = d;
        }
      }
      return out;
    },
    locate(t) {
      if (t.kind !== "ui" && !rt.stage?.isConnected) return missing;
      if (!rt.stage) return missing;
      switch (t.kind) {
        case "item": {
          const el = itemEl(t.id); if (!el) return missing;
          if (t.part === "title") { const ti = el.querySelector(".frame-title"); return ti ? pointIn(ti, (h) => !!h && ti.contains(h)) : missing; }
          if (t.part === "focus") { const b = el.querySelector(".frame-action"); return b ? pointIn(b, (h) => !!h && b.contains(h)) : missing; }
          // A frame's own handle, or, when it is one of several selected, the handle of the box around them.
          if ((HANDLES as readonly string[]).includes(t.part)) {
            const b = el.querySelector(`.resize-handle.${t.part}`) ?? (rt.view.selection.kind === "items" && rt.view.selection.ids.includes(t.id) ? rt.stage.querySelector(`.selection-box .resize-handle.${t.part}`) : null);
            return b ? pointIn(b, (h) => h === b) : missing;
          }
          const surface = el.querySelector(".frame-surface")!;
          if (t.offset) {
            const it = client.get().committed?.items[t.id]; if (!it) return missing;
            const c = rt.view.camera, s = rt.stage.getBoundingClientRect();
            return at(s.left + c.x + (it.x + t.offset.x) * c.z, s.top + c.y + (it.y + t.offset.y) * c.z, (h) => !!h && el.contains(h));
          }
          return pointIn(surface, (h) => !!h && surface.contains(h));
        }
        case "stroke": {
          const p = document.querySelector(`[data-hit="stroke:${CSS.escape(t.id)}"]`);
          const sk = client.get().committed?.strokes[t.id];
          if (!p || !sk || sk.points.length === 0) return missing;
          // A recorded point in the middle of the stroke lies on the ink, unlike the centre of a curve's bounding box.
          const [px, py] = sk.points[Math.floor(sk.points.length / 2)]!;
          const anchor = sk.anchor.kind === "item" ? client.get().committed?.items[sk.anchor.itemId] : null;
          const c = rt.view.camera, s = rt.stage.getBoundingClientRect();
          return at(s.left + c.x + ((anchor?.x ?? 0) + px) * c.z, s.top + c.y + ((anchor?.y ?? 0) + py) * c.z, (h) => h === p);
        }
        case "thread": {
          const el = document.querySelector(t.part === "row" ? `[data-thread-row="${CSS.escape(t.id)}"]` : `.screens-pin[data-thread="${CSS.escape(t.id)}"]`);
          return el ? pointIn(el, (h) => !!h && el.contains(h)) : missing;
        }
        case "comment": {
          const el = document.querySelector(`[data-comment="${CSS.escape(t.id)}"] button[aria-label^="Delete"]`);
          return el ? pointIn(el, (h) => !!h && el.contains(h)) : missing;
        }
        case "background": {
          const s = rt.stage.getBoundingClientRect();
          if (t.at) return at(s.left + t.at.x, s.top + t.at.y, isBackground);
          for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) {
            const x = s.left + (s.width * i) / 12, y = s.top + (s.height * j) / 12;
            if (isBackground(document.elementFromPoint(x, y))) return { x, y, ok: true, coveredBy: null, onScreen: true, found: true };
          }
          return missing;
        }
        case "world": {
          const c = rt.view.camera, s = rt.stage.getBoundingClientRect();
          return at(s.left + c.x + t.at.x * c.z, s.top + c.y + t.at.y * c.z, () => true);
        }
        case "ui": {
          // Library pages too: grid cells are options, context menu entries are menu items. Layer rows are tree items.
          const els = [...document.querySelectorAll<HTMLElement>("button, a, input, textarea, select, [role=button], [role=option], [role=menuitem], [role=treeitem]")].filter((e) =>
            (e.getAttribute("aria-label") === t.label || e.textContent?.trim() === t.label || e.getAttribute("aria-label")?.startsWith(`${t.label} (`)) && e.getClientRects().length > 0);
          const el = els[0]; if (!el) return missing;
          return pointIn(el, (h) => !!h && el.contains(h));
        }
      }
    },
    idle() {
      const v = rt.view, st = client.get();
      return !v.gesture && !v.animation && !v.moving && !v.wheel.scheduled && !rt.timersPending()
        && ![...st.pending.values()].some((e) => busyStatus(e.outcome.status))
        && ![...rt.frames.load.values()].some((l) => l === "loading");
    },
    trace: {
      start() {
        const t = { initial: toJson(rt.view), events: [] as TraceEvent[], last: null as ScreenState | null };
        trace = t;
        rt.tracer = (input, base, nows, ids) => {
          const changed = base !== t.last; t.last = base;
          t.events.push({ input: toJson(input) as CanvasInput, base: changed ? toJson({ committed: base.committed, pending: base.pending, remote: base.remote }) : null, nows, ids });
        };
      },
      stop() {
        rt.tracer = null;
        const t = trace; trace = null;
        return t ? { version: 1, reducedMotion: rt.env.reducedMotion, initial: t.initial, events: t.events, final: toJson(rt.view) } : null;
      },
    },
  };
  Object.defineProperty(window, "__screensTest", { value: Object.freeze(hook), configurable: true, writable: false });
}
