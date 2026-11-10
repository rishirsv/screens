// The slide filmstrip: every page of a Presentation along the bottom while one is focused, so editing moves from slide to
// slide without leaving focus. It sits below the stage, never over the slide.

import { useEffect, useRef } from "react";
import type { ItemId } from "@screens/core";
import type { DisplayItem } from "../engine/index.ts";
import type { CanvasRuntime } from "./runtime.ts";
import { Thumb } from "./library/Grid.tsx";

export function Filmstrip({ rt, items, current }: { rt: CanvasRuntime; items: readonly DisplayItem[]; current: ItemId }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [current, items.length]);
  return (
    <nav ref={ref} className="screens-slidestrip" aria-label="Slides" onWheel={(e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY; }}>
      {items.map((it, i) => (
        // The press keeps keyboard focus on the canvas, so its shortcuts go on working.
        <button key={it.id} className="screens-slide-thumb" data-film={it.id} aria-current={it.id === current} aria-label={`Slide ${i + 1}: ${it.title}`} title={it.title}
          onMouseDown={(e) => e.preventDefault()} onClick={() => rt.dispatch({ type: "command", command: { kind: "focus", itemId: it.id } })}>
          <Thumb hash={it.kind === "reference-image" ? it.assetHash : it.posterHash} page="slides"
            src={it.kind === "html-snapshot" && !it.posterHash && it.contentVersion && it.sync === "committed" ? `/poster/${rt.client.screenId}/${it.id}/${it.contentVersion}?s=${it.width}x${it.height}` : undefined} />
          <span className="screens-slide-number">{i + 1}</span>
        </button>
      ))}
    </nav>
  );
}
