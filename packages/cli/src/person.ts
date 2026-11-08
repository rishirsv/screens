// The person side: real browser input. Targets are located in the page (DOM boxes and the camera), then
// checked with elementFromPoint before any press. A covered or missing target fails the step. Nothing here
// dispatches into the runtime, forces a click, removes a shield or changes zoom to make a step pass.

import type { CDPSession, Frame, Page } from "playwright-core";
import type { Located, TargetSpec } from "../../canvas/src/shell/testHook.ts";
import { PENCIL_COLORS } from "../../canvas/src/engine/index.ts";
import type { Destination, Mods, PersonAction, Point, Target } from "./script.ts";

export interface PersonView {
  readonly page: Page;
  readonly screenId: () => string | null;
  /** Handles to IDs, and which kind of record each names. */
  readonly resolve: (name: string) => { readonly id: string; readonly kind: RefKind };
  pointer: { down: boolean; x: number; y: number; button: "left" | "middle" };
  /** `fixture:NAME` or a path → an absolute file path on disk. */
  readonly file: (spec: string) => string;
  cdp: CDPSession | null;
}

const MOD = "ControlOrMeta";
/** A thread target is its pin (@T) or panel row (@T.row); a comment target is its Delete button in the open card. */
export type RefKind = "item" | "stroke" | "thread" | "comment";

export function targetText(t: Target): string {
  switch (t.kind) {
    case "ref": return `@${t.ref.name}${t.part !== "surface" ? "." + t.part : ""}${t.offset ? `+${t.offset.x},${t.offset.y}` : ""}`;
    case "background": return t.at ? `bg:${t.at.x},${t.at.y}` : "bg";
    case "world": return `w:${t.at.x},${t.at.y}`;
    case "ui": return `ui:"${t.label}"`;
  }
}

function spec(v: PersonView, t: Target): TargetSpec {
  if (t.kind !== "ref") return t;
  const r = v.resolve(t.ref.name);
  switch (r.kind) {
    case "stroke": return { kind: "stroke", id: r.id };
    case "thread": return { kind: "thread", id: r.id, part: t.part === "row" ? "row" : "pin" };
    case "comment": return { kind: "comment", id: r.id };
    case "item": return { kind: "item", id: r.id, part: t.part === "row" ? "surface" : t.part, offset: t.offset };
  }
}

export async function locate(v: PersonView, t: Target, wait = 1500): Promise<Point> {
  const s = spec(v, t);
  const deadline = Date.now() + wait;
  let l: Located;
  for (;;) {
    l = await v.page.evaluate((x) => (window as unknown as { __screensTest?: { locate(t: unknown): Located } }).__screensTest?.locate(x) ?? null, s as never) as Located;
    if (!l) throw new Error("no canvas in this view (open a Screen first)");
    if (!l.found && t.kind === "ui") {
      const labelled = v.page.getByLabel(t.label, { exact: true });
      if (await labelled.count() === 1) l = await labelled.evaluate((el) => {
        const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        const onScreen = r.width > 0 && r.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight;
        const hit = onScreen ? document.elementFromPoint(x, y) : null;
        const ok = hit === el || !!(hit && el.contains(hit));
        return { x, y, found: true, onScreen, ok, coveredBy: ok ? null : hit?.tagName.toLowerCase() ?? null };
      });
    }
    if (l.ok || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!l.found) throw new Error(`${targetText(t)} is not in the canvas`);
  if (!l.onScreen) throw new Error(`${targetText(t)} is off screen`);
  if (!l.ok) throw new Error(`${targetText(t)} is covered by ${l.coveredBy} at ${Math.round(l.x)},${Math.round(l.y)}`);
  return { x: l.x, y: l.y };
}

async function withMods<T>(v: PersonView, m: Mods, fn: () => Promise<T>): Promise<T> {
  const keys = [m.shift && "Shift", m.mod && MOD, m.alt && "Alt"].filter(Boolean) as string[];
  for (const k of keys) await v.page.keyboard.down(k);
  try { return await fn(); } finally { for (const k of keys.reverse()) await v.page.keyboard.up(k); }
}

async function destination(v: PersonView, d: Destination, from: Point): Promise<Point> {
  return d.kind === "by" ? { x: from.x + d.delta.x, y: from.y + d.delta.y } : locate(v, d.target);
}

const keyName = (combo: string) => combo.split("+").map((k) => (k === "Mod" ? MOD : k.length === 1 && /[0-9]/.test(k) ? k : k)).join("+");

async function key(v: PersonView, combo: string) {
  if (combo === "Space-down") return v.page.keyboard.down("Space");
  if (combo === "Space-up") return v.page.keyboard.up("Space");
  return v.page.keyboard.press(keyName(combo));
}

async function ui(v: PersonView, label: string) {
  const p = await locate(v, { kind: "ui", label });
  await v.page.mouse.click(p.x, p.y);
}

async function probeView(v: PersonView): Promise<Record<string, unknown>> {
  return v.page.evaluate(() => ((window as unknown as { __screensTest: { probe(r: string[]): { view: Record<string, unknown> } } }).__screensTest.probe(["view"]).view));
}

async function snapshotFrame(v: PersonView, itemId: string): Promise<Frame> {
  const sid = v.screenId();
  const host = v.page.frames().find((f) => f.url().includes(`/host/${sid}/${itemId}/`));
  if (!host) throw new Error("the snapshot is not live (no frame mounted); select it or zoom in first");
  const child = host.childFrames()[0];
  if (!child) throw new Error("the snapshot frame has not built its page yet");
  return child;
}

/** Pen and pressure need CDP: Playwright's mouse has no pointerType. */
async function penStroke(v: PersonView, points: readonly Point[], pressure: number) {
  v.cdp ??= await v.page.context().newCDPSession(v.page);
  const send = (type: "mousePressed" | "mouseMoved" | "mouseReleased", p: Point) =>
    v.cdp!.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "pen", force: type === "mouseReleased" ? 0 : pressure });
  await send("mousePressed", points[0]!);
  for (const p of points.slice(1)) await send("mouseMoved", p);
  await send("mouseReleased", points.at(-1)!);
}

