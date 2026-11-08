// Opt-in production benchmark. All fixtures commit through Service; no test hook or product policy changes.
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { contentVersionOf, type Service } from "@screens/client";
import { pieceTree, type PieceNode, type Operation } from "@screens/core";
import { LIVE_POLICY } from "../engine/scheduler.ts";
import { ScreenCanvas } from "./ScreenCanvas.tsx";
import type { CanvasRuntime } from "./runtime.ts";

const TYPES = ["static", "css-animated", "js-animated", "media", "scrollable", "failing", "heavy"];
const VERSION = 4, FIXTURE_VERSION = 3;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : null; };
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, .5), p95: pct(xs, .95), p99: pct(xs, .99), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null });
function frame() {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => { cancelAnimationFrame(id); reject(new Error("blocked: rAF stalled for 3000 ms")); }, 3000);
    const id = requestAnimationFrame((t) => { clearTimeout(timer); resolve(t); });
  });
}
const heap = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;

// Shared scripted button/scroll exercise acknowledges actual child DOM changes through the existing rect bridge.
// It does not bypass opaque-origin isolation or extend the production bridge protocol.
function fixture(content: string, i: number) {
  const rows = (n: number) => `<ul>${"<li>Row</li>".repeat(n)}</ul>`;
  let body = rows(20), script = "", style = "";
  if (content === "css-animated") {
    body = '<div class="animated"></div>'; style = '.animated{width:120px;height:120px;background:#2a74f5;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}';
  } else if (content === "js-animated") {
    body = '<canvas width="320" height="160"></canvas>';
    script = 'const c=document.querySelector("canvas"),ctx=c.getContext("2d");function draw(t){ctx.clearRect(0,0,320,160);ctx.fillStyle="#2a74f5";ctx.fillRect((t/8)%280,40,40,40);requestAnimationFrame(draw)}requestAnimationFrame(draw);';
  } else if (content === "media") {
    // Self-contained animated GIF: no network, decoder and changing image frames.
    body = '<img alt="Animated media" width="320" height="160" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICTAEAOw==">';
  } else if (content === "scrollable") body = `<div id="scroll" style="height:120px;overflow:auto">${rows(150)}</div>`;
  else if (content === "failing") body = '<img id="broken" alt="Expected broken image" src="data:image/png;base64,AAAA">';
  else if (content === "heavy") {
    body = `<div id="heavy">${'<div class="card"><span>Heavy row</span></div>'.repeat(1200)}</div>`;
    style = '.card{display:inline-block;padding:4px;box-shadow:0 1px 3px #999}.card:nth-child(2n){background:#eee}';
    script = 'const cards=[...document.querySelectorAll(".card")];let tick=0;function heavy(){tick++;for(let j=0;j<cards.length;j++){cards[j].style.paddingLeft=(4+(tick+j)%4)+"px"}document.body.offsetHeight;requestAnimationFrame(heavy)}requestAnimationFrame(heavy);';
  }
  return `<!doctype html><html><head><style>body{margin:0;font:16px system-ui;padding:12px}li{padding:8px 0;border-bottom:1px solid #ddd}button{position:relative;z-index:1}${style}</style></head><body><h1>Item ${i}</h1><button id="exercise">Interact</button><output id="clicks">0</output>${body}<script>
let clicks=0;document.querySelector("#exercise").onclick=()=>{document.querySelector("#clicks").textContent=String(++clicks)};
addEventListener("message",e=>{if(e.source!==parent||e.data?.kind!=="highlight"||e.data.pid!=="bench-exercise")return;
document.querySelector("#exercise").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,clientX:20,clientY:70}));document.querySelector("#exercise").click();const s=document.querySelector("#scroll");if(s)s.scrollTop=100;
const broken=document.querySelector("#broken");const media=document.querySelector("img:not(#broken)");const animated=document.querySelector(".animated");const ok=(!s||Math.abs(s.scrollTop-100)<1)&&(!broken||(broken.complete&&broken.naturalWidth===0))&&(!media||(media.complete&&media.naturalWidth>0))&&(!animated||document.getAnimations().some(a=>a.playState==="running"));
parent.postMessage({kind:"rect",pid:"bench-ack",w:Number(document.querySelector("#clicks").textContent),h:ok?1:0},"*");});
${script}</script></body></html>`;
}

