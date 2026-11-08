#!/usr/bin/env node
// Frame-probe harness for verify-screens and screens-performance.
//
// Serves a canvas origin and a separate frame origin on 127.0.0.1, and proves the
// snapshot frame path: an unsandboxed host page on
// the frame origin, sent with HOST_CSP, holding a sandbox="allow-scripts" srcdoc child
// whose assets are inlined as data: URLs. The canvas page records isolation checks
// and the time from mounting the host iframe to the child's "ready" message, and
// posts the result back to the server, which writes it to the run directory.
//
// Usage:
//   frame-probe.mjs serve  --run-dir DIR [--canvas-port N] [--frame-port N]
//   frame-probe.mjs doctor --run-dir DIR
//   frame-probe.mjs stop   --run-dir DIR
//
// Zero dependencies. Node 22+.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const [cmd, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, "")] = rest[i + 1];
const runDir = opts["run-dir"] && path.resolve(opts["run-dir"]);
const fail = (msg) => { console.error(`frame-probe: ${msg}`); process.exit(1); };
if (!["serve", "doctor", "stop"].includes(cmd)) fail("usage: frame-probe.mjs serve|doctor|stop --run-dir DIR");
if (!runDir) fail("--run-dir is required");
const runFile = path.join(runDir, "run.json");

// ── Policy under test (keep in step with HOST_CSP in packages/frames/src/index.ts) ──
const hostCsp = (canvasOrigin) =>
  `default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; ` +
  `font-src data:; media-src data:; worker-src 'none'; frame-ancestors ${canvasOrigin}`;

// ── Payload: an incompressible PNG of roughly `bytes` bytes, cached per size ──
const pngCache = new Map();
function png(bytes) {
  if (pngCache.has(bytes)) return pngCache.get(bytes);
  const side = Math.max(1, Math.ceil(Math.sqrt(bytes / 3)));
  const raw = Buffer.alloc(side * (side * 3 + 1));
  crypto.randomFillSync(raw);
  for (let y = 0; y < side; y++) raw[y * (side * 3 + 1)] = 0; // filter byte per row
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 2;
  const out = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 0 })), chunk("IEND", Buffer.alloc(0)),
  ]);
  pngCache.set(bytes, out);
  return out;
}

const dataJs = (src) => `data:text/javascript;base64,${Buffer.from(src).toString("base64")}`;
const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// The snapshot document. Runs with an opaque origin and reports what it could and could not do.
function childDoc(frameOrigin, bytes) {
  const img = bytes > 0 ? `data:image/png;base64,${png(bytes).toString("base64")}` : "";
  const imports = {
    "screens:/b.js": dataJs("export const b = 'b';"),
    "screens:/a.js": dataJs("import { b } from 'screens:/b.js'; export const a = 'a' + b;"),
    "screens:/lazy.js": dataJs("export const lazy = 'lazy';"),
  };
  return `<!doctype html><script type="importmap">${JSON.stringify({ imports })}</script>
<body style="margin:0;font:12px system-ui"><p id="s">running</p>
<script type="module">
import { a } from "screens:/a.js";
const r = { origin: self.origin, staticModule: a === "ab" };
try { localStorage.setItem("x", "1"); r.storage = "allowed"; } catch { r.storage = "blocked"; }
// A CSP block arrives as an error event, not a throw, so wait for the worker to actually run.
r.worker = await new Promise((done) => {
  try {
    const w = new Worker("data:text/javascript,postMessage(1)");
    w.onmessage = () => done("allowed"); w.onerror = () => done("blocked");
    setTimeout(() => done("no-answer"), 3000);
  } catch { done("blocked"); }
});
r.fetchFrameOrigin = await fetch(${JSON.stringify(frameOrigin + "/health")}).then(() => "allowed", () => "blocked");
r.fetchExternal = await fetch("https://example.com/").then(() => "allowed", () => "blocked");
r.dynamicModule = await import("screens:/lazy.js").then((m) => m.lazy === "lazy", () => false);
if (${JSON.stringify(img)}) {
  const i = new Image(); i.src = ${JSON.stringify(img)};
  r.image = await i.decode().then(() => i.naturalWidth > 0, () => false);
} else r.image = null;
document.getElementById("s").textContent = JSON.stringify(r);
parent.postMessage({ kind: "ready", checks: r }, "*");
</script></body>`;
}

