import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ScreenClient } from "@screens/client";
import { inlineBundle, HOST_CSP } from "@screens/frames/inline";
import { imageDataUrl } from "./content.tsx";
import { opening } from "./opening.ts";
import {
  HANDLES, PENCIL_COLORS, PRESENT_KEYS, PRESENT_PRELOAD, boundsOf, copyableItem, nextItem, PENCIL_SIZES, TOOLS, policyOf, presentFrame, presentIndex, presentThread, renderDocOf, slotBar, strokeBounds, strokePath,
  type DisplayItem, type DisplayStroke, type FramePresentation, type PagesView, type ViewState,
} from "../engine/index.ts";
import { CanvasRuntime, hitTargetOf, isControl, isEditable } from "./runtime.ts";
import { Icon } from "./icons.tsx";
import { dockAt, Grip, SPOTS, useDock, type DockSpot } from "./Dock.tsx";
import { CommentLayer, CommentOverlay, CommentsPanel } from "./Comments.tsx";
import { PieceEditor } from "./Layers.tsx";
import { Filmstrip } from "./Filmstrip.tsx";
import { PresenceLayer, PresenceOverlay, PresenceRoster } from "./Presence.tsx";

/** onRuntime hands the runtime to the bench or the dev test hook. Nothing else reaches it. */
/** leading and trailing are the library shell's controls, placed around the back button and the Screen name. */
export function ScreenCanvas({ client, viewId, onRuntime, leading, trailing }: { client: ScreenClient; viewId: string; onRuntime?: (rt: CanvasRuntime) => void; leading?: ReactNode; trailing?: ReactNode }) {
  const [rt] = useState(() => new CanvasRuntime(client, viewId));
  useEffect(() => { onRuntime?.(rt); return () => rt.dispose(); }, [rt]);
  useSyncExternalStore((cb) => rt.subscribe(cb), () => rt.uiVersion);
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current!, world = worldRef.current!;
    rt.stage = stage; rt.world = world; rt.paintCamera();
    const ro = new ResizeObserver(() => { const r = stage.getBoundingClientRect(); rt.dispatch({ type: "resize", viewport: { width: r.width, height: r.height } }); });
    ro.observe(stage);
    const local = (e: { clientX: number; clientY: number }) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const sample = (e: PointerEvent) => ({ pointerId: e.pointerId, client: local(e), pressure: e.pressure, pointerType: (e.pointerType || "mouse") as "mouse" | "pen" | "touch" });
    const down = (e: PointerEvent) => {
      const target = hitTargetOf(e.target);
      if (target === "excluded") return;
      if (e.button === 1) e.preventDefault();
      // Take keyboard focus back from any live page, so shortcuts reach the canvas.
      if (document.activeElement !== stage) stage.focus({ preventScroll: true });
      rt.dispatch({ type: "pointer-down", p: sample(e), target, button: e.button, isPrimary: e.isPrimary, shift: e.shiftKey, mod: e.metaKey || e.ctrlKey });
    };
    const move = (e: PointerEvent) => {
      if (!rt.view.gesture) return;
      const c = e.getCoalescedEvents?.() ?? [];
      rt.dispatch({ type: "pointer-move", pointerId: e.pointerId, samples: (c.length ? c : [e]).map(sample), mod: e.metaKey || e.ctrlKey, shift: e.shiftKey });
    };
    const up = (e: PointerEvent) => rt.dispatch({ type: "pointer-up", pointerId: e.pointerId });
    const cancel = (e: PointerEvent) => rt.dispatch({ type: "pointer-cancel", pointerId: e.pointerId });
    // Pointer capture retargets dblclick to the stage, so hit-test the point instead of trusting e.target.
    const dbl = (e: MouseEvent) => { const t = hitTargetOf(document.elementFromPoint(e.clientX, e.clientY)); if (t !== "excluded") rt.dispatch({ type: "double-click", target: t }); };
    const wheel = (e: WheelEvent) => {
      if ((e.target as Element).closest?.(".panel-body, .chrome")) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
      rt.dispatch({ type: "wheel", dx: e.deltaX * k, dy: e.deltaY * k, zoom: e.metaKey ? "cmd" : e.ctrlKey ? "pinch" : "none", client: local(e) });
    };
    const key = (e: KeyboardEvent) => {
      // Annotation surfaces own their navigation and editing keys; Escape still reaches the canvas close chain.
      if (e.key !== "Escape" && (e.target as Element).closest?.(".screens-comments-panel, .screens-comment-popover")) return;
      const editable = isEditable(e.target), control = !editable && isControl(e.target);
      const mod = e.metaKey || e.ctrlKey, arrow = e.key.startsWith("Arrow");
      // Tab walks the items, then lets the browser move focus on to the toolbar, so focus is never trapped.
      const tab = e.key === "Tab" && !mod && !control && nextItem(rt.view, rt.doc(), e.shiftKey) !== null;
      const presentKey = !control && rt.view.pages.view === "present" && rt.doc().layout !== "canvas" && e.key in PRESENT_KEYS;
      if (!editable && (presentKey || (e.code === "Space" && !control) || tab || (arrow && !control) || (mod && (["=", "+", "-", "0", "1", "z", "Z", "a"].includes(e.key) || (e.shiftKey && e.code === "KeyC") || e.code === "BracketLeft" || e.code === "BracketRight")) || ((e.key === "Backspace" || e.key === "Delete") && !mod))) e.preventDefault();
      if (e.repeat && e.code === "Space") return;
      rt.dispatch({ type: "key-down", key: e.key, code: e.code, mod, shift: e.shiftKey, editable, control });
    };
    // A mouse click on a toolbar button leaves keyboard focus on the canvas, so Space and the arrows keep working.
    const keepFocus = (e: MouseEvent) => { if ((e.target as Element).closest?.(".chrome button:not([data-allow-focus])")) e.preventDefault(); };
    const keyUp = (e: KeyboardEvent) => rt.dispatch({ type: "key-up", code: e.code });
    const blur = () => setTimeout(() => rt.dispatch({ type: "window-blur", activeFrameItem: rt.itemForActiveFrame() }), 0);
    // Image files: a drop lands where it is released; a paste lands in the middle of the view. While files are dragged over
    // the window, frames take no pointer events, so a drop over a live snapshot reaches the canvas.
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    let depth = 0;
    const dragEnter = (e: DragEvent) => { if (hasFiles(e)) { depth++; stage.setAttribute("data-files-over", ""); } };
    const dragLeave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; stage.removeAttribute("data-files-over"); } };
    const dragOver = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer!.dropEffect = stage.contains(e.target as Node) ? "copy" : "none"; } };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; stage.removeAttribute("data-files-over");
      if (stage.contains(e.target as Node) && hitTargetOf(e.target) !== "excluded") void rt.dropImages([...e.dataTransfer!.files], local(e));
    };
    const paste = (e: ClipboardEvent) => {
      if (isEditable(e.target) || !e.clipboardData?.files.length) return;
      e.preventDefault();
      void rt.dropImages([...e.clipboardData.files], null);
    };
    addEventListener("dragenter", dragEnter); addEventListener("dragleave", dragLeave); addEventListener("dragover", dragOver); addEventListener("drop", drop);
    addEventListener("paste", paste);
    // Leaving fullscreen (the browser's own Escape included) ends Present.
    const fullscreen = () => { if (!document.fullscreenElement && rt.view.pages.view === "present") rt.dispatch({ type: "command", command: { kind: "pages-view", view: "scroll" } }); };
    document.addEventListener("fullscreenchange", fullscreen);
    stage.addEventListener("pointerdown", down);
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", cancel);
    stage.addEventListener("lostpointercapture", (e) => { if (rt.view.gesture?.pointerId === e.pointerId) cancel(e); });
    stage.addEventListener("dblclick", dbl);
    stage.addEventListener("wheel", wheel, { passive: false });
    addEventListener("keydown", key);
    addEventListener("keyup", keyUp);
    addEventListener("mousedown", keepFocus, true);
    addEventListener("blur", blur);
    return () => { ro.disconnect(); removeEventListener("dragenter", dragEnter); removeEventListener("dragleave", dragLeave); removeEventListener("dragover", dragOver);
      removeEventListener("drop", drop); removeEventListener("paste", paste); document.removeEventListener("fullscreenchange", fullscreen); removeEventListener("keydown", key); removeEventListener("keyup", keyUp); removeEventListener("mousedown", keepFocus, true); removeEventListener("blur", blur); };
  }, [rt]);

  const v = rt.view, st = client.get();
  const base = rt.doc();
  const [compactLayersOpen, setCompactLayersOpen] = useState(false);
  // On a wide canvas the person's choice to hide Layers holds across focus; on a compact one it starts closed each time.
  const [wideLayersOpen, setWideLayersOpen] = useState(() => { try { return localStorage.getItem("screens.layersOpen") !== "0"; } catch { return true; } });
  const compactCanvas = v.viewport.width <= 700;
  const focusId = v.focus.mode === "focused" ? v.focus.itemId : null;
  useEffect(() => { setCompactLayersOpen(false); }, [focusId]);
  // The optional index is independent of comment placement and the active bubble.
  const commentsOpen = v.comment.panelOpen;
  const layersOpen = compactCanvas ? compactLayersOpen : wideLayersOpen;
  const toggleLayers = () => {
    if (compactCanvas) { setCompactLayersOpen(!compactLayersOpen); return; }
    setWideLayersOpen(!wideLayersOpen); try { localStorage.setItem("screens.layersOpen", wideLayersOpen ? "0" : "1"); } catch { /* ignore */ }
  };
  // The filmstrip accompanies a focused slide. Hiding it is the person's choice and holds across Screens.
  const [filmOpen, setFilmOpen] = useState(() => { try { return localStorage.getItem("screens.filmstrip") !== "0"; } catch { return true; } });
  const toggleFilm = () => { setFilmOpen(!filmOpen); try { localStorage.setItem("screens.filmstrip", filmOpen ? "0" : "1"); } catch { /* ignore */ } };
  const selectedItemId = v.selection.kind === "items" && v.selection.ids.length === 1 ? v.selection.ids[0] : null;
  const g = v.gesture;
  const paged = base.layout !== "canvas", pol = policyOf(base.layout, v.pages.view), presenting = paged && v.pages.view === "present";
  // The tool and zoom bars move between spots; the page controls hold bottom-left in Presentations and Documents.
  const [toolsSpot, setToolsSpot] = useDock("screens.dock.tools", "bottom-center"), [zoomSpot, setZoomSpot] = useDock("screens.dock.zoom", "bottom-right");
  const pagesHold: DockSpot[] = paged && !presenting ? ["bottom-left"] : [];
  const zoomAt = dockAt(zoomSpot, "bottom-right", pagesHold), toolsAt = dockAt(toolsSpot, "bottom-center", [...pagesHold, zoomAt]);
  // Present keeps the slides on either side decoded as posters, so a step shows a sharp poster at once.
  const at = presenting ? presentIndex(v, base) : -1;
  const preload = new Set(presenting ? base.items.slice(Math.max(0, at - PRESENT_PRELOAD), at + PRESENT_PRELOAD + 1).map((it) => it.id) : []);
  const bar = paged && g?.kind === "item-drag" && g.reorder && g.dragging && g.slot !== null ? slotBar(base.layout as "slides" | "a4", base.items, new Set(g.initial.keys()), g.slot, v.viewport.width) : null;
  useEffect(() => { if (!presenting && document.fullscreenElement) void document.exitFullscreen().catch(() => {}); }, [presenting]);
  const setView = (view: PagesView) => {
    rt.dispatch({ type: "command", command: { kind: "pages-view", view } });
    // Fullscreen needs the button press itself; a host that refuses leaves Present filling the window.
    if (view === "present" && rt.view.pages.view === "present") void stageRef.current?.requestFullscreen?.().catch(() => {});
  };
  // Pieces are edited on the focused object, and on a page as soon as it is the one selected: a slide needs no mode to edit.
  const editing = focusId ?? (paged && v.pages.view === "scroll" ? selectedItemId : null) ?? null;
  const editId = editing && st.committed?.items[editing]?.kind === "html-snapshot" ? editing : null;
  const film = base.layout === "slides" && !presenting && focusId !== null && filmOpen;
  const doc = renderDocOf(base, g?.kind === "item-drag" || g?.kind === "item-resize" ? g.preview : null);
  const hasCanvasAnnotations = !paged && (
    base.strokes.some((stroke) => stroke.anchor.kind === "world" || doc.byId.has(stroke.anchor.itemId)) ||
    base.threads.some((thread) => presentThread(thread, v, doc).visible) ||
    g?.kind === "stroke" || v.comment.draft !== null
  );
  const guides = g?.kind === "item-drag" || g?.kind === "item-resize" ? g.guides : [];
  // Frames keep one DOM order (by id) and stack by z-index. Moving an iframe's node reloads it, so a reorder must not.
  const rank = new Map(doc.items.map((it, i) => [it.id, i + 1]));
  const byId = [...doc.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const fa = st.frameAccess;
  const failures = [...st.pending.values()].filter((e) => e.outcome.status === "failed");
  const pendingCount = [...st.pending.values()].filter((e) => e.outcome.status !== "failed").length;
  // Several selected frames resize together through one box around them; a single frame carries its own handles.
  const sel = v.selection.kind === "items" ? v.selection.ids.map((id) => doc.items.find((it) => it.id === id)).filter((it) => !!it) : [];
  const box = pol.handles && sel.length > 1 && v.tool === "move" && v.focus.mode === "none" && !sel.some((it) => it!.removing)
    ? boundsOf(sel.map((it) => it!.rect)) : null;
  const cursor = v.spacePanning || v.tool === "hand" ? (g?.kind === "pan" ? "grabbing" : "grab") : v.tool === "pencil" || v.tool === "comment" ? "crosshair" : "default";

  return (
    <>
    <div ref={stageRef} className="stage screens-stage" tabIndex={-1} data-filmstrip={film ? "" : undefined} data-tool={v.tool} data-dragging={g ? "" : undefined} data-layout={base.layout} data-tools-dock={toolsAt}
      data-pages={paged ? v.pages.view : undefined} style={{ cursor: presenting ? "default" : cursor }}>
      <div ref={worldRef} className="world" data-hit="bg">
        <div className="frame-layer">
          {byId.map((it) => {
            const load = rt.frames.load.get(it.id);
            const p = presentFrame(it, v, load === "ready");
            return <FrameView key={it.id} rt={rt} item={it} p={p} z={rank.get(it.id)!} live={rt.frames.live.has(it.id)} load={load} gen={rt.frames.gen.get(it.id) ?? 0}
              frameOrigin={fa?.origin ?? null} frameCapability={fa?.capability ?? null} editing={v.editing?.kind === "item-title" && v.editing.itemId === it.id}
              handles={pol.handles && p.selected && v.tool === "move" && !p.focused && !it.removing && v.focus.mode === "none"} page={paged} preload={preload.has(it.id)} />;
          })}
        </div>
        {!presenting && <StrokeLayer doc={doc.items} strokes={base.strokes} view={v} />}
        {!presenting && <PresenceLayer rt={rt} roster={st.roster} skew={st.rosterSkew} items={doc.items} hidden={rt.hiddenParticipants} drafts={st.drafts} following={v.following} />}
        {!presenting && <CommentLayer rt={rt} doc={doc} view={v} />}
        {bar && <div className="screens-slot-bar" style={{ left: bar.x, top: bar.y, height: bar.h }} />}
        {guides.map((gd, i) => (
          <div key={i} className="guide" style={gd.axis === "x"
            ? { left: gd.pos, top: gd.start, width: `calc(1px * var(--inv))`, height: gd.end - gd.start }
            : { top: gd.pos, left: gd.start, height: `calc(1px * var(--inv))`, width: gd.end - gd.start }} />
        ))}
        {box && <div className="selection-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}><Handles /></div>}
        {g?.kind === "marquee" && g.rect && <div className="marquee" style={{ left: g.rect.x, top: g.rect.y, width: g.rect.w, height: g.rect.h, boxShadow: "0 0 0 calc(1px * var(--inv)) var(--accent)" }} />}
      </div>

      <CommentOverlay rt={rt} doc={doc} view={v} />

      {st.committed && base.items.length === 0 && !hasCanvasAnnotations && !st.roster.some((p) => p.incoming) && (
        <div className="screens-center"><div className="empty-state"><Icon name="layout" /><h2>{base.layout === "slides" ? "Empty presentation" : base.layout === "a4" ? "Empty document" : "Empty canvas"}</h2></div></div>
      )}

      <div className="chrome top-left screens-row screens-canvas-head">
        {leading}
        <a className="icon-button" href="/" aria-label="Library" title="Library"><Icon name="back" /></a>
        <ScreenName rt={rt} title={base.title} editing={v.editing?.kind === "screen-name"} />
        {trailing}
        {(pendingCount > 0 || base.titleSync === "pending") && <span className="screens-saving" role="status"><span className="spinner" /> Saving</span>}
      </div>

      {paged && !presenting && (
        <div className="chrome bottom-left shell screens-pages-controls">
          <div className="segmented" role="tablist" aria-label="View">
            {(["scroll", "grid"] as const).map((view) => (
              <button key={view} role="tab" aria-selected={v.pages.view === view} onClick={() => setView(view)}>{view === "scroll" ? "Scroll" : "Grid"}</button>
            ))}
          </div>
          {base.layout === "slides" && <button className="tool" aria-label="Present" title="Present" disabled={!base.items.length} onClick={() => setView("present")}><Icon name="play" /></button>}
        </div>
      )}

      {presenting && <div className="chrome screens-present-controls shell" role="toolbar" aria-label="Presentation">
        <button className="button small" aria-label="Previous slide" disabled={at <= 0} onClick={() => rt.dispatch({ type: "key-down", key: "ArrowLeft", code: "ArrowLeft", mod: false, shift: false, editable: false, control: false })}>Previous</button>
        <span className="screens-slide-position" aria-live="polite">{at + 1} / {base.items.length}</span>
        <button className="button small" aria-label="Next slide" disabled={at >= base.items.length - 1} onClick={() => rt.dispatch({ type: "key-down", key: "ArrowRight", code: "ArrowRight", mod: false, shift: false, editable: false, control: false })}>Next</button>
        <span className="shell-divider" />
        <button className="icon-button" aria-label="Exit presentation" title="Exit presentation (Esc)" onClick={() => setView("scroll")}><Icon name="x" /></button>
      </div>}

      <div className="chrome screens-stack screens-tools" data-dock={toolsAt}>
        <div className="shell" role="toolbar" aria-label="Tools">
          <Grip label="Move toolbar" spot={toolsAt} open={SPOTS.filter((s) => s !== zoomAt && !pagesHold.includes(s))} onDock={setToolsSpot} />
          {TOOLS.filter((t) => t.available(v.capabilities) && (pol.marks || t.id === "move" || t.id === "hand")).map((t) => (
            <button key={t.id} className="tool" aria-label={`${t.label} (${t.key.toUpperCase()})`} title={`${t.label} (${t.key.toUpperCase()})`}
              aria-pressed={t.id === "hand" ? v.tool === "hand" || v.spacePanning : v.tool === t.id && !v.spacePanning}
              onClick={() => rt.dispatch({ type: "command", command: { kind: "select-tool", tool: t.id } })}>
              <Icon name={t.id} />
            </button>
          ))}
          {/* Always present, so selecting never moves the tools; disabled without a single selected object. */}
          <button className="tool" aria-label="Focus selection" title="Focus selection (F)"
            disabled={!selectedItemId || base.items.find((i) => i.id === selectedItemId)?.kind !== "html-snapshot" || v.focus.mode === "focused"}
            onClick={() => selectedItemId && rt.dispatch({ type: "command", command: { kind: "focus", itemId: selectedItemId } })}><Icon name="focus" /></button>
          <span className="shell-divider" />
          <button className="tool" data-copy-image="" data-state={rt.copy?.state} aria-label={rt.copy?.state === "copied" ? "Copied" : "Copy as image (⇧⌘C)"} title="Copy as image (⇧⌘C)"
            disabled={!copyableItem(v, base)} onClick={() => rt.dispatch({ type: "command", command: { kind: "copy-image" } })}>
            <Icon key={rt.copy?.state === "copied" ? "check" : "camera"} name={rt.copy?.state === "copied" ? "check" : "camera"} />
          </button>
        </div>
        {v.tool === "pencil" && (
          <div className="shell screens-pencil" role="group" aria-label="Pencil color">
            {PENCIL_COLORS.map((c) => (
              <button key={c.hex} className="tool" aria-label={c.name} title={c.name} aria-pressed={v.pencil.color === c.hex}
                onClick={() => rt.dispatch({ type: "command", command: { kind: "pencil-color", color: c.hex } })}>
                <span className="screens-swatch" style={{ background: c.hex }} />
              </button>
            ))}
            <span className="shell-divider" />
            <span role="group" aria-label="Pencil thickness" className="screens-row">
              {PENCIL_SIZES.map((s) => (
                <button key={s} className="tool" aria-label={`${s}`} title={`Thickness ${s}`} aria-pressed={v.pencil.size === s}
                  onClick={() => rt.dispatch({ type: "command", command: { kind: "pencil-size", size: s } })}>
                  <span className="screens-dot" style={{ width: Math.min(16, s), height: Math.min(16, s) }} />
                </button>
              ))}
            </span>
          </div>
        )}
      </div>

      <div className="chrome screens-zoom" data-dock={zoomAt}>
        <div className="shell">
          <Grip label="Move zoom controls" spot={zoomAt} open={SPOTS.filter((s) => s !== toolsAt && !pagesHold.includes(s))} onDock={setZoomSpot} />
          <button className="tool" aria-label="Invert scroll" title="Invert scroll" aria-pressed={v.invertScroll} onClick={() => rt.setInvertScroll(!v.invertScroll)}><Icon name="scroll" /></button>
          <button className="tool" aria-label="Theme" title="Theme" onClick={() => rt.setTheme(v.theme === "dark" ? "light" : "dark")}><Icon name={v.theme === "dark" ? "sun" : "moon"} /></button>
          <span className="shell-divider" />
          <button className="tool" aria-label="Zoom out" title="Zoom out" onClick={() => rt.dispatch({ type: "command", command: { kind: "zoom-out" } })}><Icon name="minus" /></button>
          <button className="zoom-value" aria-label="Fit all" title="Fit all" ref={(el) => { rt.zoomLabel = el; rt.paintCamera(); }} onClick={() => rt.dispatch({ type: "command", command: { kind: "fit-all" } })} />
          <button className="tool" aria-label="Zoom in" title="Zoom in" onClick={() => rt.dispatch({ type: "command", command: { kind: "zoom-in" } })}><Icon name="plus" /></button>
        </div>
      </div>

      {!presenting && <PresenceOverlay rt={rt} roster={st.roster} items={doc.items} following={v.following} />}
      <div className="chrome top-right screens-stack screens-right">
        <button className="button screens-comments-toggle" aria-label="Comments" aria-controls="screens-comments" aria-expanded={commentsOpen} onClick={() => rt.dispatch({ type: "command", command: { kind: "comments-panel", open: !commentsOpen } })}><Icon name="comment" />{base.threads.filter((t) => !t.resolved && (!presenting || (t.anchor.kind === "item" && v.focus.mode === "focused" && t.anchor.itemId === v.focus.itemId))).length || ""}</button>
        {!presenting && st.roster.length > 0 && <PresenceRoster rt={rt} roster={st.roster} skew={st.rosterSkew} items={doc.items} following={v.following} hidden={rt.hiddenParticipants} />}
        {!presenting && v.focus.mode === "focused" && <div className="shell screens-focus-actions">
          {base.layout === "slides" && <button className="button" aria-expanded={filmOpen} onClick={toggleFilm}>Slides</button>}
          {!commentsOpen && st.committed?.items[v.focus.itemId]?.kind === "html-snapshot" && <button className="button" aria-expanded={layersOpen} onClick={toggleLayers}>Layers</button>}
          <button className="button" onClick={() => rt.dispatch({ type: "command", command: { kind: "exit-focus" } })}>Exit focus</button>
        </div>}
        {!presenting && editId && <PieceEditor key={editId} rt={rt} itemId={editId} panel={focusId !== null && layersOpen && !commentsOpen} />}
        {commentsOpen && <CommentsPanel rt={rt} doc={base} view={v} />}
      </div>

      <div className="chrome bottom-center screens-stack screens-toasts">
        {rt.copy?.state === "failed" && <div className="toast error" role="alert"><Icon name="alert" />Couldn't copy image</div>}
        {st.connection === "reconnecting" && <div className="toast" role="status"><span className="spinner" />Reconnecting…</div>}
        {failures.slice(-1).map((f) => (
          <div key={f.opId} className="toast error screens-failure-toast" role="alert">
            <Icon name="alert" /><span>{f.outcome.status === "failed" && f.outcome.error.message.includes("Disk full.") ? "Disk full. Free some space and retry." : failureText(f.op.type, f.outcome.status === "failed" ? f.outcome.error.code : "")}</span>
            <div className="screens-failure-actions">
              {f.op.type !== "undo" && f.op.type !== "redo" && <button className="button small" onClick={() => client.retry(f.opId)}>Retry</button>}
              <DiscardChange onDiscard={() => client.dismiss(f.opId)} />
            </div>
          </div>
        ))}
      </div>
    </div>
    {film && <Filmstrip rt={rt} items={base.items} current={focusId} />}
    </>
  );
}

function DiscardChange({ onDiscard }: { onDiscard: () => void }) {
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!armed) return;
    const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setArmed(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setArmed(false); };
    addEventListener("click", outside);
    addEventListener("keydown", escape, true);
    return () => { removeEventListener("click", outside); removeEventListener("keydown", escape, true); };
  }, [armed]);
  return <button ref={ref} data-allow-focus className="button small screens-danger" aria-label="Discard unsaved change" onBlur={() => setArmed(false)} onClick={() => {
    if (armed) onDiscard(); else setArmed(true);
  }}>{armed ? "Discard? Can't undo" : "Discard"}</button>;
}

