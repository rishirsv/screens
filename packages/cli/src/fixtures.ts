// Built-in snapshot bundles for `files=fixture:NAME`. Each returns the MCP bundle file array.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { stamp } from "@screens/core";

export interface BundleFile { readonly path: string; readonly content: string; readonly encoding?: "utf8" | "base64"; readonly mediaType?: string; readonly symlink?: string }

const html = (body: string, head = "") => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px system-ui;padding:24px}</style>${head}</head><body>${body}</body></html>`;

/** Observe native scrolling from inside the sandbox, alongside the canvas camera assertions. */
const wheelPage = (css: string, body = '<div style="height:3600px">Long page</div>') => [{ path: "index.html", content: stamp(html(`${body}<output id="scroll-state" style="position:fixed;top:8px;left:8px;pointer-events:none"></output><script>
const report=()=>document.getElementById("scroll-state").textContent="root="+(document.scrollingElement?.scrollTop||0)+",left="+(document.scrollingElement?.scrollLeft||0)+",body="+document.body.scrollTop+",inner="+(document.getElementById("inner")?.scrollTop||0);
addEventListener("scroll",report,true);report();</script>`, `<style>html,body{height:100%}body{padding:0}${css}</style>`), (n) => `wheel-${n}`).source }];

/** Inline checks that a snapshot's page runs sandboxed: each line reads `name: value`. A network check reads
 *  "blocked" only when the CSP reported a violation for it, so a missing listener or a CORS error never passes
 *  as blocked; "open" means the request succeeded and anything else is "inconclusive". `control` must load. */
const ESCAPE_PROBE = `<ul id="out"></ul><script>
const out = document.getElementById("out");
const put = (k, v) => { const li = document.createElement("li"); li.id = k; li.textContent = k + ": " + v; out.append(li); };
const tryIt = (k, fn) => { try { const v = fn(); put(k, v === undefined ? "ran" : String(v)); } catch { put(k, "blocked"); } };
put("origin", self.origin);
tryIt("localStorage", () => { localStorage.setItem("x", "1"); return "open"; });
tryIt("cookie", () => { document.cookie = "a=1"; return document.cookie === "" ? "blocked" : "open"; });
tryIt("parent", () => parent.document.title);
tryIt("top", () => top.document.title);
const violations = [];
document.addEventListener("securitypolicyviolation", (e) => violations.push(e.blockedURI));
const net = async (k, url, fn) => {
  let ok = false; try { await fn(); ok = true; } catch {}
  await new Promise((r) => setTimeout(r, 50));
  put(k, ok ? "open" : violations.some((v) => url.startsWith(v) || v.startsWith(url.split(":")[0])) ? "blocked" : "inconclusive");
};
(async () => {
  await new Promise((ok, no) => { const i = new Image(); i.onload = ok; i.onerror = no; i.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"; }).then(() => put("control", "loaded"), () => put("control", "failed"));
  await net("fetchLocal", "http://127.0.0.1:4980/health", () => fetch("http://127.0.0.1:4980/health"));
  await net("fetchExternal", "https://example.com/", () => fetch("https://example.com/"));
  await net("socket", "ws://127.0.0.1:4980/ws", () => new Promise((ok, no) => { const w = new WebSocket("ws://127.0.0.1:4980/ws"); w.onopen = ok; w.onerror = no; setTimeout(no, 1500); }));
  await net("worker", "data", () => new Promise((ok, no) => { const w = new Worker("data:text/javascript,postMessage(1)"); w.onmessage = ok; w.onerror = no; setTimeout(no, 1500); }));
  put("done", "yes");
})();
</script>`;

function bmp(w: number, h: number): string {
  const row = Math.ceil((w * 3) / 4) * 4, size = 54 + row * h, b = Buffer.alloc(size);
  b.write("BM", 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(h, 22);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = 54 + y * row + x * 3; b[o] = x & 255; b[o + 1] = y & 255; b[o + 2] = (x ^ y) & 255; }
  return b.toString("base64");
}

export const FIXTURES: Readonly<Record<string, () => BundleFile[]>> = {
  "wheel-board": () => wheelPage('html{overflow:hidden}.board{display:grid;grid-template-columns:repeat(4,140px);gap:16px;padding:12px}.board section{height:320px;background:#fff;border:1px solid #bbb;border-radius:22px;padding:12px;box-sizing:border-box}body{background:#edf0f6}', `<main class="board">${Array.from({ length: 40 }, (_, i) => `<section><header>Screen ${i + 1}</header><h2>iOS app</h2><p>Phone screen</p></section>`).join("")}</main>`),
  "wheel-hidden-root": () => wheelPage("html{overflow:hidden}"),
  "wheel-hidden-body": () => wheelPage("body{overflow:hidden}"),
  "wheel-clipped-root": () => wheelPage("html{overflow:clip}"),
  "wheel-native": () => wheelPage(""),
  "wheel-horizontal": () => wheelPage("", '<div style="width:2600px;height:100px">Wide page</div>'),
  "wheel-body": () => wheelPage("html{overflow:hidden}body{overflow:auto}"),
  "wheel-nested": () => wheelPage("html{overflow:hidden}", '<div id="inner" style="height:300px;width:400px;overflow:auto;margin-top:100px"><div style="height:900px">Inner scroll area</div></div>'),
  "font-a": () => [{ path: "index.html", content: html('<h1 data-pid="font-title">AAA</h1>', `<style>@font-face{font-family:fixture;src:url(shared.ttf)}h1{font-family:fixture}</style>`) }, { path: "shared.ttf", content: "AAEAAAAKAIAAAwAgT1MvMkUhRDUAAAEoAAAAYGNtYXAADACUAAABkAAAADRnbHlmGK0tqwAAAcwAAAAYaGVhZC+ZAVwAAACsAAAANmhoZWEFegHEAAAA5AAAACRobXR4AooAAAAAAYgAAAAGbG9jYQAMAAAAAAHEAAAABm1heHAABAAFAAABCAAAACBuYW1l1nqyDwAAAeQAAADqcG9zdAAoAAAAAALQAAAAJgABAAAAAQAAzURMfV8PPPUAAwPoAAAAAOcVXuAAAAAA5xVe4AAyAAACJgK8AAAAAwACAAAAAAAAAAEAAAMg/zgAAAJYADIAMgImAAEAAAAAAAAAAAAAAAAAAAABAAEAAAACAAMAAQAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwJYAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAAEEAQQMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAACWAAAADIAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAAAQf//AAAAQf///8AAAQAAAAAAAAAAAAwAAAABADIAAAImArwAAgAAMxMTMvr6Arz9RAAAAAoAfgABAAAAAAABAA8AAAABAAAAAAACAAcADwABAAAAAAADAA4AFgABAAAAAAAEAA8AAAABAAAAAAAGAA4AFgADAAEECQABAB4AJAADAAEECQACAA4AQgADAAEECQADABwAUAADAAEECQAEAB4AJAADAAEECQAGABwAUFNjcmVlbnMgRml4dHVyZVJlZ3VsYXJTY3JlZW5zRml4dHVyZQBTAGMAcgBlAGUAbgBzACAARgBpAHgAdAB1AHIAZQBSAGUAZwB1AGwAYQByAFMAYwByAGUAZQBuAHMARgBpAHgAdAB1AHIAZQAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAACQAAA==", encoding: "base64", mediaType: "font/ttf" }],
  "font-b": () => [{ path: "index.html", content: html('<h1 data-pid="font-title">AAAA</h1>', `<style>@font-face{font-family:fixture;src:url(shared.ttf)}h1{font-family:fixture}</style>`) }, { path: "shared.ttf", content: "AAEAAAAKAIAAAwAgT1MvMkUhRDUAAAEoAAAAYGNtYXAADACUAAABkAAAADRnbHlmGK0tqwAAAcwAAAAYaGVhZC+ZAVwAAACsAAAANmhoZWEFegHEAAAA5AAAACRobXR4AooAAAAAAYgAAAAGbG9jYQAMAAAAAAHEAAAABm1heHAABAAFAAABCAAAACBuYW1l1nqyDwAAAeQAAADqcG9zdAAoAAAAAALQAAAAJgABAAAAAQAAzURMfV8PPPUAAwPoAAAAAOcVXuAAAAAA5xVe4AAyAAACJgK8AAAAAwACAAAAAAAAAAEAAAMg/zgAAAJYADIAMgImAAEAAAAAAAAAAAAAAAAAAAABAAEAAAACAAMAAQAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwJYAZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAAEEAQQMg/zgAAAMgAMgAAAAAAAAAAAAAAAAAAAAgAAACWAAAADIAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAAAQf//AAAAQf///8AAAQAAAAAAAAAAAAwAAAABADIAAAImArwAAgAAMxMTMvr6Arz9RAAAAAoAfgABAAAAAAABAA8AAAABAAAAAAACAAcADwABAAAAAAADAA4AFgABAAAAAAAEAA8AAAABAAAAAAAGAA4AFgADAAEECQABAB4AJAADAAEECQACAA4AQgADAAEECQADABwAUAADAAEECQAEAB4AJAADAAEECQAGABwAUFNjcmVlbnMgRml4dHVyZVJlZ3VsYXJTY3JlZW5zRml4dHVyZQBTAGMAcgBlAGUAbgBzACAARgBpAHgAdAB1AHIAZQBSAGUAZwB1AGwAYQByAFMAYwByAGUAZQBuAHMARgBpAHgAdAB1AHIAZQAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAACQAAA==", encoding: "base64", mediaType: "font/ttf" }],
  "symlink-path": () => [{ path: "index.html", content: html("<h1>Refused</h1>"), symlink: "../unrelated-secret.txt" }],
  "dot-drive-path": () => [{ path: "index.html", content: html("<h1>Refused</h1>") }, { path: "./C:/private.txt", content: "not host data" }],
  "absolute-path": () => [{ path: "index.html", content: html("<h1>Refused</h1>") }, { path: "/etc/passwd", content: "not host data" }],
  "traversal-path": () => [{ path: "index.html", content: html("<h1>Refused</h1>") }, { path: "../secret", content: "not host data" }],
  "dot-paths": () => [
    { path: "./index.html", content: html(`<p id="out">Assets missing</p>`, `<link rel="stylesheet" href="./style.css"><script defer src="./app.js"></script>`) },
    { path: "./style.css", content: "#out { color: rgb(12, 34, 56); }" },
    { path: "./app.js", content: `document.getElementById("out").textContent = getComputedStyle(document.getElementById("out")).color;` },
  ],
  /** No scripts: piece edits to it save without the load check. Every piece is marked, so blocks can name them. */
  pieces: () => [{ path: "index.html", content: html(`<header data-pid="hdr" style="padding: 12px; background-color: #4f46e5; color: #fff">Plantly</header><h1 data-pid="ttl">Water your plants</h1><div class="card" data-pid="am" style="background-color: #fff; padding: 8px">Monstera</div><div class="card" data-pid="pm" style="background-color: #fff; padding: 8px">Fiddle</div><button data-pid="cta" style="background-color: #4f46e5; color: #fff; padding: 10px">Water now</button><footer data-pid="ftr">Help</footer>`) }],
  /** A 1920x1080 slide with no scripts: a layout wrapper around a section of text, and a free (absolutely positioned) badge. */
  slide: () => [{ path: "index.html", content: html(`<div class="slide" data-pid="wrap"><section data-pid="copy"><h1 data-pid="ttl" style="font-size: 96px; margin: 0">Revenue grew</h1><p data-pid="sub" style="font-size: 40px; margin: 24px 0 0">Up 10% on the year</p></section></div><div data-pid="badge" data-name="Badge" style="position: absolute; left: 1500px; top: 80px; width: 240px; height: 120px; background-color: #1db954"></div>`, `<style>body{margin:0;font-family:system-ui}.slide{padding:120px}</style>`) }],
  plain: () => [{ path: "index.html", content: html(`<h1>Checkout</h1><p id="status">Ready</p><button id="buy" onclick="document.getElementById('status').textContent='Thanks!'">Buy</button>`) }],
  modules: () => [
    { path: "index.html", content: html(`<h1 id="out">loading</h1>`, `<script type="module" src="app.js"></script>`) },
    { path: "app.js", content: `import { label } from "./lib.js"; document.getElementById("out").textContent = label; import("./late.js").then((m) => document.body.dataset.late = m.late);` },
    { path: "lib.js", content: `export const label = "modules ok";` },
    { path: "late.js", content: `export const late = "yes";` },
  ],
  /** Loads, then asks the network at runtime: the CSP refuses it and validation warns. */
  network: () => [{ path: "index.html", content: html(`<h1>Network</h1><p id="status">Ready</p><script>fetch("https://example.com/data.json").catch(() => {})</script>`) }],
  /** Never finishes loading: validation refuses it. */
  "never-loads": () => [{ path: "index.html", content: html(`<h1>Stuck</h1><script>while (true) {}</script>`) }],
  "message-probe": () => [{ path: "index.html", content: html(`<input id="payload" aria-label="Attack payload"><p id="sent">waiting</p><script>
payload.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const messages = JSON.parse(payload.value);
  for (const target of [parent, top]) for (const message of messages) target.postMessage(message, "*");
  sent.textContent = "sent " + messages.length * 2;
});
</script>`) }],
  "escape-probe": () => [{ path: "index.html", content: html(ESCAPE_PROBE) }],
  animated: () => [{ path: "index.html", content: html(`<div id="spin"></div>`, `<style>#spin{width:120px;height:120px;background:#2a74f5;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style>`) }],
  "big-image": () => [
    { path: "index.html", content: html(`<img id="big" src="big.bmp" style="width:100%">`) },
    { path: "big.bmp", content: bmp(1200, 900), encoding: "base64", mediaType: "image/bmp" },
  ],
};