/** A real drag carrying files, through CDP: the browser builds the DataTransfer and fires dragenter, dragover and drop.
 *  Like a drag from the desktop, it enters at the window's left edge and moves to the target. */
async function dropFiles(v: PersonView, files: readonly string[], at: Point) {
  v.cdp ??= await v.page.context().newCDPSession(v.page);
  const data = { items: [], files: [...files], dragOperationsMask: 1 };
  const edge = { x: 1, y: at.y };
  const steps: ["dragEnter" | "dragOver" | "drop", Point][] = [["dragEnter", edge], ["dragOver", edge], ["dragOver", { x: (edge.x + at.x) / 2, y: at.y }], ["dragOver", at], ["drop", at]];
  for (const [type, p] of steps) await v.cdp.send("Input.dispatchDragEvent", { type, x: p.x, y: p.y, data });
}

const IMAGE_TYPES: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** Puts the file on the page's clipboard as an image, then presses Mod+v like a person. */
async function pasteFile(v: PersonView, file: string) {
  const fs = await import("node:fs");
  const type = IMAGE_TYPES[file.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
  await v.page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(v.page.url()).origin });
  await v.page.evaluate(async ({ b64, type }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({ [type]: new Blob([bytes], { type }) })]);
  }, { b64: fs.readFileSync(file).toString("base64"), type });
  await v.page.keyboard.press(`${MOD}+v`);
}

