// Validation worker: test-loads a snapshot exactly as the canvas would, records what went wrong, and captures a poster.
// It commits nothing. Only the service imports it.
//
// embedder page (synthetic canvas origin)                      stands in for the canvas: waits for the bridge's ready
//  └─ host page (synthetic frame origin, hostResponse())        the same body and CSP header the frame server sends
//       └─ snapshot iframe, sandbox="allow-scripts", srcdoc     the same inlineBundle() child
//
// Every request is answered by route interception, so neither real server sees validator traffic and uncommitted
// content needs no capability. Anything else a page asks for is refused and reported.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { AssetManifest, SnapshotWarning } from "@screens/core";
import { hostResponse, inlineBundle } from "@screens/frames";

export interface PageToCheck {
  readonly entry: string;
  readonly manifest: AssetManifest;
  readonly read: (hash: string) => Uint8Array | null;
  /** CSS pixels: the item's size, so the poster matches the frame it covers. */
  readonly width: number;
  readonly height: number;
  /** Piece ids: crop the poster to their union, in CSS pixels of the page. Pieces that are missing or hidden are skipped. */
  readonly clip?: readonly string[];
  /** The poster's pixel cap, when it differs from POSTER_MAX_PIXELS (a slide's poster is full resolution). */
  readonly posterPixels?: number;
  /** A sharp PNG at this many device pixels per CSS pixel (capped by STILL_MAX_PIXELS), instead of the small JPEG poster. */
  readonly still?: number;
}
/** rect is the cropped region in CSS pixels when clip was asked for and found. */
export interface PosterImage { readonly bytes: Uint8Array; readonly mediaType: "image/jpeg" | "image/png"; readonly width: number; readonly height: number; readonly rect?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } }

/** One overview image composed from stored pictures. Positions are output pixels; images are fetched with read. */
export interface MontageToDraw {
  readonly width: number;
  readonly height: number;
  /** Back to front. fit as the canvas draws it: cover is anchored top left, contain is centered. */
  readonly images: readonly { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly hash: string | null; readonly mediaType: string; readonly fit: "fill" | "cover" | "contain" }[];
  /** Titles, drawn above their image: x/y is the image's top left, w the width the text may take. */
  readonly labels: readonly { readonly x: number; readonly y: number; readonly w: number; readonly text: string }[];
  /** An SVG drawn over the images at the output size: the strokes. */
  readonly svg: string;
  readonly read: (hash: string) => Uint8Array | null;
}

/** Only "not-loaded" refuses a save. A loaded check without a poster carries a "poster" warning. */
export type Check =
  | { readonly status: "loaded"; readonly poster: PosterImage | null; readonly warnings: readonly SnapshotWarning[] }
  | { readonly status: "not-loaded"; readonly reason: string; readonly warnings: readonly SnapshotWarning[] }
  | { readonly status: "unchecked"; readonly warnings: readonly SnapshotWarning[] };

export interface Validator {
  /** Never throws for page faults: those are a Check. Safe to call concurrently. */
  check(page: PageToCheck): Promise<Check>;
  /** A JPEG of a still image fit within edge×edge, decoded in the shared Chrome. null when Chrome is unavailable or the image will not decode. */
  thumbnail(bytes: Uint8Array, mediaType: string, size: { readonly width: number; readonly height: number }, edge: number): Promise<Uint8Array | null>;
  /** A JPEG of the montage, drawn in the shared Chrome. null when Chrome is unavailable. */
  montage(m: MontageToDraw): Promise<Uint8Array | null>;
  /** Closes the shared browser. */
  close(): Promise<void>;
}

// Starting values, not measured budgets.
const LOAD_TIMEOUT_MS = 5000, SETTLE_MS = 500, POSTER_TIMEOUT_MS = 2000, STILL_TIMEOUT_MS = 5000, CLOSE_TIMEOUT_MS = 2000, IDLE_CLOSE_MS = 60_000, MAX_PARALLEL = 2;
const POSTER_MAX_PIXELS = 500_000, STILL_MAX_PIXELS = 24_000_000, STILL_SIDE_MAX = 16_384, JPEG_QUALITY = 80, VIEWPORT_MAX = 4096, WARNINGS_MAX = 10, MESSAGE_MAX = 200;
const MONTAGE_QUALITY = 70;
const CANVAS = "http://canvas.screens.localhost", FRAMES = "http://frames.screens.localhost", MONTAGE = "http://montage.screens.localhost";
const GEN = "1";