async function runOne(svc: Service, root: Root, n: number, content: string, reps: number, q: URLSearchParams) {
  const errors: string[] = [], runs: Record<string, unknown>[] = [];
  const profile = q.get("profile") === "1", idle = q.get("idle") === "1";
  const W = idle ? 240 : 390, H = idle ? 160 : 844, GAP = idle ? 20 : 80;
  const fixtureVersion = content === "scrollable" ? 4 : FIXTURE_VERSION;
  const title = `bench-v${fixtureVersion}-${idle ? "idle-" : ""}${content}-${n}`;
  const existing = (await svc.listScreens()).find((s) => s.title === title && s.itemCount === n);
  const screenId = existing?.id ?? (await svc.createScreen(title)).id;
  if (!existing) {
    const hashes = await Promise.all(Array.from({ length: n }, (_, i) => svc.upload(new TextEncoder().encode(fixture(content, i)))));
    const cols = Math.ceil(Math.sqrt(n));
    const ops: Operation[] = await Promise.all(hashes.map(async (hash, i) => {
      const assetManifest = { "index.html": { hash, mediaType: "text/html" } };
      return { type: "addItem", item: { kind: "html-snapshot", id: `b${i}`, title: `Item ${i}`, x: i % cols * (W + GAP), y: Math.floor(i / cols) * (H + GAP), width: W, height: H, entry: "index.html", contentVersion: await contentVersionOf("index.html", assetManifest), assetManifest, sourceReferenceIds: [] } } as const;
    }));
    const outcome = await svc.run(screenId, { type: "batch", ops });
    if (outcome.status !== "committed") throw new Error(`fixture: ${JSON.stringify(outcome)}`);
  }
  // Focus opens the Layers panel, which stamps legacy objects once. Do that setup before any timed repetition.
  const targetId = `b${n - 1}`;
  const target = (await svc.read(screenId)).items[targetId];
  if (!target || target.kind !== "html-snapshot") throw new Error("missing interaction target");
  const source = new TextDecoder().decode(await svc.readContent(target.assetManifest[target.entry]!.hash));
  const missingIds = (node: PieceNode): boolean => node.pid.startsWith("?") || node.children.some(missingIds);
  if (missingIds(pieceTree(source))) {
    const prepared = await svc.run(screenId, { type: "editObject", itemId: targetId, edits: [] });
    if (prepared.status !== "committed") throw new Error(`fixture stamping: ${JSON.stringify(prepared)}`);
  }
  const client = await svc.openScreen(screenId);
  const versions = new Map(Object.values(client.get().committed!.items).map((item) => [item.id, item.kind === "html-snapshot" ? item.contentVersion : ""]));
  let rt!: CanvasRuntime;
  root.render(createElement(ScreenCanvas, { key: title, client, viewId: svc.sessionId, onRuntime: (r: CanvasRuntime) => { rt = r; } }));
  const from = performance.now();
  while (!rt?.stage) { if (performance.now() - from > 10_000) throw new Error("canvas did not mount"); await wait(20); }
  const camera: number[] = [], gestures: number[] = [], commits: number[] = [], dispatch: number[] = [];
  const loaf: { startTime: number; duration: number; blockingDuration: number }[] = [];
  const observer = PerformanceObserver.supportedEntryTypes.includes("long-animation-frame") ? new PerformanceObserver((list) => {
    for (const e of list.getEntries()) loaf.push({ startTime: e.startTime, duration: e.duration, blockingDuration: Number((e as PerformanceEntry & { blockingDuration: number }).blockingDuration) });
  }) : null;
  observer?.observe({ type: "long-animation-frame", buffered: false });
  let maxLive = 0, capViolations = 0, hidden = document.visibilityState !== "visible";
  const cap = LIVE_POLICY[rt.view.pointer].cap;
  const visibility = () => { if (document.visibilityState !== "visible") hidden = true; };
  document.addEventListener("visibilitychange", visibility);
  const sampleLive = () => {
    const live = rt.frames.live.size;
    maxLive = Math.max(maxLive, live);
    const forced = rt.view.interacting !== null || rt.view.focus.mode === "focused";
    if (live > cap + Number(forced)) capViolations++;
  };
  const sampleTimer = setInterval(sampleLive, 25);
  const command = (kind: "fit-all" | "zoom-100" | "exit-focus") => rt.dispatch({ type: "command", command: { kind } });
  const clear = () => { for (let k = 0; k < 4; k++) rt.dispatch({ type: "key-down", key: "Escape", code: "Escape", mod: false, shift: false, editable: false, control: false }); };
  const counts = () => { const ids = [...rt.frames.live].sort(); return { ids, live: ids.length, ready: ids.filter((id) => rt.frames.load.get(id) === "ready").length }; };
  const settle = async () => {
    const t0 = performance.now(); let seen = counts(), stable = t0, settled = false;
    while (performance.now() - t0 < 10_000) {
      await wait(50); const now = counts();
      if (now.ids.join() !== seen.ids.join() || now.ready !== seen.ready) { seen = now; stable = performance.now(); }
      if (now.live > 0 && now.live === now.ready && !rt.timersPending() && performance.now() - stable >= 500) { settled = true; break; }
    }
    return { ...seen, settled, waitedMs: Math.round(performance.now() - t0) };
  };
  const pending = async () => {
    const t = performance.now();
    while (client.get().pending.size && performance.now() - t < 5000) await wait(2);
    if (client.get().pending.size) throw new Error("commit/undo timed out");
  };
  try {
    // Doctor: 30 rAFs must arrive while visible, even if the host claims visibility incorrectly.
    const doctorFrom = performance.now(); for (let f = 0; f < 30; f++) await frame();
    if (performance.now() - doctorFrom > 3000) throw new Error("blocked: 30 rAFs took more than 3000 ms");
    for (let rep = 0; rep < reps; rep++) {
      clear(); command("fit-all"); if (!idle) command("zoom-100");
      const readiness = await settle();
      const first = runs[0]?.readiness as { live: number } | undefined;
      if (!readiness.settled || (first && readiness.live < first.live)) throw new Error(`readiness rep ${rep}: ${JSON.stringify(readiness)}`);
      if (idle && readiness.live !== 16) throw new Error(`idle requires 16 ready live frames, got ${readiness.live}`);
      const frameTimes: number[] = [], moves: number[] = [], dispatchTimes: number[] = [];
      const tag = `bench:${content}:${n}:${rep}`;
      const workPhase = async (phase: "start" | "end", frames: number) => {
        const response = await fetch(new URL("/work-phase", q.get("collector")!), {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({phase,content,items:n,rep,frames,...counts()})});
        if (!response.ok) throw new Error(`OS work trace ${phase}: ${response.status}`);
      };
      if (q.get("workCpu") === "1") await workPhase("start", 0);
      const cameraStart = performance.now(); performance.mark(`${tag}:start`);
      // Exposed status lets an OS-level sampler delimit still/moving windows without driving this page.
      const status = (phase: string) => { (window as unknown as { __benchStatus: unknown }).__benchStatus = { content, items: n, rep, phase, live: rt.frames.live.size }; document.body.dataset.benchPhase = `${content}:${n}:${rep}:${phase}`; if (idle && q.get("collector")) void fetch(new URL("/phase", q.get("collector")!), {method:"POST", body:JSON.stringify({content,items:n,rep,phase,live:rt.frames.live.size})}); };
      let last = await frame(); const boundaries = [performance.now()];
      const frames = idle ? 180 : 90;
      if (idle) { status("still"); await wait(3000); status("moving"); last = await frame(); }
      else status("camera");
      for (let f = 0; f < frames; f++) {
        const t0 = performance.now();
        if (f < frames * 2 / 3 || idle) rt.dispatch({ type: "wheel", dx: idle ? Math.sin(f / 10) * 2 : 12, dy: idle ? 0 : 6, zoom: "none", client: { x: 400, y: 300 } });
        else rt.dispatch({ type: "wheel", dx: 0, dy: f < frames * 5 / 6 ? 8 : -8, zoom: "cmd", client: { x: rt.view.viewport.width / 2, y: rt.view.viewport.height / 2 } });
        dispatchTimes.push(performance.now() - t0);
        const t = await frame(); frameTimes.push(t - last); boundaries.push(performance.now()); last = t; sampleLive();
        if (idle && rt.frames.live.size !== 16) throw new Error("idle live count changed during motion");
      }
      performance.mark(`${tag}:end`); const cameraEnd = performance.now(); if (q.get("workCpu") === "1") await workPhase("end", frameTimes.length); status("settling");
      let commitMs: number | null = null, interaction = false, focused = false;
      if (!idle) {
        clear(); command("fit-all"); await wait(200);
        const item = Object.values(client.get().committed!.items).at(-1);
        if (!item || !rt.stage) throw new Error("no item to drag");
        const original = { x: item.x, y: item.y }, revision = client.get().committed!.revision;
        const c = rt.view.camera, rect = rt.stage.getBoundingClientRect();
        const sx = rect.left + c.x + (item.x + 20) * c.z, sy = rect.top + c.y + (item.y + 20) * c.z;
        const shield = document.querySelector(`[data-item="${item.id}"] .frame-shield`);
        if (!shield) throw new Error("no drag shield");
        const ev = (type: string, x: number, y: number, target: EventTarget) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, pointerType: "mouse" }));
        ev("pointerdown", sx, sy, shield);
        for (let s = 1; s <= 20; s++) { const t = performance.now(); ev("pointermove", sx + s * 3, sy + s * 1.5, rt.stage); moves.push((await frame()) - t); }
        const t0 = performance.now(); ev("pointerup", sx + 60, sy + 30, rt.stage);
        if (!client.get().pending.size) throw new Error("drag did not submit");
        await pending(); commitMs = performance.now() - t0;
        if (client.get().committed!.revision <= revision || !Object.values(client.get().committed!.items).some((i) => i.id === item.id && (i.x !== original.x || i.y !== original.y))) throw new Error("drag did not commit a changed position");
        client.undo(); await pending();
        const restored = Object.values(client.get().committed!.items).find((i) => i.id === item.id);
        if (restored?.x !== original.x || restored.y !== original.y) throw new Error("undo did not restore fixture");
        rt.dispatch({ type: "command", command: { kind: "focus", itemId: item.id } });
        await wait(400); const focusReady = await settle(); focused = rt.view.focus.mode === "focused" && rt.frames.load.get(item.id) === "ready";
        if (!focused || !focusReady.settled) throw new Error("focus never reached ready");
        let ack: { w?: number; h?: number } | null = null;
        const off = rt.onPiece((e) => { if (e.itemId === item.id && e.kind === "rect" && e.pid === "bench-ack") ack = e; });
        rt.highlight(item.id, "bench-exercise");
        const t = performance.now(); while (!ack && performance.now() - t < 3000) await wait(10); off();
        const got = ack as { w?: number; h?: number } | null;
        interaction = !!got && (got.w ?? 0) > 0 && got.h === 1 && rt.view.interacting === item.id;
        if (!interaction) throw new Error("child button/scroll/broken-image exercise did not acknowledge");
        command("exit-focus"); await wait(300);
      }
      if (Object.values(client.get().committed!.items).some((item) => item.kind !== "html-snapshot" || versions.get(item.id) !== item.contentVersion)) throw new Error("fixture content changed during a timed repetition");
      await wait(50); // Deliver the PerformanceObserver's completed camera entries.
      const long = loaf.filter((e) => e.startTime >= cameraStart && e.startTime < cameraEnd);
      const mem = heap();
      runs.push({ rep, readiness, cameraFrameTimeMs: { ...stats(frameTimes), over50: frameTimes.filter((x) => x > 50).length }, gestureLatencyMs: stats(moves), commitLatencyMs: commitMs, jsHeapMB: mem === null ? null : mem / 1e6, focused, interaction,
        cameraWindow: { startMs: cameraStart, endMs: cameraEnd, traceTag: tag, frames: frameTimes.length, boundariesMs: boundaries }, dispatchWorkMs: stats(dispatchTimes),
        longAnimationFrame: observer ? { n: long.length, durationMs: stats(long.map((e) => e.duration)), blockingMsPerCameraFrame: long.reduce((s, e) => s + e.blockingDuration, 0) / frameTimes.length } : null });
      camera.push(...frameTimes); gestures.push(...moves); dispatch.push(...dispatchTimes); if (commitMs !== null) commits.push(commitMs);
    }
  } catch (e) { errors.push(String(e)); }
  finally { clearInterval(sampleTimer); document.removeEventListener("visibilitychange", visibility); observer?.disconnect(); }
  if (hidden) errors.push("page was hidden during run");
  if (capViolations) errors.push(`${capViolations} live-cap violations`);
  if (runs.length !== reps) errors.push(`completed ${runs.length}/${reps} repetitions`);
  const result = { harnessVersion: VERSION, fixtureVersion, fixtureContentStable: true, label: q.get("label") ?? "", items: n, content, reps, profile, idle, workCpuTrace:q.get("workCpu") === "1", userAgent: navigator.userAgent, devicePixelRatio, viewport: rt.view.viewport, pointer: rt.view.pointer,
    hidden, errorCount: errors.length, errors, work: { cameraFrames: camera.length, dragMoves: gestures.length, commits: commits.length, focuses: runs.filter((r) => r.focused).length, interactions: runs.filter((r) => r.interaction).length, readiness: runs.map((r) => r.readiness) },
    cameraFrameTimeMs: { ...stats(camera), over50: camera.filter((x) => x > 50).length }, gestureLatencyMs: stats(gestures), commitLatencyMs: stats(commits), liveFrames: { cap, forcedAllowance: 1, max: maxLive, violations: capViolations, settled: runs.map((r) => (r.readiness as { live: number }).live) },
    jsHeapMB: stats(runs.map((r) => r.jsHeapMB as number).filter((x) => x !== null)), dispatchWorkMs: stats(dispatch), runs, finishedAt: new Date().toISOString() };
  root.render(null); await wait(50); client.close(); return result;
}

