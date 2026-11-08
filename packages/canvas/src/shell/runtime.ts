// Runs the engine against the DOM and the service. Decides no policy: it turns DOM events into
// CanvasInput, runs effects, and owns timers, frame mounts and the bridge.

import type { ScreenClient, ScreenState } from "@screens/client";
import { contentHashes, TITLE_MAX, type ItemId, type Operation, type Point } from "@screens/core";
import {
  HANDLES, baseDocOf, initialViewState, presentIndex, rankLiveFrames, shownDocOf, scrollRect, storedScrollViewport, step, viewportWorldRect, CAMERA_SETTLE_MS, READY_RETRY_MS,
  type BaseDoc, type CanvasInput, type DroppedImage, type Env, type ViewState, type ViewCommand, type HitTarget, type Handle,
} from "../engine/index.ts";
import { anchorOf } from "./presence.ts";
import { imageDataUrl } from "./content.tsx";
import { opening } from "./opening.ts";

export type LoadState = "loading" | "ready" | "failed";
export interface FrameRuntimeState { readonly live: ReadonlySet<ItemId>; readonly load: ReadonlyMap<ItemId, LoadState>; readonly gen: ReadonlyMap<ItemId, number> }

export const safeStore = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export class CanvasRuntime {
  view: ViewState;
  frames: FrameRuntimeState = { live: new Set(), load: new Map(), gen: new Map() };
  /** Bumps when anything except the camera changes, so React skips camera-only updates. */
  uiVersion = 0;
  /** Unsent annotation text belongs to this view, independent of the mounted comment surface. */
  readonly commentDrafts = new Map<string, { text: string; expectedText?: string }>();
  stage: HTMLElement | null = null;
  world: HTMLElement | null = null;
  zoomLabel: HTMLElement | null = null;
  private subs = new Set<() => void>();
  private frameRequested = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private liveRetryAt: number | null = null;
  private disposed = false;
  private contextTimer: ReturnType<typeof setTimeout> | null = null;
  private hostWindows = new WeakMap<Window, { itemId: ItemId; gen: number }>();
  private hostElements = new Map<ItemId, HTMLIFrameElement>();
  private lastRevision = -1;
  private lastConnection: ScreenState["connection"] = "connecting";
  /** The gesture whose preview this canvas is broadcasting, if any. */
  private previewGesture: string | null = null;
  private lastPending: ScreenState["pending"] | null = null;
  /** Participants whose cursor this person hid. Local to this view. */
  hiddenParticipants: ReadonlySet<string> = new Set();
  /** Called after every camera paint, for chrome placed in screen space (off-screen presence markers). */
  private paintSubs = new Set<() => void>();
  private followKey: string | null = null;
  private versions = new Map<ItemId, string>();
  /** Dropped or pasted image bytes and a local preview URL, by hash, until the op naming them settles. */
  private dropped = new Map<string, { bytes: Uint8Array; url: string }>();
  /** Drops still being read and measured, before the engine sees them. */
  private reading = 0;
  private unsubClient: () => void;
  private unsubView: () => void;
  readonly env: Env;
  /** Timestamps of input → next paint, collected only when the bench asks for them. */
  latencyProbe: ((ms: number) => void) | null = null;
  /** Pieces the person clicked inside a live object, and sizes the object reported for a highlighted piece. View data
   *  from the page: never authority to change the Screen. */
  private pieceSubs = new Set<(e: { readonly itemId: ItemId; readonly kind: "click" | "rect"; readonly pid: string | null; readonly w?: number; readonly h?: number }) => void>();
  /** Set by the dev test hook while a trace is recording. Sees every input with the clock and IDs step used. */
  tracer: ((input: CanvasInput, base: ScreenState, nows: readonly number[], ids: readonly string[]) => void) | null = null;

  readonly client: ScreenClient;
  readonly viewId: string;

  constructor(client: ScreenClient, viewId: string) {
    this.client = client; this.viewId = viewId;
    const theme = (safeStore.get("screens.theme") as "light" | "dark" | null) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.dataset.theme = theme;
    this.view = initialViewState({ viewport: { width: innerWidth, height: innerHeight }, pointer: matchMedia("(pointer: coarse)").matches ? "coarse" : "fine",
      dpr: devicePixelRatio, theme, invertScroll: safeStore.get("screens.invertScroll") === "1" });
    this.env = { now: () => performance.now(), reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      newId: () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join("") };
    this.unsubClient = client.subscribe(() => this.onClient());
    this.unsubView = client.onViewCommand((cmd) => this.dispatch({ type: "view-command", cmd: cmd as ViewCommand, now: Date.now() }));
    addEventListener("message", this.onMessage);
    this.onClient();
  }

  /** Reads image files, hashes and measures them, and hands them to the engine, which places them. Non-images and files
   *  that do not decode are skipped. Placement, batching and pending state are the engine's and the client's. */
  async dropImages(files: readonly File[], at: Point | null): Promise<void> {
    this.reading++;
    try { await this.readImages(files, at); } finally { this.reading--; }
  }

  private async readImages(files: readonly File[], at: Point | null): Promise<void> {
    // A clipboard image has a generic name ("image.png"); a pasted one is titled for what it is.
    const images: DroppedImage[] = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
      const url = this.dropped.get(hash)?.url ?? (this.client.transportKind === "app" ? imageDataUrl(bytes, f.type) : URL.createObjectURL(new Blob([bytes], { type: f.type })));
      const size = await new Promise<{ width: number; height: number } | null>((resolve) => {
        const img = new Image(); img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight }); img.onerror = () => resolve(null); img.src = url;
      });
      if (!size || !size.width || !size.height) { if (!this.dropped.has(hash)) URL.revokeObjectURL(url); continue; }
      this.dropped.set(hash, { bytes, url });
      const name = at === null ? "" : f.name.replace(/\.[^.]+$/, "").trim();
      images.push({ hash, mediaType: f.type, width: size.width, height: size.height, title: (name || "Pasted image").slice(0, TITLE_MAX) });
    }
    if (images.length) this.dispatch({ type: "drop-images", at, images });
  }

  /** Copy as image: where the last copy stands, for the toolbar button and its toast. */
  copy: { readonly id: number; readonly state: "copying" | "copied" | "failed" } | null = null;
  private copySeq = 0;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Writes the item's picture to the clipboard as a PNG: a design as a fresh 2x render, an image as its own pixels.
   *  Runs inside the click or key press, because the clipboard only accepts a write the person started; the PNG
   *  arrives later as a promise. */
  private copyImage(itemId: ItemId): void {
    const it = this.doc().byId.get(itemId);
    if (!it || !navigator.clipboard?.write) return this.setCopy(++this.copySeq, "failed");
    const url = it.kind === "reference-image" ? (it.assetHash && (this.localImage(it.assetHash) ?? `/content/${it.assetHash}`))
      : it.contentVersion && `/still/${this.client.screenId}/${it.id}/${it.contentVersion}`;
    if (!url) return this.setCopy(++this.copySeq, "failed");
    const id = ++this.copySeq;
    this.setCopy(id, "copying");
    const png = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      const b = await r.blob();
      if (b.type === "image/png") return b;
      const bmp = await createImageBitmap(b), c = new OffscreenCanvas(bmp.width, bmp.height);
      c.getContext("2d")!.drawImage(bmp, 0, 0); bmp.close();
      return c.convertToBlob({ type: "image/png" });
    });
    navigator.clipboard.write([new ClipboardItem({ "image/png": png })])
      .then(() => this.setCopy(id, "copied"), () => this.setCopy(id, "failed"));
    if (!this.env.reducedMotion) flyToButton(this.stage?.querySelector<HTMLElement>(`[data-item="${CSS.escape(itemId)}"] .frame-surface`) ?? null);
  }

  private setCopy(id: number, state: "copying" | "copied" | "failed"): void {
    if (id !== this.copySeq) return;
    if (this.copyTimer) { clearTimeout(this.copyTimer); this.copyTimer = null; }
    this.copy = { id, state };
    if (state !== "copying") this.copyTimer = setTimeout(() => { if (this.copy?.id === id) { this.copy = null; this.uiVersion++; this.emit(); } }, state === "copied" ? COPIED_MS : COPY_FAILED_MS);
    this.uiVersion++; this.emit();
  }

  /** The local preview of a dropped image while its add is pending: /content/<hash> has nothing until the upload lands. */
  localImage(hash: string): string | null { return this.dropped.get(hash)?.url ?? null; }

  private filesFor(op: Operation): ReadonlyMap<string, Uint8Array> | undefined {
    const files = new Map<string, Uint8Array>();
    for (const h of contentHashes(op)) { const d = this.dropped.get(h); if (d) files.set(h, d.bytes); }
    return files.size ? files : undefined;
  }

  /** Releases dropped bytes once no pending op names them: after the commit, or after a failed drop is dismissed. Never while
   *  a drop is still being read, because its op has not been submitted yet. */
  private releaseDropped() {
    if (!this.dropped.size || this.reading) return;
    const named = new Set([...this.client.get().pending.values()].flatMap((e) => [...(e.files?.keys() ?? [])]));
    for (const [h, d] of this.dropped) if (!named.has(h)) { URL.revokeObjectURL(d.url); this.dropped.delete(h); }
  }

  onPaint(cb: () => void): () => void { this.paintSubs.add(cb); return () => { this.paintSubs.delete(cb); }; }
  toggleHidden(id: string) {
    const n = new Set(this.hiddenParticipants); if (!n.delete(id)) n.add(id);
    this.hiddenParticipants = n; this.uiVersion++; this.emit();
  }

  dispose() {
    this.disposed = true;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null; this.liveRetryAt = null;
    for (const d of this.dropped.values()) URL.revokeObjectURL(d.url);
    this.dropped.clear(); this.unsubClient(); this.unsubView(); removeEventListener("message", this.onMessage);
  }
  subscribe(cb: () => void) { this.subs.add(cb); return () => this.subs.delete(cb); }
  onPiece(cb: Parameters<typeof this.pieceSubs.add>[0]) { this.pieceSubs.add(cb); return () => { this.pieceSubs.delete(cb); }; }

  /** Outlines one piece inside a live object (null clears it). The page answers with the piece's size. */
  highlight(itemId: ItemId, pid: string | null) {
    const el = this.hostElements.get(itemId), fa = this.client.get().frameAccess, gen = this.frames.gen.get(itemId);
    if (!el?.contentWindow || !fa || gen === undefined || this.frames.load.get(itemId) !== "ready") return;
    el.contentWindow.postMessage({ kind: "highlight", gen: String(gen), pid }, this.client.transportKind === "app" ? "*" : fa.origin);
  }
  /** The arrangement the engine and the shell read: on a Presentation or Document, the grid when it is shown. */
  doc(): BaseDoc { return shownDocOf(baseDocOf(this.client.get()), this.view.pages.view, this.view.viewport.width); }

  dispatch(input: CanvasInput) {
    const before = this.view;
    let env: Env = this.env;
    const nows: number[] = [], ids: string[] = [];
    if (this.tracer) { const e = env; env = { ...e, now: () => { const t = e.now(); nows.push(t); return t; }, newId: () => { const id = e.newId(); ids.push(id); return id; } }; }
    const base = this.client.get();
    const r = step(before, input, this.doc(), env);
    this.tracer?.(input, base, nows, ids);
    this.view = r.state;
    for (const e of r.effects) this.run(e);
    this.paintCamera();
    const cameraOnly = Object.keys(this.view).every((k) => ["camera", "moving", "wheel", "animation"].includes(k) || (this.view as unknown as Record<string, unknown>)[k] === (before as unknown as Record<string, unknown>)[k]);
    if (!cameraOnly) {
      this.uiVersion++; this.emit();
      // Keep the agent's view of this canvas current (selection, focus, busy), without flooding the socket.
      if (this.contextTimer) clearTimeout(this.contextTimer);
      this.contextTimer = setTimeout(() => { this.contextTimer = null; this.run({ type: "publish-context" }); }, 100);
    }
    if (before.camera !== this.view.camera || before.focus !== this.view.focus || before.interacting !== this.view.interacting || before.pages !== this.view.pages) this.scheduleLive(before.camera !== this.view.camera ? CAMERA_SETTLE_MS : 0);
  }

  private run(e: ReturnType<typeof step>["effects"][number]) {
    const c = this.client;
    switch (e.type) {
      case "capture": try { this.stage?.setPointerCapture(e.pointerId); } catch { /* pointer gone */ } return;
      case "release": try { this.stage?.releasePointerCapture(e.pointerId); } catch { /* pointer gone */ } return;
      case "submit": {
        const h = c.submit(e.op, this.filesFor(e.op)), g = e.endsPreview;
        // Clear the preview after the revision lands (or the op fails), unless a newer gesture has taken over the broadcast.
        if (g) void h.settled().finally(() => { if (this.previewGesture === g) { this.previewGesture = null; c.transient(g, null); } });
        return;
      }
      case "transient":
        this.previewGesture = e.rects ? e.gestureId : null;
        c.transient(e.gestureId, e.rects ? Object.fromEntries(e.rects) : null); return;
      // With nothing to undo, the key does nothing rather than reporting a failure.
      case "undo": if (c.get().history.canUndo) c.undo(); return;
      case "redo": if (c.get().history.canRedo) c.redo(); return;
      case "request-frame":
        if (!this.frameRequested) { this.frameRequested = true; requestAnimationFrame((t) => { this.frameRequested = false; this.dispatch({ type: "tick", now: t }); }); }
        return;
      case "settle-timer":
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.world?.setAttribute("data-moving", "");
        this.settleTimer = setTimeout(() => { this.settleTimer = null; this.world?.removeAttribute("data-moving"); this.dispatch({ type: "camera-settled" }); }, CAMERA_SETTLE_MS);
        return;
      case "blur-active": (document.activeElement as HTMLElement | null)?.blur?.(); this.stage?.focus(); return;
      case "publish-context": {
        const v = this.view, doc = this.doc(), paged = doc.layout !== "canvas";
        // The viewport is always in stored world units: in the grid it is the scroll view the grid returns to.
        const camera = paged && v.pages.view === "grid" && v.pages.restore ? v.pages.restore.camera : v.camera;
        const displayedViewport = viewportWorldRect(camera, v.viewport);
        const viewport = paged && v.pages.view !== "present" ? storedScrollViewport(doc.layout as "slides" | "a4", displayedViewport, v.viewport.width) : displayedViewport;
        c.publishContext({ viewId: this.viewId, focused: v.focus.mode === "focused" ? v.focus.itemId : null, interacting: v.interacting,
          selection: v.selection.kind === "items" ? v.selection.ids : [], viewport,
          busy: v.gesture !== null || v.editing !== null || v.comment.draft !== null || v.comment.parkedDraft !== null || v.comment.composing, activeThread: v.comment.expanded ? v.comment.activeThreadId : null,
          pages: paged ? { view: v.pages.view, page: presentIndex(v, doc) } : null });
        return;
      }
      case "answer-view-command": c.answerViewCommand(e.id, e.outcome); return;
      case "copy-image": this.copyImage(e.itemId); return;
    }
  }

  /** Camera writes bypass React. */
  paintCamera() {
    const { x, y, z } = this.view.camera;
    if (this.world) {
      const layout = this.doc().layout;
      const scroll = layout !== "canvas" && this.view.pages.view === "scroll";
      const gap = scroll ? scrollRect(layout as "slides" | "a4", 1, this.view.viewport.width) : null;
      const room = gap ? (gap.y - gap.h) * z : 32;
      this.world.style.setProperty("--page-label-gap", `${room}px`);
      this.world.toggleAttribute("data-tight-page-labels", scroll && room < 24);
      this.world.toggleAttribute("data-hidden-page-labels", scroll && room < 10);
      this.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
      this.world.style.setProperty("--zoom", String(z));
      this.world.style.setProperty("--inv", String(1 / z));
    }
    if (this.zoomLabel) this.zoomLabel.textContent = `${Math.round(z * 100)}%`;
    for (const cb of this.paintSubs) cb();
  }

  private onClient() {
    const st = this.client.get();
    if (st.connection === "ready" && this.lastConnection !== "ready") this.run({ type: "publish-context" });
    this.lastConnection = st.connection;
    const rev = st.committed?.revision ?? -1;
    if (rev !== this.lastRevision) {
      this.lastRevision = rev;
      for (const it of Object.values(st.committed?.items ?? {})) if (it.kind === "html-snapshot") {
        const prev = this.versions.get(it.id);
        this.versions.set(it.id, it.contentVersion);
        if (prev && prev !== it.contentVersion && this.frames.live.has(it.id)) this.remount(it.id);
      }
      this.dispatch({ type: "document-changed" }); this.scheduleLive(0);
    } else if (st.pending !== this.lastPending) {
      // A dismissed failed create changes no revision, but its card must close.
      this.dispatch({ type: "document-changed" });
    }
    this.lastPending = st.pending;
    this.followTarget(st);
    this.releaseDropped();
    this.uiVersion++; this.emit();
  }

  /** While following, tells the engine where the followed participant works now, once per change. */
  private followTarget(st: ScreenState) {
    const id = this.view.following;
    if (!id) { this.followKey = null; return; }
    const p = st.roster.find((x) => x.id === id);
    const a = p ? anchorOf(p, new Map(this.doc().items.map((it) => [it.id, it]))) : null;
    const key = a ? `${a.key}:${a.rect.x},${a.rect.y},${a.rect.w},${a.rect.h}` : null;
    if (key === this.followKey) return;
    this.followKey = key;
    if (a) this.dispatch({ type: "follow-target", id, rect: a.rect });
  }

  private emit() { for (const s of this.subs) s(); }

  setTheme(theme: "light" | "dark") {
    // Swap with transitions off, or every color transition fires at once and the chrome smears through the change.
    const still = document.createElement("style");
    still.textContent = "*, *::before, *::after { transition: none !important; }";
    document.head.append(still);
    document.documentElement.dataset.theme = theme;
    void getComputedStyle(document.documentElement).color;
    requestAnimationFrame(() => requestAnimationFrame(() => still.remove()));
    safeStore.set("screens.theme", theme); this.dispatch({ type: "theme", theme });
  }
  setInvertScroll(on: boolean) { safeStore.set("screens.invertScroll", on ? "1" : "0"); this.dispatch({ type: "command", command: { kind: "invert-scroll", on } }); }

  // ── Live frames ──

  private scheduleLive(delay: number, admissionRetry = false) {
    if (this.disposed) return;
    opening?.mark("admission.scheduled", { delay });
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveRetryAt = admissionRetry ? performance.now() + delay : null;
    this.liveTimer = setTimeout(() => { this.liveTimer = null; this.liveRetryAt = null; this.recomputeLive(); }, delay);
  }

  /** True while a timer or animation frame this runtime scheduled has yet to fire. */
  timersPending(): boolean { return !!(this.liveTimer || this.contextTimer || this.settleTimer || this.frameRequested || this.reading); }

  recomputeLive() {
    if (this.disposed) return;
    const start = opening?.now();
    const v = this.view;
    const r = rankLiveFrames({ items: this.doc().items, camera: v.camera, viewport: v.viewport, dpr: v.dpr, pointer: v.pointer,
      previous: this.frames.live, interacting: v.interacting, focused: v.focus.mode === "focused" ? v.focus.itemId : null, presenting: v.pages.view === "present" });
    const same = r.live.size === this.frames.live.size && [...r.live].every((id) => this.frames.live.has(id));
    if (!same) {
      const load = new Map(this.frames.load), gen = new Map(this.frames.gen);
      for (const id of r.live) if (!this.frames.live.has(id)) { load.set(id, "loading"); gen.set(id, (gen.get(id) ?? 0) + 1); }
      for (const id of this.frames.live) if (!r.live.has(id)) { load.delete(id); this.hostElements.delete(id); }
      this.frames = { live: r.live, load, gen };
      this.uiVersion++; this.emit();
    }
    opening?.duration("admission", start, { live: r.live.size, retryAfterMs: r.retryAfterMs, ids: [...r.live] });
    if (r.retryAfterMs) this.scheduleLive(r.retryAfterMs, true);
  }

  /** Content changed under a live frame: remount with a new generation. */
  remount(itemId: ItemId) {
    const gen = new Map(this.frames.gen); gen.set(itemId, (gen.get(itemId) ?? 0) + 1);
    const load = new Map(this.frames.load); load.set(itemId, "loading");
    this.frames = { ...this.frames, gen, load }; this.uiVersion++; this.emit();
  }

  attachHost(itemId: ItemId, gen: number, el: HTMLIFrameElement | null) {
    if (!el) return;
    if (opening && this.hostElements.get(itemId) !== el) {
      opening.mark("frame.attached", { itemId, gen });
      if (el.hasAttribute("srcdoc")) opening.mark("srcdoc.committed", { itemId, gen });
    }
    this.hostElements.set(itemId, el);
    if (el.contentWindow) this.hostWindows.set(el.contentWindow, { itemId, gen });
  }

  itemForActiveFrame(): ItemId | null {
    const a = document.activeElement;
    for (const [id, el] of this.hostElements) if (el === a) return id;
    return null;
  }

  private onMessage = (e: MessageEvent) => {
    const fa = this.client.get().frameAccess;
    if (!fa || e.origin !== (this.client.transportKind === "app" ? "null" : fa.origin) || !e.source) return;
    const host = this.hostWindows.get(e.source as Window);
    const d = e.data as { itemId?: string; kind?: string; gen?: string; x?: number; y?: number; dx?: number; dy?: number; pinch?: boolean; pid?: string | null; w?: number; h?: number };
    if (!host || !d || typeof d !== "object" || Array.isArray(d) || !this.frames.live.has(host.itemId)
      || this.hostElements.get(host.itemId)?.contentWindow !== e.source || this.frames.gen.get(host.itemId) !== host.gen) return;
    // A direct srcdoc child cannot choose an item or generation. Browser host envelopes carry only their generation.
    if ("itemId" in d || (this.client.transportKind === "app" ? "gen" in d : d.gen !== String(host.gen))) return;
    if (d.kind === "error") d.kind = "failed";
    if (d.kind === "ready" || d.kind === "failed") {
      const becameReady = d.kind === "ready" && this.frames.load.get(host.itemId) === "loading";
      opening?.mark(`frame.${d.kind}`, { itemId: host.itemId, gen: host.gen });
      const load = new Map(this.frames.load); load.set(host.itemId, d.kind === "ready" ? "ready" : "failed");
      this.frames = { ...this.frames, load }; this.uiVersion++; this.emit();
      // Advance only a pending admission retry. Camera settlement and view commands keep their own timers.
      // Waiting for the current batch avoids piling asset preparation onto frames that are still loading.
      if (becameReady && this.liveTimer && this.liveRetryAt !== null && this.liveRetryAt - performance.now() > READY_RETRY_MS
        && [...this.frames.live].every((id) => this.frames.load.get(id) === "ready")) this.scheduleLive(READY_RETRY_MS);
      return;
    }
    const pid = typeof d.pid === "string" && /^[a-z][a-z0-9-]{0,23}$/.test(d.pid) ? d.pid : null;
    if (d.kind === "rect") { for (const s of this.pieceSubs) s({ itemId: host.itemId, kind: "rect", pid, w: Number(d.w) || 0, h: Number(d.h) || 0 }); return; }
    if (d.kind === "pointer" && pid) for (const s of this.pieceSubs) s({ itemId: host.itemId, kind: "click", pid });
    if (d.kind === "pointer") this.dispatch({ type: "bridge", itemId: host.itemId, msg: { kind: "pointer", x: Number(d.x), y: Number(d.y) } });
    else if (d.kind === "zoom") this.dispatch({ type: "bridge", itemId: host.itemId, msg: { kind: "zoom", x: Number(d.x), y: Number(d.y), dy: Number(d.dy), pinch: d.pinch === true } });
    else if (d.kind === "pan") this.dispatch({ type: "bridge", itemId: host.itemId, msg: { kind: "pan", dx: Number(d.dx) || 0, dy: Number(d.dy) || 0 } });
    else if (d.kind === "escape") this.dispatch({ type: "bridge", itemId: host.itemId, msg: { kind: "escape" } });
  };
}