/** The canvas side of the bridge (runtime.ts onMessage): only the host window, from the frame origin, for this generation. */
const EMBEDDER = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style></head>
<body><iframe id="h" src="${FRAMES}/host?gen=${GEN}"></iframe><script>addEventListener("message",(e)=>{const d=e.data;
if(e.origin!=="${FRAMES}"||e.source!==h.contentWindow||!d||d.gen!=="${GEN}")return;if(d.kind==="ready")window.__screensReady=true;});</script></body></html>`;

/** Chrome's console text for a request the CSP refused (Chrome 156: "Connecting to 'URL' violates the following
 *  Content Security Policy directive"; a self-navigation reads "Framing 'URL' violates …"). */
const CSP_REFUSAL = /'([^']+)' violates the following Content Security Policy/;

/** `browser` is "chrome", "chromium" or an executable path, as screens-cli takes it. */
export function createValidator(o: { readonly browser?: string; readonly refuseLaunch?: () => boolean } = {}): Validator {
  const sel = o.browser ?? process.env.SCREENS_BROWSER ?? (process.platform === "darwin" ? "chrome" : "chromium");
  let launching: Promise<Browser> | null = null;
  let running = 0, idle: NodeJS.Timeout | null = null, doomed = false;
  const queue: (() => void)[] = [];

  const browser = async (): Promise<Browser | string> => {
    if (o.refuseLaunch?.()) return "injected launch failure";
    // A failed launch is not remembered: installing Chrome fixes the next check with no restart.
    launching ??= chromium.launch({ ...(sel === "chrome" ? { channel: "chrome" } : sel === "chromium" ? {} : { executablePath: sel }), headless: true, timeout: 10_000 })
      .then((b) => { b.on("disconnected", () => { if (launching && b === current) launching = null; }); current = b; return b; });
    try { return await launching; } catch (e) { launching = null; return (e as Error).message.split("\n")[0]!; }
  };
  let current: Browser | null = null;
  const retire = async () => { const b = current; current = null; launching = null; doomed = false; await b?.close().catch(() => {}); };
  /** A context that would not close: retire the browser once no other check is using it. */
  const doom = async () => { doomed = true; if (running <= 1) await retire(); };

  const slot = async () => {
    if (idle) { clearTimeout(idle); idle = null; }
    if (running >= MAX_PARALLEL) await new Promise<void>((r) => queue.push(r));
    running++;
  };
  const release = () => {
    running--;
    const next = queue.shift(); if (next) { next(); return; }
    if (running === 0) { if (doomed) { void retire(); return; } idle = setTimeout(() => void retire(), IDLE_CLOSE_MS); idle.unref(); }
  };

  return {
    async check(page) {
      const warnings = collector();
      // Take a slot before inlining, so queued checks hold only their inputs, not built pages.
      await slot();
      try {
        let child: string;
        try {
          const r = inlineBundle(page.entry, page.manifest, page.read);
          // An unresolved network reference is the same blocked request the page will make: one warning for both.
          for (const d of r.diagnostics) { const net = /^network reference left unresolved: (.*)$/.exec(d); warnings.add(net ? "network" : "bundle", net ? `blocked request to ${net[1]}` : d); }
          child = r.html;
        } catch (e) { return { status: "not-loaded", reason: `could not build the page: ${(e as Error).message}`, warnings: warnings.list() }; }
        const b = await browser();
        if (typeof b === "string") {
          warnings.add("unchecked", `Chrome is not available, so this snapshot was saved without a load check or poster (${b})`);
          return { status: "unchecked", warnings: warnings.list() };
        }
        return await checkOnce(b, page, child, warnings, doom);
      } finally { release(); }
    },
    async thumbnail(bytes, mediaType, size, edge) {
      await slot();
      try {
        const b = await browser(); if (typeof b === "string") return null;
        const k = Math.min(1, edge / Math.max(size.width, size.height));
        const w = Math.max(1, Math.round(size.width * k)), h = Math.max(1, Math.round(size.height * k));
        let ctx: BrowserContext | null = null;
        try {
          ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, serviceWorkers: "block", javaScriptEnabled: true });
          await ctx.route("**/*", (r) => r.abort());
          const p = await ctx.newPage();
          const src = `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
          await p.setContent(`<!doctype html><style>html,body{margin:0;background:#eaeaee}img{display:block;width:${w}px;height:${h}px;object-fit:contain}</style><img id="i">`, { timeout: POSTER_TIMEOUT_MS });
          const ok = await p.evaluate((u) => new Promise<boolean>((res) => { const i = document.getElementById("i") as HTMLImageElement; i.onload = () => i.decode().then(() => res(true), () => res(false)); i.onerror = () => res(false); i.src = u; }), src);
          if (!ok) return null;
          return await p.screenshot({ type: "jpeg", quality: JPEG_QUALITY, timeout: POSTER_TIMEOUT_MS });
        } catch { return null; }
        finally { if (ctx && !(await within(CLOSE_TIMEOUT_MS, ctx.close().then(() => true).catch(() => true)))) await doom(); }
      } finally { release(); }
    },
    async montage(m) {
      await slot();
      try {
        const b = await browser(); if (typeof b === "string") return null;
        let ctx: BrowserContext | null = null;
        try {
          ctx = await b.newContext({ viewport: { width: m.width, height: m.height }, deviceScaleFactor: 1, serviceWorkers: "block", javaScriptEnabled: true });
          // Pictures come from storage by hash; the page asks for nothing else.
          await ctx.route("**/*", (r) => {
            const u = r.request().url();
            if (u === `${MONTAGE}/`) return r.fulfill({ contentType: "text/html; charset=utf-8", body: montagePage(m) });
            const hit = u.startsWith(`${MONTAGE}/c/`) ? m.images.find((i) => i.hash && u === `${MONTAGE}/c/${i.hash}`) : undefined;
            const bytes = hit?.hash ? m.read(hit.hash) : null;
            return bytes ? r.fulfill({ contentType: hit!.mediaType, body: Buffer.from(bytes) }) : r.abort();
          });
          const p = await ctx.newPage();
          await p.goto(`${MONTAGE}/`, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
          await within(SETTLE_MS, p.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))).then(() => undefined)));
          return await p.screenshot({ type: "jpeg", quality: MONTAGE_QUALITY, timeout: STILL_TIMEOUT_MS });
        } catch { return null; }
        finally { if (ctx && !(await within(CLOSE_TIMEOUT_MS, ctx.close().then(() => true).catch(() => true)))) await doom(); }
      } finally { release(); }
    },
    async close() { if (idle) clearTimeout(idle); await retire(); },
  };
}

