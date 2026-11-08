// Movable bars: a grip drags a bar, which snaps to the nearest open spot on release. A click or arrow key on the grip moves it to the next spot.
// Where each bar sits is a per-viewer preference kept in this browser.

import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { safeStore } from "./runtime.ts";
import { Icon } from "./icons.tsx";

export type DockSpot = "top-center" | "bottom-left" | "bottom-center" | "bottom-right";
export const SPOTS: readonly DockSpot[] = ["bottom-left", "bottom-center", "bottom-right", "top-center"];

export function useDock(key: string, fallback: DockSpot): [DockSpot, (s: DockSpot) => void] {
  const [spot, setSpot] = useState<DockSpot>(() => { const v = safeStore.get(key) as DockSpot | null; return v && SPOTS.includes(v) ? v : fallback; });
  return [spot, (s) => { safeStore.set(key, s); setSpot(s); }];
}

/** The spot a bar shows at: its chosen one, else its default, else the first free one, skipping spots other controls hold. */
export const dockAt = (spot: DockSpot, fallback: DockSpot, taken: readonly DockSpot[]): DockSpot =>
  [spot, fallback, ...SPOTS].find((s) => !taken.includes(s)) ?? fallback;

export function Grip({ label, spot, open, onDock }: { label: string; spot: DockSpot; open: readonly DockSpot[]; onDock: (s: DockSpot) => void }) {
  const next = () => { const k = open.indexOf(spot); onDock(open[(k + 1) % open.length] ?? spot); };
  const down = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const grip = e.currentTarget, bar = grip.closest<HTMLElement>(".chrome"), stage = bar?.offsetParent as HTMLElement | null;
    if (!bar || !stage) return;
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    const move = (m: PointerEvent) => {
      const dx = m.clientX - x0, dy = m.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true; bar.dataset.moving = ""; bar.style.translate = `${dx}px ${dy}px`;
    };
    const up = () => {
      grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); grip.removeEventListener("pointercancel", up);
      if (!moved) { next(); return; }
      const r = bar.getBoundingClientRect(), s = stage.getBoundingClientRect(), i = 6;
      const cx = r.left + r.width / 2 - s.left, cy = r.top + r.height / 2 - s.top, hw = r.width / 2, hh = r.height / 2;
      const centers: Record<DockSpot, [number, number]> = {
        "top-center": [s.width / 2, i + hh], "bottom-center": [s.width / 2, s.height - i - hh],
        "bottom-left": [i + hw, s.height - i - hh], "bottom-right": [s.width - i - hw, s.height - i - hh],
      };
      const best = open.reduce((a, b) => Math.hypot(centers[b][0] - cx, centers[b][1] - cy) < Math.hypot(centers[a][0] - cx, centers[a][1] - cy) ? b : a, spot);
      // Hand the bar from where it was dropped to its spot: hold the drop point, change spot, then animate the offset away.
      const before = bar.getBoundingClientRect();
      bar.style.translate = ""; delete bar.dataset.moving;
      onDock(best);
      requestAnimationFrame(() => {
        const after = bar.getBoundingClientRect();
        bar.style.transition = "none"; bar.style.translate = `${before.left - after.left}px ${before.top - after.top}px`;
        void bar.offsetWidth;
        bar.style.transition = "translate 0.18s cubic-bezier(.16, 1, .3, 1)"; bar.style.translate = "";
        bar.addEventListener("transitionend", () => { bar.style.transition = ""; }, { once: true });
      });
    };
    grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up); grip.addEventListener("pointercancel", up);
  };
  return (
    <button className="tool screens-grip" aria-label={label} title={label} data-dock-grip={spot} onPointerDown={down}
      onClick={(e) => { if (e.detail === 0) next(); }} onKeyDown={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); next(); } }}>
      <Icon name="grip" />
    </button>
  );
}