export function hitTargetOf(el: EventTarget | null): HitTarget | "excluded" {
  const node = el instanceof Element ? el : null;
  if (!node) return { kind: "background" };
  if (node.closest(".chrome, button, input, textarea, select, a, [contenteditable], .toast")) return "excluded";
  const hit = node.closest("[data-hit]")?.getAttribute("data-hit") ?? "bg";
  const [kind, id, part] = hit.split(":");
  if (kind === "item" && id) return { kind: "item", itemId: id, part: part === "title" ? "title" : "surface" };
  if (kind === "stroke" && id) return { kind: "stroke", strokeId: id };
  if (kind === "thread" && id) return { kind: "thread", threadId: id };
  if (kind === "handle" && id && (HANDLES as readonly string[]).includes(id)) return { kind: "handle", handle: id as Handle };
  return { kind: "background" };
}

/** A focused control that handles Space, Enter, Tab and the arrows itself. */
export function isControl(t: EventTarget | null): boolean {
  const el = t instanceof Element ? t : null;
  return !!el && !el.classList.contains("screens-stage") && !!el.closest("button, a[href], [role='button'], summary");
}

export function isEditable(t: EventTarget | null): boolean {
  const el = t instanceof Element ? t : null;
  return !!el && (!!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .menu"));
}

const COPIED_MS = 1400, COPY_FAILED_MS = 4000;

/** A shutter flash on the frame, then a picture of it shrinks along a short arc into the Copy as image button. */
function flyToButton(surface: HTMLElement | null): void {
  const button = document.querySelector<HTMLElement>("[data-copy-image]");
  if (!surface || !button) return;
  const from = surface.getBoundingClientRect(), to = button.getBoundingClientRect();
  // Only the part of the frame on screen takes off, so a frame larger than the window still flies from where it is seen.
  const x0 = Math.max(from.left, 0), y0 = Math.max(from.top, 0), x1 = Math.min(from.right, innerWidth), y1 = Math.min(from.bottom, innerHeight);
  if (x1 <= x0 || y1 <= y0) return;
  const w = x1 - x0, h = y1 - y0;

  const flash = document.createElement("div");
  flash.className = "copy-flash";
  surface.append(flash);
  flash.animate([{ opacity: 0.55 }, { opacity: 0 }], { duration: 260, easing: "ease-out" }).finished.finally(() => flash.remove());

  const ghost = document.createElement("div");
  ghost.className = "copy-ghost";
  const img = surface.querySelector("img");
  let decoded: Promise<unknown> = Promise.resolve();
  if (img?.src) {
    const pic = img.cloneNode() as HTMLImageElement;
    pic.removeAttribute("style");
    // Keep the frame's own crop: the visible part sits where it sits in the frame.
    Object.assign(pic.style, { left: `${from.left - x0}px`, top: `${from.top - y0}px`, width: `${from.width}px`, height: `${from.height}px` });
    ghost.append(pic);
    // A fresh copy of a decoded image still decodes again: fly once it can paint, so the card never starts blank.
    decoded = Promise.race([pic.decode().catch(() => {}), new Promise((r) => setTimeout(r, 120))]);
  }
  Object.assign(ghost.style, { left: `${x0}px`, top: `${y0}px`, width: `${w}px`, height: `${h}px`, visibility: "hidden" });
  document.body.append(ghost);
  void decoded.then(() => { ghost.style.visibility = ""; fly(ghost, button, x0, y0, w, h, to); });
}

function fly(ghost: HTMLElement, button: HTMLElement, x0: number, y0: number, w: number, h: number, to: DOMRect): void {
  // Lands as a small card the button's size across its longest side, then sinks into it.
  const k = Math.min(1, (to.width * 1.6) / Math.max(w, h));
  const dx = to.left + to.width / 2 - (x0 + w / 2), dy = to.top + to.height / 2 - (y0 + h / 2);
  // The midpoint bows sideways off the straight line, so the path reads as a toss rather than a slide.
  const len = Math.hypot(dx, dy) || 1, bow = Math.min(60, len * 0.12) * (dx < 0 ? -1 : 1), mx = dx * 0.55 - (dy / len) * bow, my = dy * 0.55 + (dx / len) * bow;
  ghost.animate([
    { transform: "translate(0, 0) scale(1)", borderRadius: "0px", opacity: 1, offset: 0 },
    { transform: "translate(0, 0) scale(0.94)", borderRadius: "6px", opacity: 1, offset: 0.18, easing: "cubic-bezier(.5, 0, .2, 1)" },
    { transform: `translate(${mx}px, ${my}px) scale(${Math.max(k, 0.35 * (1 + k))})`, offset: 0.62 },
    { transform: `translate(${dx}px, ${dy}px) scale(${k})`, borderRadius: `${8 / k}px`, opacity: 1, offset: 0.9 },
    { transform: `translate(${dx}px, ${dy}px) scale(${k * 0.6})`, borderRadius: `${8 / k}px`, opacity: 0, offset: 1 },
  ], { duration: 620, easing: "linear", fill: "forwards" }).finished.finally(() => ghost.remove());
  button.animate([{ transform: "scale(1)" }, { transform: "scale(1)", offset: 0.85 }, { transform: "scale(0.86)", offset: 0.93 }, { transform: "scale(1)" }], { duration: 760, easing: "ease-out" });
}
