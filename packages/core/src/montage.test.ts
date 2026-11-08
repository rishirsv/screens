import { test } from "node:test";
import assert from "node:assert/strict";
import { MONTAGE_PAD, emptyScreen, planMontage, type CanvasItem, type ScreenDoc } from "./index.ts";

const item = (id: string, x: number, y: number, width: number, height: number, z: number): CanvasItem =>
  ({ id, kind: "reference-image", assetHash: "h", mediaType: "image/png", x, y, width, height, z, revision: 1, title: `Item ${id}` });
const screen = (...items: CanvasItem[]): ScreenDoc => ({ ...emptyScreen("s", "S", 0), items: Object.fromEntries(items.map((i) => [i.id, i])) });

// Three phones in a row, 400 apart, plus a wide board below: bounds 0..2400 x 0..1800.
const doc = screen(item("a", 0, 0, 390, 844, 1), item("b", 1000, 0, 390, 844, 2), item("c", 2010, 0, 390, 844, 3), item("d", 0, 1000, 2400, 800, 0));

test("the default montage fits every item under the size cap, scaled, with room for labels", () => {
  const p = planMontage(doc, { maxSize: 1000 })!;
  assert.equal(Math.max(p.width, p.height), 1000);
  assert.ok(p.width <= 1000 && p.height <= 1000);
  // The content's longer side (2400) fills the cap minus the pad on both sides.
  assert.equal(p.scale, (1000 - 2 * MONTAGE_PAD) / 2400);
  assert.deepEqual(p.items.map((i) => i.id), ["d", "a", "b", "c"], "back to front");
  for (const m of p.items) {
    const it = doc.items[m.id]!;
    // Each legend rect is the item's world rect, moved by the region's origin and scaled, rounded to pixels.
    assert.ok(Math.abs(m.visible.x - (it.x - p.world.x) * p.scale) <= 0.5, `${m.id} x`);
    assert.ok(Math.abs(m.visible.y - (it.y - p.world.y) * p.scale) <= 0.5, `${m.id} y`);
    assert.ok(Math.abs(m.visible.w - it.width * p.scale) <= 1, `${m.id} w`);
    assert.ok(Math.abs(m.visible.h - it.height * p.scale) <= 1, `${m.id} h`);
    assert.equal(m.partial, false);
  }
  const a = p.items.find((i) => i.id === "a")!;
  assert.deepEqual([a.visible.x, a.visible.y], [MONTAGE_PAD, MONTAGE_PAD]);
});

test("a montage never scales up past 1", () => {
  const p = planMontage(screen(item("a", 50, 50, 200, 100, 0)))!;
  assert.equal(p.scale, 1);
  assert.deepEqual(p.items[0]!.visible, { x: MONTAGE_PAD, y: MONTAGE_PAD, w: 200, h: 100 });
  assert.deepEqual([p.width, p.height], [200 + 2 * MONTAGE_PAD, 100 + 2 * MONTAGE_PAD]);
});

test("rect crops to exactly that world region and keeps only what intersects it", () => {
  const rect = { x: 900, y: -100, w: 1600, h: 1000 };
  const p = planMontage(doc, { rect, maxSize: 800 })!;
  assert.deepEqual(p.world, rect, "no pad on an explicit rect");
  assert.equal(p.scale, 0.5);
  assert.deepEqual([p.width, p.height], [800, 500]);
  // a ends at x 390, left of the region; d starts at y 1000, below it.
  assert.deepEqual(p.items.map((i) => i.id), ["b", "c"]);
  const b = p.items[0]!, c = p.items[1]!;
  assert.deepEqual(b.visible, { x: 50, y: 50, w: 195, h: 422 });
  assert.equal(b.partial, false);
  // c runs from x 2010 to 2400, inside the region's right edge at 2500.
  assert.deepEqual(c.visible, { x: 555, y: 50, w: 195, h: 422 });
});

test("an item cut by rect is clipped to the image and marked partial", () => {
  const p = planMontage(doc, { rect: { x: 1200, y: 400, w: 1000, h: 1000 }, maxSize: 1000 })!;
  const b = p.items.find((i) => i.id === "b")!;
  assert.deepEqual(b.at, { x: -200, y: -400, w: 390, h: 844 });
  assert.deepEqual(b.visible, { x: 0, y: 0, w: 190, h: 444 });
  assert.equal(b.partial, true);
  const d = p.items.find((i) => i.id === "d")!;
  assert.deepEqual(d.visible, { x: 0, y: 600, w: 1000, h: 400 });
  assert.equal(d.partial, true);
});

test("maxSize is held to its range, and an empty Screen or region has nothing to plan", () => {
  assert.equal(Math.max(planMontage(doc, { maxSize: 10 })!.width, planMontage(doc, { maxSize: 10 })!.height), 200);
  assert.equal(planMontage(doc, { maxSize: 100_000 })!.width, 2400 + 2 * MONTAGE_PAD, "scale stops at 1 before the 4096 cap");
  assert.equal(planMontage(screen()), null);
  assert.equal(planMontage(doc, { rect: { x: 0, y: 0, w: 0, h: 10 } }), null);
  assert.deepEqual(planMontage(doc, { rect: { x: 5000, y: 5000, w: 100, h: 100 } })!.items, []);
});

test("world strokes widen the default bounds; item strokes follow their item and clip to it", () => {
  const base = screen(item("a", 0, 0, 100, 100, 0));
  const withStrokes: ScreenDoc = { ...base, strokes: {
    w: { id: "w", anchor: { kind: "world" }, points: [[300, 50, 0.5], [400, 60, 0.5]], color: "#f00", size: 4, author: { kind: "person" }, createdAt: 0 },
    i: { id: "i", anchor: { kind: "item", itemId: "a" }, points: [[10, 10, 0.5]], color: "#00f", size: 4, author: { kind: "person" }, createdAt: 0 },
  } };
  const p = planMontage(withStrokes)!;
  assert.equal(p.world.w, 402 + 2 * MONTAGE_PAD);
  const i = p.strokes.find((s) => s.id === "i")!;
  assert.deepEqual(i.origin, { x: 0, y: 0 });
  assert.deepEqual(i.clip, { x: 0, y: 0, w: 100, h: 100 });
});

test("a stroke that crosses a region with no sampled point inside it is still in the montage", () => {
  const stroke = (id: string, points: [number, number, number][], size = 4) =>
    ({ id, anchor: { kind: "world" as const }, points, color: "#f00", size, author: { kind: "person" as const }, createdAt: 0 });
  const d: ScreenDoc = { ...screen(), strokes: {
    across: stroke("across", [[-100, 50, 0.5], [200, 50, 0.5]]),
    // Its centerline is 3 units outside, but half its width (5) reaches in.
    edge: stroke("edge", [[-50, 103, 0.5], [150, 103, 0.5]], 10),
    away: stroke("away", [[-100, 300, 0.5], [200, 300, 0.5]]),
  } };
  const p = planMontage(d, { rect: { x: 0, y: 0, w: 100, h: 100 } })!;
  assert.deepEqual(p.strokes.map((s) => s.id).sort(), ["across", "edge"]);
});