function failureText(op: string, code: string): string {
  if (op === "undo" || op === "redo") return code === "conflict" ? `Can't ${op}: it changed since` : `Couldn't ${op}`;
  if (code === "upload") return "Couldn't upload";
  return code === "conflict" ? "Couldn't save: it changed since" : "Couldn't save";
}

interface FrameProps {
  readonly rt: CanvasRuntime; readonly item: DisplayItem; readonly p: FramePresentation; readonly z: number;
  readonly live: boolean; readonly load: string | undefined; readonly gen: number;
  readonly frameOrigin: string | null; readonly frameCapability: string | null; readonly editing: boolean; readonly handles: boolean;
  /** A page of a Presentation or Document: images fit inside it. preload: kept decoded while presenting. */
  readonly page: boolean; readonly preload: boolean;
}
/** Re-renders only when its own item, presentation or frame state changes: a resize repaints one frame, not all. */
const FrameView = memo(function FrameView({ rt, item, p, z, live, load, gen, frameOrigin, frameCapability, editing, handles, page, preload }: FrameProps) {
  const classes = ["frame", item.kind === "reference-image" && "reference", page && "page", p.showActions && !p.focused && item.kind === "html-snapshot" && "has-actions", p.selected && "selected", p.multiSelected && "multi-selected",
    p.interacting && "interacting", item.sync === "failed" && "failed", load === "failed" && "failed"].filter(Boolean).join(" ");
  const bridge = rt.client.transportKind === "app";
  const savedItem = rt.client.get().committed?.items[item.id];
  const [srcdoc, setSrcdoc] = useState<{ version: string; html: string } | null>(null);
  const [contentUrl, setContentUrl] = useState<string | null>(null);
  const [renderedPoster, setRenderedPoster] = useState<{ version: string; hash: string } | null>(null);
  const [shownPoster, setShownPoster] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge || item.kind !== "html-snapshot" || item.posterHash || !item.contentVersion || savedItem?.kind !== "html-snapshot" || savedItem.contentVersion !== item.contentVersion) return;
    let active = true;
    const start = opening?.now();
    rt.client.poster(item.id, item.contentVersion).then((p) => { opening?.duration("poster.answer", start, { itemId: item.id, hash: p.hash }); if (active && p.hash) setRenderedPoster({ version: p.contentVersion, hash: p.hash }); }).catch(() => {});
    return () => { active = false; };
  }, [bridge, item.id, item.kind, item.posterHash, item.contentVersion, savedItem, rt]);
  const imageHash = item.kind === "reference-image" ? item.assetHash : item.posterHash ?? (renderedPoster?.version === item.contentVersion ? renderedPoster.hash : null);
  useEffect(() => {
    if (!bridge || !imageHash || (item.kind === "reference-image" && item.sync !== "committed")) { setContentUrl(null); return; }
    let active = true;
    const start = opening?.now();
    rt.client.readContent(imageHash).then((bytes) => {
      opening?.duration("poster.bytes", start, { itemId: item.id, bytes: bytes.byteLength });
      if (active) { const encode = opening?.now(); const url = imageDataUrl(bytes); opening?.duration("poster.data-url", encode, { itemId: item.id, bytes: bytes.byteLength }); setContentUrl(url); }
    }).catch(() => { opening?.mark("poster.failed", { itemId: item.id }); });
    return () => { active = false; };
  }, [bridge, imageHash, item.kind, item.sync, rt]);
  useEffect(() => {
    if (!bridge || !live || savedItem?.kind !== "html-snapshot" || savedItem.contentVersion !== item.contentVersion) { setSrcdoc(null); return; }
    let active = true;
    const run = async () => {
      const readStart = opening?.now();
      const entries = await Promise.all(Object.values(savedItem.assetManifest).map(async (a) => [a.hash, await rt.client.readContent(a.hash)] as const));
      opening?.duration("bundle.read", readStart, { itemId: item.id, gen, files: entries.length, bytes: entries.reduce((n, [, b]) => n + b.byteLength, 0) });
      const files = new Map(entries);
      const inlineStart = opening?.now();
      const html = inlineBundle(savedItem.entry, savedItem.assetManifest, (h) => files.get(h) ?? null).html;
      opening?.duration("bundle.inline", inlineStart, { itemId: item.id, gen, chars: html.length });
      const csp = HOST_CSP("'none'").replace(/; frame-ancestors .*/, "");
      if (active) { opening?.mark("srcdoc.prepared", { itemId: item.id, gen }); setSrcdoc({ version: savedItem.contentVersion, html: `<meta http-equiv="Content-Security-Policy" content="${csp}">${html}` }); }
    };
    void run().catch(() => { opening?.mark("bundle.failed", { itemId: item.id, gen }); if (active) setSrcdoc(null); });
    return () => { active = false; };
  }, [bridge, live, savedItem, item.contentVersion, rt]);
  const [kept, setKept] = useState<HostSource | null>(null);
  let surface: ReactNode = null, current: HostSource | null = null;
  if (item.kind === "reference-image" && item.assetHash) surface = <img src={(item.sync !== "committed" && rt.localImage(item.assetHash)) || (bridge ? contentUrl ?? undefined : `/content/${item.assetHash}`)} alt="" draggable={false} />;
  else {
    // An object saved without a load check has no stored poster: the service renders one for its content on request.
    const saved = rt.client.get().committed?.items[item.id];
    const posterSrc = imageHash ? (bridge ? contentUrl : `/content/${imageHash}`) : !bridge && item.contentVersion && saved?.kind === "html-snapshot" && saved.contentVersion === item.contentVersion
      ? `/poster/${rt.client.screenId}/${item.id}/${item.contentVersion}?s=${saved.width}x${saved.height}` : null;
    const key = `${item.contentVersion}:${gen}`;
    const source: HostSource | null = bridge ? (live && srcdoc?.version === item.contentVersion ? { key, srcDoc: srcdoc.html } : null)
      : live && frameOrigin && frameCapability && item.contentVersion ? { key, src: `${frameOrigin}/host/${rt.client.screenId}/${item.id}/${item.contentVersion}?gen=${gen}&cap=${frameCapability}` } : null;
    current = load === "ready" ? source : null;
    // An edit loads the new version under the one on screen, and swaps when it is ready: the page never blinks to its poster.
    // The two are keyed siblings, so React leaves the old page's node where it is. Moving an iframe reloads it.
    const swapping = live && kept !== null && kept.key !== key;
    const old = swapping && load === "loading" ? kept : null;
    const frame = (h: HostSource, top: boolean) => <iframe key={h.key} title={item.title} ref={top ? (el) => rt.attachHost(item.id, gen, el) : undefined} aria-hidden={top ? undefined : true}
      {...(h.srcDoc !== undefined ? { sandbox: "allow-scripts", srcDoc: h.srcDoc } : { src: h.src })}
      style={{ opacity: !top || load === "ready" ? 1 : 0, pointerEvents: top && p.input === "page" ? "auto" : "none", transition: swapping ? "none" : undefined }} />;
    const shown = load === "ready" || old !== null;
    const poster = posterSrc ? <img key={posterSrc} src={posterSrc} alt="" draggable={false} style={{ opacity: shown ? 0 : 1 }} onLoad={() => { opening?.mark("poster.loaded", { itemId: item.id }); setShownPoster(posterSrc); }} onError={(e) => { opening?.mark("poster.failed", { itemId: item.id }); e.currentTarget.style.visibility = "hidden"; }}
      ref={(el) => { if (el && preload && !el.dataset.decoded) void el.decode().then(() => { el.dataset.decoded = ""; }, () => {}); }} /> : null;
    // Until a poster or the live page shows, a pulsing placeholder sits under it, so a frame never reads as a blank page.
    const waiting = !shown && (!poster || shownPoster !== posterSrc);
    surface = <>{waiting && <div className="screens-frame-placeholder" data-waiting={poster ? "poster" : undefined}>{!poster && live && load === "loading" ? <span className="spinner" /> : null}</div>}{poster}{[old && frame(old, false), source && frame(source, true)]}</>;
  }
  useEffect(() => { if (!live) setKept(null); else if (current && current.key !== kept?.key) setKept(current); }, [live, current?.key]);
  return (
    <div className={classes} data-item={item.id} data-load={load ?? "poster"} data-input={p.input}
      style={{ left: item.x, top: item.y, width: item.width, height: item.height, zIndex: z, opacity: p.hiddenByFocus ? 0 : item.removing ? 0.4 : 1,
        visibility: p.hiddenByFocus ? "hidden" : undefined, pointerEvents: item.removing ? "none" : undefined }}>
      {!p.focused && (
        <div className="frame-title" title={item.title} data-hit={`item:${item.id}:title`}>
          <Icon name={item.kind === "reference-image" ? "image" : "code"} className="icon kind" />
          {editing ? <TitleInput rt={rt} initial={item.title} /> : <span>{item.title}</span>}
          {item.sync === "pending" && <span className="spinner screens-mini-spinner" aria-label="Saving" />}
        </div>
      )}
      {p.showActions && !p.focused && item.kind === "html-snapshot" && (
        <div className="frame-actions"><button className="frame-action" aria-label={`Focus ${item.title}`} onClick={() => rt.dispatch({ type: "command", command: { kind: "focus", itemId: item.id } })}><Icon name="focus" /></button></div>
      )}
      <div className="frame-surface" title={page ? item.title : undefined} style={p.focused ? { boxShadow: "none" } : undefined}>
        {surface}
        {p.input === "shield" && <div className="frame-shield" data-hit={`item:${item.id}:surface`} />}
      </div>
      {handles && <Handles />}
    </div>
  );
}, (a, b) => a.item === b.item && a.z === b.z && a.live === b.live && a.load === b.load && a.gen === b.gen && a.editing === b.editing && a.handles === b.handles &&
  a.page === b.page && a.preload === b.preload &&
  a.frameOrigin === b.frameOrigin && a.frameCapability === b.frameCapability && a.rt === b.rt &&
  (Object.keys(a.p) as (keyof FramePresentation)[]).every((k) => a.p[k] === b.p[k]));