// Host page: relays only well-formed messages from its own child to the canvas.
function hostDoc(canvasOrigin, frameOrigin, bytes, gen) {
  const child = childDoc(frameOrigin, bytes);
  return `<!doctype html><body style="margin:0">
<iframe id="c" sandbox="allow-scripts" style="border:0;width:100%;height:100%" srcdoc="${escAttr(child)}"></iframe>
<script>
const child = document.getElementById("c");
addEventListener("message", (e) => {
  if (e.source !== child.contentWindow || e.origin !== "null") return;
  if (!e.data || e.data.kind !== "ready") return;
  parent.postMessage({ kind: "ready", gen: ${JSON.stringify(gen)}, checks: e.data.checks }, ${JSON.stringify(canvasOrigin)});
});
</script></body>`;
}

// Canvas page: mounts host iframes one at a time, measures mount -> ready, posts results home.
function canvasDoc(frameOrigin, instance) {
  return `<!doctype html><title>frame-probe</title><body style="font:13px system-ui;margin:16px">
<h1 style="font-size:15px">frame-probe</h1><pre id="out">running</pre><div id="slot"></div>
<script>
const q = new URLSearchParams(location.search);
const sizes = (q.get("sizes") || "0").split(",").map(Number);
const reps = Number(q.get("reps") || 1);
const label = q.get("label") || "";
const out = document.getElementById("out");
function mountOnce(bytes, gen) {
  return new Promise((resolve) => {
    const f = document.createElement("iframe");
    f.style.cssText = "width:480px;height:120px;border:1px solid #ccc";
    const t0 = performance.now();
    const timer = setTimeout(() => done({ ok: false, error: "timeout" }), 60000);
    function done(r) { clearTimeout(timer); removeEventListener("message", onMsg); f.remove(); resolve(r); }
    function onMsg(e) {
      if (e.origin !== ${JSON.stringify(frameOrigin)} || e.source !== f.contentWindow) return;
      if (!e.data || e.data.kind !== "ready" || e.data.gen !== gen) return;
      done({ ok: true, ms: performance.now() - t0, checks: e.data.checks });
    }
    addEventListener("message", onMsg);
    f.src = ${JSON.stringify(frameOrigin)} + "/host?bytes=" + bytes + "&gen=" + gen;
    document.getElementById("slot").append(f);
  });
}
(async () => {
  const runs = []; let gen = 0;
  for (let r = 0; r < reps; r++) for (const bytes of sizes) {     // alternate sizes within each rep
    const res = await mountOnce(bytes, "g" + (++gen));
    runs.push({ bytes, rep: r, ...res });
    out.textContent = runs.length + " of " + sizes.length * reps + " mounts";
  }
  const expected = { origin: "null", staticModule: true, dynamicModule: true, storage: "blocked",
    worker: "blocked", fetchFrameOrigin: "blocked", fetchExternal: "blocked" };
  const errors = [];
  for (const run of runs) {
    if (!run.ok) { errors.push({ bytes: run.bytes, rep: run.rep, error: run.error }); continue; }
    for (const [k, v] of Object.entries(expected)) if (run.checks[k] !== v)
      errors.push({ bytes: run.bytes, rep: run.rep, check: k, got: run.checks[k], want: v });
    if (run.bytes > 0 && run.checks.image !== true) errors.push({ bytes: run.bytes, rep: run.rep, check: "image", got: run.checks.image });
  }
  const summary = sizes.map((bytes) => {
    const ms = runs.filter((x) => x.bytes === bytes && x.ok).map((x) => x.ms).sort((a, b) => a - b);
    const mid = ms.length ? (ms.length % 2 ? ms[(ms.length - 1) / 2] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2) : null;
    return { bytes, n: ms.length, medianMs: mid, minMs: ms[0] ?? null, maxMs: ms.at(-1) ?? null };
  });
  const result = { instance: ${JSON.stringify(instance)}, label, userAgent: navigator.userAgent,
    devicePixelRatio, completedMounts: runs.filter((x) => x.ok).length, errorCount: errors.length,
    errors, summary, runs, finishedAt: new Date().toISOString() };
  window.__probe = result;
  out.textContent = JSON.stringify({ errorCount: errors.length, completedMounts: result.completedMounts, summary }, null, 2);
  await fetch("/result", { method: "POST", body: JSON.stringify(result) });
  document.title = "frame-probe done";
})();
</script></body>`;
}