// ── Files on disk: `drop fixture:NAME`, `paste fixture:NAME` and `path=fixture-file:NAME` ──


/** A truecolor PNG. pixel(x, y) → [r, g, b]. */
function png(w: number, h: number, pixel: (x: number, y: number) => readonly [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { const o = y * (w * 3 + 1); for (let x = 0; x < w; x++) { const [r, g, b] = pixel(x, y); raw[o + 1 + x * 3] = r; raw[o + 2 + x * 3] = g; raw[o + 3 + x * 3] = b; } }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** About 3.2 MB that does not compress, so an upload spans four 1 MiB chunks. Each seed is different bytes, so a block that
 *  needs a fresh upload uses its own seed. */
function noise(seed: number): Buffer {
  let n = seed;
  const r = () => (n = (Math.imul(n, 1103515245) + 12345) >>> 0) >>> 24;
  return png(1200, 900, () => [r(), r(), r()]);
}

/** An export whose prefix says format 99: import must refuse it before uploading anything. */
function futureArchive(): Buffer {
  const head = Buffer.from(JSON.stringify({ format: 99, screen: {}, files: [] }));
  const p = Buffer.alloc(16); p.write("SCREENS\0", 0, "latin1"); p.writeUInt32BE(99, 8); p.writeUInt32BE(head.length, 12);
  return Buffer.concat([p, head]);
}

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
function archive(screen: unknown, files: readonly { mediaType: string; bytes: Buffer; listed?: string }[]): Buffer {
  const head = Buffer.from(JSON.stringify({ format: 1, screen, files: files.map((f) => ({ hash: f.listed ?? sha256(f.bytes), size: f.bytes.length, mediaType: f.mediaType })) }));
  const p = Buffer.alloc(16); p.write("SCREENS\0", 0, "latin1"); p.writeUInt32BE(1, 8); p.writeUInt32BE(head.length, 12);
  return Buffer.concat([p, head, ...files.map((f) => f.bytes)]);
}
/** A Screen written before deleting an image cleared links to it: its snapshot names a source image that is gone. */
function legacyLinkArchive(): Buffer {
  const html = Buffer.from("<!doctype html><h1>Legacy</h1>"), hash = sha256(html), now = Date.parse("2026-11-01T00:00:00Z");
  const screen = { id: "legacy-link-screen", schemaVersion: 1, title: "Legacy", revision: 3, createdAt: now, updatedAt: now, strokes: {}, threads: {},
    items: { legacyitem1: { id: "legacyitem1", kind: "html-snapshot", title: "Recreation", x: 0, y: 0, width: 390, height: 300, z: 1, revision: 1, entry: "index.html",
      contentVersion: "0123456789abcdef01234567", assetManifest: { "index.html": { hash, mediaType: "text/html" } }, posterHash: null, sourceReferenceIds: ["deletedimage1"] } } };
  return archive(screen, [{ mediaType: "text/html", bytes: html }]);
}
/** A saved bundle from the previous path contract. The extra keys are bytes, never host filesystem paths. */
function legacyPathArchive(): Buffer {
  const files = [Buffer.from('<!doctype html><p id="legacy">Legacy stays readable</p>'), Buffer.from("old drive-like name"), Buffer.from("old backslash name")];
  const names = ["index.html", "C:notes.txt", "assets\\old.txt"], now = Date.parse("2026-11-01T00:00:00Z");
  const screen = { id: "legacy-path-screen", schemaVersion: 1, title: "Legacy paths", revision: 1, createdAt: now, updatedAt: now, strokes: {},
    items: { legacyitem1: { id: "legacyitem1", kind: "html-snapshot", title: "Legacy", x: 0, y: 0, width: 390, height: 300, z: 1, revision: 1, entry: "index.html",
      contentVersion: "0123456789abcdef01234567", assetManifest: Object.fromEntries(names.map((n, i) => [n, { hash: sha256(files[i]!), mediaType: "text/html" }])), posterHash: null, sourceReferenceIds: [] } } };
  return archive(screen, files.map((bytes) => ({ bytes, mediaType: "text/html" })));
}
/** An export damaged on disk: one file's bytes no longer match the hash its header lists. */
function damagedArchive(): Buffer {
  const html = Buffer.from("<!doctype html><h1>Damaged</h1>"), listed = sha256(html);
  return archive({ id: "damaged-screen" }, [{ mediaType: "text/html", bytes: Buffer.from("<!doctype html><h1>Dameged</h1>"), listed }]);
}

/** File name (its extension sets the type a browser reports) → bytes. */
export const FILE_FIXTURES: Readonly<Record<string, { readonly name: string; readonly bytes: () => Buffer }>> = {
  png: { name: "landing.png", bytes: () => png(640, 480, (x, y) => [x & 255, y & 255, 160]) },
  "png-small": { name: "badge.png", bytes: () => png(320, 200, (x, y) => [40, x & 255, y & 255]) },
  "png-large": { name: "poster.png", bytes: () => png(4000, 3000, (x, y) => [(x >> 4) & 255, (y >> 4) & 255, 90]) },
  ...Object.fromEntries(["a", "b", "c", "d", "e", "f", "g"].map((k, i) => [`noise-${k}`, { name: `noise-${k}.png`, bytes: () => noise(i + 1) }])),
  text: { name: "notes.txt", bytes: () => Buffer.from("not an image\n") },
  "archive-v99": { name: "future.screens", bytes: futureArchive },
  "archive-legacy-link": { name: "legacy.screens", bytes: legacyLinkArchive },
  "archive-legacy-paths": { name: "legacy-paths.screens", bytes: legacyPathArchive },
  "archive-damaged": { name: "damaged.screens", bytes: damagedArchive },
};

/** `fixture:NAME` → a fresh copy of that file fixture in `dir`; anything else is a path from `cwd`. Returns an absolute path. */
export function fileArg(spec: string, dir: string, cwd: string): string {
  if (!spec.startsWith("fixture:")) return path.resolve(cwd, spec);
  if (spec === "fixture:bundle-symlink") {
    const root = path.join(dir, "bundle-symlink"); fs.mkdirSync(root, { recursive: true });
    const outside = path.join(dir, "outside.txt"); fs.writeFileSync(outside, "SCREENS_UNRELATED_FILE_CANARY_41c921");
    fs.writeFileSync(path.join(root, "index.html"), html("<h1>Symlink</h1>"));
    const link = path.join(root, "secret.txt"); if (!fs.existsSync(link)) fs.symlinkSync(outside, link);
    return root;
  }
  const f = FILE_FIXTURES[spec.slice(8)];
  if (!f) throw new Error(`no file fixture "${spec.slice(8)}" (fixtures: ${Object.keys(FILE_FIXTURES).join(" ")})`);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, f.name);
  fs.writeFileSync(out, f.bytes());
  return out;
}