/** Runs one person action. Returns extra output text, or data for `inside … text`. */
export async function act(v: PersonView, a: PersonAction): Promise<{ readonly note?: string; readonly data?: unknown }> {
  const m = v.page.mouse;
  switch (a.verb) {
    case "click": {
      const p = await locate(v, a.target);
      await withMods(v, a.mods, () => (a.double ? m.dblclick(p.x, p.y) : m.click(p.x, p.y)));
      return {};
    }
    case "drag": {
      const p = await locate(v, a.from);
      const to = await destination(v, a.dest, p);
      if (a.space) await v.page.keyboard.down("Space");
      try {
        await withMods(v, a.mods, async () => {
          await m.move(p.x, p.y); await m.down({ button: a.button });
          await m.move(to.x, to.y, { steps: a.steps }); await m.up({ button: a.button });
        });
      } finally { if (a.space) await v.page.keyboard.up("Space"); }
      return {};
    }
    case "press": {
      const p = await locate(v, a.target);
      await withMods(v, a.mods, async () => { await m.move(p.x, p.y); await m.down({ button: a.button }); });
      v.pointer = { down: true, x: p.x, y: p.y, button: a.button };
      return {};
    }
    case "move": {
      const to = await destination(v, a.dest, v.pointer);
      await m.move(to.x, to.y, { steps: a.steps });
      v.pointer = { ...v.pointer, x: to.x, y: to.y };
      return {};
    }
    case "release": await m.up({ button: v.pointer.button }); v.pointer = { ...v.pointer, down: false }; return {};
    case "cancel": await v.page.keyboard.press("Escape"); if (v.pointer.down) { await m.up({ button: v.pointer.button }); v.pointer = { ...v.pointer, down: false }; } return {};
    case "draw": {
      const p = await locate(v, a.from);
      const pts: Point[] = [p];
      for (const d of a.path) { const last = pts.at(-1)!; pts.push({ x: last.x + d.x, y: last.y + d.y }); }
      if (a.pen || a.pressure !== null) { await penStroke(v, pts.flatMap((q, i) => (i === 0 ? [q] : interpolate(pts[i - 1]!, q, 6))), a.pressure ?? 0.5); return {}; }
      await m.move(p.x, p.y); await m.down();
      for (const q of pts.slice(1)) await m.move(q.x, q.y, { steps: 6 });
      await m.up();
      return {};
    }
    case "wheel": {
      const p = a.at ? await locate(v, a.at) : await v.page.evaluate(() => { const r = document.querySelector(".screens-stage")!.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await m.move(p.x, p.y);
      const hold = a.zoom === "cmd" ? "Meta" : a.zoom === "pinch" ? "Control" : null;
      if (hold) await v.page.keyboard.down(hold);
      try { await m.wheel(a.delta.x, a.delta.y); } finally { if (hold) await v.page.keyboard.up(hold); }
      return {};
    }
    case "key": for (const c of a.combos) await key(v, c); return {};
    case "type": await v.page.keyboard.type(a.text); return {};
    case "tool": await ui(v, a.tool[0]!.toUpperCase() + a.tool.slice(1)); return {};
    case "pencil": {
      if (a.what === "size") { await ui(v, a.value); return {}; }
      const c = PENCIL_COLORS.find((x) => x.name.toLowerCase() === a.value.toLowerCase() || x.hex === a.value.toLowerCase());
      if (!c) throw new Error(`no pencil color ${a.value} (${PENCIL_COLORS.map((x) => x.name.toLowerCase()).join(" ")})`);
      await ui(v, c.name); return {};
    }
    case "zoom": if (a.how === "100") await key(v, "Mod+0"); else await ui(v, a.how === "in" ? "Zoom in" : "Zoom out"); return {};
    case "fit": await ui(v, "Fit all"); return {};
    case "focus": {
      const p = await locate(v, a.target);
      await m.click(p.x, p.y);
      if (a.target.kind !== "ref") throw new Error("focus needs an item");
      const f = await locate(v, { ...a.target, part: "focus", offset: null });
      await m.click(f.x, f.y);
      return {};
    }
    case "exit-focus": await ui(v, "Exit focus"); return {};
    case "undo": await key(v, "Mod+z"); return {};
    case "redo": await key(v, "Mod+Shift+z"); return {};
    case "delete": await key(v, "Backspace"); return {};
    case "theme": if ((await probeView(v)).theme !== a.theme) await ui(v, "Theme"); return {};
    case "invert-scroll": if ((await probeView(v)).invertScroll !== a.on) await ui(v, "Invert scroll"); return {};
    case "edit-title": {
      if (a.target.kind !== "ref") throw new Error("edit-title needs an item");
      const p = await locate(v, { ...a.target, part: "title", offset: null });
      await m.dblclick(p.x, p.y);
      await v.page.waitForSelector(".screens-title-input", { timeout: 2000 });
      await v.page.keyboard.press(`${MOD}+a`); await v.page.keyboard.type(a.text); await v.page.keyboard.press("Enter");
      return {};
    }
    case "rename-screen": {
      const title = await v.page.evaluate(() => document.querySelector(".screen-name")?.textContent?.trim() ?? "");
      await ui(v, title);
      await v.page.waitForSelector(".screens-title-input", { timeout: 2000 });
      await v.page.keyboard.press(`${MOD}+a`); await v.page.keyboard.type(a.text); await v.page.keyboard.press("Enter");
      return {};
    }
    case "toast": {
      if (a.button === "retry") await ui(v, "Retry");
      else {
        await ui(v, "Discard unsaved change");
        await ui(v, "Discard unsaved change");
      }
      return {};
    }
    case "drop": await dropFiles(v, a.files.map(v.file), await locate(v, a.at)); return { note: `${a.files.length} file(s)` };
    case "paste": await pasteFile(v, v.file(a.file)); return {};
    case "inside": {
      const r = v.resolve(a.ref.name);
      const f = await snapshotFrame(v, r.id);
      if (a.act.kind === "click") { await f.locator(a.act.selector).click({ timeout: 3000 }); return {}; }
      if (a.act.kind === "type") { await f.locator(a.act.selector).pressSequentially(a.act.text, { timeout: 3000 }); return {}; }
      const text = await f.locator(a.act.selector ?? "body").innerText({ timeout: 3000 });
      return { data: text, note: JSON.stringify(text.length > 200 ? text.slice(0, 200) + "…" : text) };
    }
  }
}

function interpolate(a: Point, b: Point, n: number): Point[] {
  return Array.from({ length: n }, (_, i) => ({ x: a.x + ((b.x - a.x) * (i + 1)) / n, y: a.y + ((b.y - a.y) * (i + 1)) / n }));
}