function listen(server, port) {
  return new Promise((ok, bad) => { server.once("error", bad); server.listen(Number(port) || 0, "127.0.0.1", () => ok(server.address().port)); });
}

async function serve() {
  fs.mkdirSync(runDir, { recursive: true });
  const instance = crypto.randomUUID();
  let canvasOrigin = "", frameOrigin = "";
  const canvas = http.createServer((req, res) => {
    const url = new URL(req.url, canvasOrigin);
    if (url.pathname === "/health") return res.end(JSON.stringify({ role: "canvas", instance }));
    if (url.pathname === "/result" && req.method === "POST") {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => {
        const file = path.join(runDir, `result-${Date.now()}.json`);
        fs.writeFileSync(file, body);
        res.end(JSON.stringify({ file }));
      });
      return;
    }
    if (url.pathname === "/") { res.setHeader("content-type", "text/html"); return res.end(canvasDoc(frameOrigin, instance)); }
    res.statusCode = 404; res.end();
  });
  const frame = http.createServer((req, res) => {
    const url = new URL(req.url, frameOrigin);
    if (url.pathname === "/health") return res.end(JSON.stringify({ role: "frame", instance }));
    if (url.pathname === "/host") {
      const bytes = Math.min(Number(url.searchParams.get("bytes") || 0), 64e6);
      res.setHeader("content-type", "text/html");
      res.setHeader("content-security-policy", hostCsp(canvasOrigin));
      return res.end(hostDoc(canvasOrigin, frameOrigin, bytes, url.searchParams.get("gen") || ""));
    }
    res.statusCode = 404; res.end();
  });
  const cp = await listen(canvas, opts["canvas-port"]);
  const fp = await listen(frame, opts["frame-port"]);
  canvasOrigin = `http://127.0.0.1:${cp}`; frameOrigin = `http://127.0.0.1:${fp}`;
  const run = { pid: process.pid, instance, canvasOrigin, frameOrigin, startedAt: new Date().toISOString() };
  fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
  console.log(`frame-probe ready ${canvasOrigin} ${frameOrigin}`);
  const stop = () => { canvas.close(); frame.close(); process.exit(0); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}

async function doctor() {
  if (!fs.existsSync(runFile)) fail(`no run.json in ${runDir}`);
  const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
  try { process.kill(run.pid, 0); } catch { fail(`pid ${run.pid} is not running`); }
  for (const [role, origin] of [["canvas", run.canvasOrigin], ["frame", run.frameOrigin]]) {
    const h = await fetch(`${origin}/health`).then((r) => r.json()).catch(() => null);
    if (!h || h.role !== role || h.instance !== run.instance) fail(`${role} origin ${origin} is not this run's instance`);
  }
  console.log(`frame-probe healthy ${run.canvasOrigin} ${run.frameOrigin} pid ${run.pid}`);
}

function stop() {
  if (!fs.existsSync(runFile)) fail(`no run.json in ${runDir}`);
  const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
  try { process.kill(run.pid, "SIGTERM"); console.log(`frame-probe stopped pid ${run.pid}`); }
  catch { console.log(`frame-probe pid ${run.pid} was not running`); }
}

await { serve, doctor, stop }[cmd]();