async function checkOnce(b: Browser, page: PageToCheck, child: string, warnings: Warnings, doom: () => Promise<void>): Promise<Check> {
  // A still keeps the whole frame up to the largest side Chrome can capture; a poster stops at VIEWPORT_MAX.
  const side = page.still ? STILL_SIDE_MAX : VIEWPORT_MAX;
  const w = clamp(page.width, side), h = clamp(page.height, side);
  if (w !== page.width || h !== page.height) warnings.add("viewport-limited", `rendered at ${w}x${h} of ${page.width}x${page.height}; the poster shows the top left`);
  const dsf = page.still ? Math.min(page.still, Math.sqrt(STILL_MAX_PIXELS / (w * h)), STILL_SIDE_MAX / Math.max(w, h))
    : Math.min(1, Math.sqrt((page.posterPixels ?? POSTER_MAX_PIXELS) / (w * h)));
  let ctx: BrowserContext | null = null;
  try {
    ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, serviceWorkers: "block", acceptDownloads: false, reducedMotion: "reduce" });
    await ctx.route("**/*", (r) => {
      const u = r.request().url();
      if (u === `${CANVAS}/`) return r.fulfill({ contentType: "text/html; charset=utf-8", body: EMBEDDER });
      if (u.startsWith(`${FRAMES}/host`)) { const res = hostResponse(child, CANVAS, GEN); return r.fulfill({ headers: { ...res.headers }, body: res.body }); }
      warnings.add("network", `blocked request to ${u}`);
      // 204 cancels a navigation without replacing the page, so a self-navigation leaves the poster intact.
      return r.fulfill({ status: 204 });
    });
    const p: Page = await ctx.newPage();
    let crashed = false;
    p.on("crash", () => { crashed = true; });
    p.on("pageerror", (e) => warnings.add("script-error", e.message));
    p.on("console", (m) => { if (m.type() !== "error") return; const hit = CSP_REFUSAL.exec(m.text()); if (hit) warnings.add("network", `blocked request to ${hit[1]}`); });

    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    const notLoaded = (): Check => ({ status: "not-loaded", reason: crashed ? "the page crashed while loading" : `the page did not finish loading within ${LOAD_TIMEOUT_MS / 1000} s`, warnings: warnings.list() });
    try {
      await p.goto(`${CANVAS}/`, { waitUntil: "commit", timeout: LOAD_TIMEOUT_MS });
      await p.waitForFunction(() => (window as { __screensReady?: boolean }).__screensReady === true, undefined, { polling: 50, timeout: Math.max(1, deadline - Date.now()) });
    } catch { return notLoaded(); }
    if (crashed) return notLoaded();

    // Settle: fonts the page asked for, then two frames. Bounded, and a failure here is not a load failure.
    const snap = p.frames().find((f) => f.parentFrame()?.parentFrame() === p.mainFrame());
    await within(SETTLE_MS, (async () => {
      await snap?.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => {});
      await p.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))).catch(() => {});
    })());

    try {
      // A crop: the union of the asked pieces' boxes, padded a little and kept inside the viewport.
      const want = page.clip?.filter((id) => /^[a-z][a-z0-9-]{0,23}$/.test(id)) ?? [];
      const rect = want.length && snap ? await snap.evaluate((ids: string[]) => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const id of ids) for (const el of document.querySelectorAll(`[data-pid="${id}"]`)) {
          const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
          x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
        }
        return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
      }, want).catch(() => null) : null;
      const clip = rect ? (() => { const pad = 8, x = Math.max(0, Math.floor(rect.x - pad)), y = Math.max(0, Math.floor(rect.y - pad));
        return { x, y, width: Math.max(1, Math.min(w, Math.ceil(rect.x + rect.w + pad)) - x), height: Math.max(1, Math.min(h, Math.ceil(rect.y + rect.h + pad)) - y) }; })() : null;
      const bytes = await p.screenshot({ ...(page.still ? { type: "png" as const } : { type: "jpeg" as const, quality: JPEG_QUALITY }), animations: "disabled", caret: "hide",
        timeout: page.still ? STILL_TIMEOUT_MS : POSTER_TIMEOUT_MS, ...(clip ? { clip } : {}) });
      const size = clip ? { width: Math.round(clip.width * dsf), height: Math.round(clip.height * dsf) } : { width: Math.round(w * dsf), height: Math.round(h * dsf) };
      return { status: "loaded", poster: { bytes, mediaType: page.still ? "image/png" : "image/jpeg", ...size, ...(clip ? { rect: { x: clip.x, y: clip.y, w: clip.width, h: clip.height } } : {}) }, warnings: warnings.list() };
    } catch {
      warnings.add("poster", "the page loaded but its poster could not be captured");
      return { status: "loaded", poster: null, warnings: warnings.list() };
    }
  } finally {
    // A renderer stuck in a loop can hold the context open: then the browser goes once other checks finish.
    if (ctx && !(await within(CLOSE_TIMEOUT_MS, ctx.close().then(() => true).catch(() => true)))) await doom();
  }
}