/** One live page: the frame origin's host URL, or in the MCP App the inlined document. */
interface HostSource { readonly key: string; readonly src?: string; readonly srcDoc?: string }

const Handles = () => <>{HANDLES.map((h) => <span key={h} className={`resize-handle ${h}`} data-hit={`handle:${h}`} />)}</>;

function TitleInput({ rt, initial }: { rt: CanvasRuntime; initial: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.select(); }, []);
  const done = useRef(false);
  const commit = () => { if (!done.current) { done.current = true; rt.dispatch({ type: "title-commit", value: ref.current?.value ?? "" }); } };
  return <input ref={ref} className="screens-title-input" defaultValue={initial} maxLength={120} aria-label="Title"
    onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { done.current = true; rt.dispatch({ type: "title-cancel" }); } e.stopPropagation(); }} onBlur={commit} />;
}

function ScreenName({ rt, title, editing }: { rt: CanvasRuntime; title: string; editing: boolean }) {
  if (editing) return <span className="screen-name"><TitleInput rt={rt} initial={title} /></span>;
  return <button className="screen-name" onClick={() => rt.dispatch({ type: "command", command: { kind: "edit", editing: { kind: "screen-name" } } })}>{title || "Untitled"}</button>;
}

/** Committed points never change in place, so each outline is computed once per points array and size. */
const outlines = new WeakMap<object, { size: number; d: string }>();
function outline(points: DisplayStroke["points"], size: number): string {
  const hit = outlines.get(points);
  if (hit && hit.size === size) return hit.d;
  const d = strokePath(points, size);
  outlines.set(points, { size, d });
  return d;
}