export async function runBench(svc: Service, root: Root) {
  const q = new URLSearchParams(location.search);
  const items = (q.get("items") ?? "1,16,50,200,500").split(",").map(Number);
  const contents = (q.get("content") ?? TYPES.join(",")).split(",");
  const reps = Number(q.get("reps") ?? 5);
  const pre = document.createElement("pre"); pre.id = "bench-result"; pre.className = "panel";
  pre.style.cssText = "position:fixed;left:8px;bottom:8px;z-index:99;max-height:40vh;overflow:auto;padding:8px;font:11px ui-monospace,monospace";
  document.body.append(pre);
  const results = [];
  try {
    if (!items.every((n) => Number.isInteger(n) && n > 0 && n <= 500) || !contents.every((c) => TYPES.includes(c)) || !Number.isInteger(reps) || reps < 1) throw new Error("invalid workload");
    matrix: for (const content of contents) for (const n of items) {
      pre.textContent = `Running ${content} / ${n} items / ${reps} reps`;
      const result = await runOne(svc, root, n, content, reps, q); results.push(result);
      (window as unknown as { __benchResult: unknown }).__benchResult = result;
      const collector = q.get("collector");
      if (collector) {
        const url = new URL(collector);
        if (url.hostname !== "127.0.0.1") throw new Error("collector must be loopback");
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(result) });
        if (!response.ok) throw new Error(`collector rejected result: ${response.status}`);
      }
      if (result.errorCount) break matrix;
    }
  } catch (e) { results.push({ errorCount: 1, errors: [String(e)] }); }
  (window as unknown as { __benchResults: unknown }).__benchResults = results;
  pre.textContent = `${results.length} cases, ${results.reduce((s, r) => s + r.errorCount, 0)} errors\n` + results.map((r) => "items" in r ? `${r.content} / ${r.items}: ${r.work.commits} commits, ${r.work.interactions} interactions, ${r.errorCount} errors` : JSON.stringify(r)).join("\n");
  document.title = results.some((r) => r.errorCount) ? "bench failed" : "bench done";
}