/** The canvas look at a glance: the canvas color, white behind each picture, titles in the canvas's label style. */
function montagePage(m: MontageToDraw): string {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const px = (n: number) => `${Math.round(n * 100) / 100}px`;
  const imgs = m.images.map((i) => i.hash
    ? `<img src="${MONTAGE}/c/${i.hash}" style="left:${px(i.x)};top:${px(i.y)};width:${px(i.w)};height:${px(i.h)};object-fit:${i.fit};object-position:${i.fit === "cover" ? "left top" : "center"}">`
    : `<div class="none" style="left:${px(i.x)};top:${px(i.y)};width:${px(i.w)};height:${px(i.h)}"></div>`).join("");
  const labels = m.labels.map((l) => `<div class="t" style="left:${px(l.x)};top:${px(l.y - 18)};width:${px(Math.max(40, l.w))}">${esc(l.text)}</div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${m.width}px;height:${m.height}px;overflow:hidden;background:#eaeaee;position:relative}
img,.none{position:absolute;display:block;background:#fff}.none{background:#d8d8de}
svg{position:absolute;left:0;top:0}
.t{position:absolute;height:16px;font:12px/16px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#5e5e70;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style></head>
<body>${imgs}${m.svg}${labels}</body></html>`;
}

interface Warnings { add(code: SnapshotWarning["code"], message: string): void; list(): SnapshotWarning[] }
function collector(): Warnings {
  const seen = new Set<string>(), out: SnapshotWarning[] = [];
  let dropped = 0;
  return {
    add(code, message) {
      const m = message.replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX);
      const key = `${code}:${m}`; if (seen.has(key)) return; seen.add(key);
      if (out.length < WARNINGS_MAX) out.push({ code, message: m }); else dropped++;
    },
    list: () => (dropped ? [...out, { code: "bundle", message: `and ${dropped} more` }] : [...out]),
  };
}

const clamp = (n: number, max = VIEWPORT_MAX) => Math.max(1, Math.min(max, Math.round(n)));
/** Resolves with the promise's value, or false once ms pass. */
function within<T>(ms: number, p: Promise<T>): Promise<T | false> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<false>((r) => { t = setTimeout(() => r(false), ms); })]).finally(() => clearTimeout(t));
}
