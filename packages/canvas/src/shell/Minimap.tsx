import { useLayoutEffect, useRef, type PointerEvent } from "react";
import type { Point, Rect } from "@screens/core";
import { boundsOf, containsPoint, strokeBounds, strokePath, viewportWorldRect, type BaseDoc } from "../engine/index.ts";
import type { CanvasRuntime } from "./runtime.ts";

const WIDTH = 200, HEIGHT = 132, INSET = 10;

function mapBounds(content: Rect | null, viewport: Rect): Rect {
  const b = content ? boundsOf([content, viewport])! : viewport;
  const unitsPerPixel = Math.max(b.w / (WIDTH - 2 * INSET), b.h / (HEIGHT - 2 * INSET));
  const w = WIDTH * unitsPerPixel, h = HEIGHT * unitsPerPixel;
  return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
}

export function Minimap({ rt, doc }: { rt: CanvasRuntime; doc: BaseDoc }) {
  const svg = useRef<SVGSVGElement>(null);
  const outline = useRef<SVGRectElement>(null);
  const projection = useRef<Rect | null>(null);
  const drag = useRef<{ id: number; bounds: Rect; offset: Point } | null>(null);
  const items = doc.items.filter((it) => !it.removing);
  const ink = doc.strokes.filter((s) => !s.removing && s.anchor.kind === "world" && s.points.length > 0);
  const content = boundsOf([...items.map((it) => it.rect), ...ink.map((s) => strokeBounds(s.points, s.size))]);

  const paint = () => {
    const map = svg.current, rect = outline.current;
    if (!map || !rect) return;
    const viewport = viewportWorldRect(rt.view.camera, rt.view.viewport);
    if (viewport.w <= 0 || viewport.h <= 0) return;
    // Keep the map still under a captured pointer while the camera moves.
    const bounds = drag.current?.bounds ?? mapBounds(content, viewport);
    projection.current = bounds;
    map.setAttribute("viewBox", `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`);
    rect.setAttribute("x", String(viewport.x));
    rect.setAttribute("y", String(viewport.y));
    rect.setAttribute("width", String(viewport.w));
    rect.setAttribute("height", String(viewport.h));
  };
  useLayoutEffect(() => {
    paint();
    return rt.onPaint(paint);
  });

  const worldPoint = (e: PointerEvent<SVGSVGElement>, b: Rect): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    const fraction = (n: number) => Math.max(0, Math.min(1, n));
    return { x: b.x + fraction((e.clientX - r.left) / r.width) * b.w, y: b.y + fraction((e.clientY - r.top) / r.height) * b.h };
  };
  const navigate = (p: Point, offset: Point) => rt.dispatch({
    type: "command", command: { kind: "center-camera", at: { x: p.x + offset.x, y: p.y + offset.y } },
  });
  const start = (e: PointerEvent<SVGSVGElement>) => {
    const bounds = projection.current;
    if (e.button !== 0 || !bounds || drag.current || rt.view.gesture) return;
    const p = worldPoint(e, bounds);
    const v = viewportWorldRect(rt.view.camera, rt.view.viewport);
    const inside = containsPoint(v, p);
    const offset = inside ? { x: v.x + v.w / 2 - p.x, y: v.y + v.h / 2 - p.y } : { x: 0, y: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, bounds, offset };
    if (!inside) navigate(p, offset);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const active = drag.current;
    if (active?.id === e.pointerId) navigate(worldPoint(e, active.bounds), active.offset);
  };
  const end = (e: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    paint();
  };

  return (
    <div className="chrome screens-minimap">
      <svg ref={svg} width={WIDTH} height={HEIGHT} preserveAspectRatio="none" role="img" aria-label="Canvas overview"
        onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
        {items.map(({ id, rect: r }) => <rect key={id} className="screens-minimap-item" x={r.x} y={r.y} width={r.w} height={r.h} />)}
        {ink.map((s) => <path key={s.id} d={strokePath(s.points, s.size)} fill={s.color} />)}
        <rect ref={outline} className="screens-minimap-viewport" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