function StrokeLayer({ doc, strokes, view }: { doc: readonly DisplayItem[]; strokes: readonly DisplayStroke[]; view: ViewState }) {
  const byId = new Map(doc.map((i) => [i.id, i]));
  const g = view.gesture;
  const all: DisplayStroke[] = [...strokes];
  if (g?.kind === "stroke" && g.drawing) all.push({ ...g.draft, createdAt: Infinity, sync: "pending", removing: false });
  const sel = view.selection.kind === "stroke" ? view.selection.id : null;
  const hidden = view.focus.mode === "focused" ? view.focus.itemId : null;
  return (
    <svg className="screens-strokes" width="1" height="1">
      <defs>{doc.map((i) => <clipPath key={i.id} id={`clip-${i.id}`}><rect x={0} y={0} width={i.width} height={i.height} /></clipPath>)}</defs>
      {all.map((s) => {
        let tx = 0, ty = 0, clip: string | undefined;
        if (s.anchor.kind === "item") {
          const it = byId.get(s.anchor.itemId);
          if (!it) return null; // a stroke whose anchor is gone is hidden, never reparented
          if (hidden && it.id !== hidden) return null;
          tx = it.x; ty = it.y; clip = `url(#clip-${it.id})`;
        } else if (hidden) return null;
        const b = sel === s.id ? strokeBounds(s.points, s.size) : null;
        return (
          <g key={s.id} transform={`translate(${tx} ${ty})`} opacity={s.removing ? 0.3 : 1}>
            <g clipPath={clip}><path d={outline(s.points, s.size)} fill={s.color} data-hit={`stroke:${s.id}`} className="screens-stroke" /></g>
            {b && <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="none" stroke="var(--accent)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
          </g>
        );
      })}
    </svg>
  );
}

