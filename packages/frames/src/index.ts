// Frame origin: host pages that run a snapshot inside a sandboxed srcdoc child.
//
// canvas origin
//  └─ host iframe (unsandboxed, frame origin, this server)      CSP = HOST_CSP, inherited by the child
//       └─ snapshot iframe, sandbox="allow-scripts", srcdoc     opaque origin, all assets as data: URLs
//
// The bundle is inlined on the server (cached per contentVersion). The validator serves the same hostResponse().
// An object still being written uses /draft/<screen>: the same CSP, and a child with sandbox="" that runs no script.

import crypto from "node:crypto";
import path from "node:path";
import type http from "node:http";
import type { AssetManifest } from "@screens/core";

export { HOST_CSP, inlineBundle, CHILD_BRIDGE, type InlineResult } from "./inline.ts";
import { HOST_CSP, inlineBundle, type InlineResult } from "./inline.ts";

/** The host page response the canvas loads. The frame server and the validator both serve exactly this. */
export function hostResponse(child: string, canvasOrigin: string, gen: string): { readonly body: string; readonly headers: Readonly<Record<string, string>> } {
  return { body: hostPage(child, canvasOrigin, gen),
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": HOST_CSP(canvasOrigin), "cache-control": "no-store" } };
}

function hostPage(child: string, canvasOrigin: string, gen: string): string {
  const attr = child.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style></head><body>
<iframe id="c" sandbox="allow-scripts" srcdoc="${attr}"></iframe>
<script>(()=>{const c=document.getElementById("c"),gen=${JSON.stringify(gen)},to=${JSON.stringify(canvasOrigin)};
const num=(v)=>typeof v==="number"&&isFinite(v)?v:0;const pid=(v)=>typeof v==="string"&&/^[a-z][a-z0-9-]{0,23}$/.test(v)?v:null;const str=(v,n)=>typeof v==="string"?v.slice(0,n):"";const opt=(v)=>typeof v==="number"&&isFinite(v)?v:null;
addEventListener("message",(e)=>{if(e.source!==parent||e.origin!==to||!e.data||e.data.gen!==gen||!["highlight","edit","commit","focus"].includes(e.data.kind))return;
// Keyboard focus handed to this page belongs to the object inside it.
if(e.data.kind==="focus"){c.focus();return}c.contentWindow.postMessage({kind:e.data.kind,pid:pid(e.data.pid),pids:Array.isArray(e.data.pids)?e.data.pids.slice(0,50).map(pid).filter(Boolean):[],zoom:num(e.data.zoom)},"*");});
addEventListener("message",(e)=>{if(e.source!==c.contentWindow||e.origin!=="null"||!e.data||typeof e.data!=="object"||Array.isArray(e.data))return;const d=e.data;
// Children have no routing authority. The host supplies identity and generation.
if("itemId" in d||"gen" in d)return;
if(d.kind==="ready")parent.postMessage({kind:"ready",gen},to);
else if(d.kind==="error")parent.postMessage({kind:"failed",gen,message:String(d.message).slice(0,200)},to);
else if(d.kind==="pointer")parent.postMessage({kind:"pointer",gen,x:num(d.x),y:num(d.y),pid:pid(d.pid),shift:d.shift===true},to);
else if(d.kind==="select")parent.postMessage({kind:"select",gen,pids:Array.isArray(d.pids)?d.pids.slice(0,50).map(pid).filter(Boolean):[]},to);
else if(d.kind==="rect")parent.postMessage({kind:"rect",gen,pid:pid(d.pid),x:num(d.x),y:num(d.y),w:num(d.w),h:num(d.h),size:num(d.size),weight:num(d.weight),italic:d.italic===true,align:str(d.align,16),color:str(d.color,64),fill:str(d.fill,64),font:str(d.font,200),fit:str(d.fit,16),free:d.free===true,fonts:Array.isArray(d.fonts)?d.fonts.slice(0,12).map((f)=>str(f,64)):[]},to);
else if(d.kind==="history")parent.postMessage({kind:"history",gen,redo:d.redo===true},to);
else if(d.kind==="dbl")parent.postMessage({kind:"dbl",gen,pid:pid(d.pid)},to);
else if(d.kind==="text")parent.postMessage({kind:"text",gen,pid:pid(d.pid),text:typeof d.text==="string"?d.text.slice(0,20000):null},to);
else if(d.kind==="move")parent.postMessage({kind:"move",gen,items:Array.isArray(d.items)?d.items.slice(0,50).map((m)=>m&&typeof m==="object"?{pid:pid(m.pid),rel:m.rel===true,x:opt(m.x),y:opt(m.y),w:opt(m.w),h:opt(m.h)}:null).filter((m)=>m&&m.pid):[]},to);
else if(d.kind==="zoom")parent.postMessage({kind:"zoom",gen,x:num(d.x),y:num(d.y),dy:num(d.dy),pinch:d.pinch===true},to);
else if(d.kind==="pan")parent.postMessage({kind:"pan",gen,dx:num(d.dx),dy:num(d.dy)},to);
else if(d.kind==="escape")parent.postMessage({kind:"escape",gen},to);});})();</script></body></html>`;
}

/** The draft host page: shows an agent's object while it is being written. The canvas posts the text; the page shows it in a
 *  child with sandbox="" (no scripts at all, stricter than a snapshot), double-buffered so a new part never flashes white.
 *  It answers {kind:"draft-shown", rev} to the canvas. Same CSP as the snapshot host, so nothing loads from the network. */
export function draftHostResponse(canvasOrigin: string): { readonly body: string; readonly headers: Readonly<Record<string, string>> } {
  const to = JSON.stringify(canvasOrigin);
  const body = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:#fff}iframe{position:absolute;inset:0;display:block;border:0;width:100%;height:100%}</style></head><body>
<iframe sandbox="" aria-hidden="true"></iframe><iframe sandbox="" aria-hidden="true" style="visibility:hidden"></iframe>
<script>(()=>{const f=[...document.querySelectorAll("iframe")];let shown=0,want=null,busy=false;
const show=()=>{if(busy||!want)return;const d=want;want=null;busy=true;const next=f[1-shown];
next.onload=()=>{next.style.visibility="visible";f[shown].style.visibility="hidden";shown=1-shown;busy=false;parent.postMessage({kind:"draft-shown",rev:d.rev},${to});show();};
next.srcdoc=d.html;};
addEventListener("message",(e)=>{if(e.origin!==${to}||e.source!==parent||!e.data||e.data.kind!=="draft"||typeof e.data.html!=="string")return;
want={html:e.data.html,rev:Number(e.data.rev)||0};show();});
parent.postMessage({kind:"draft-ready"},${to});})();</script></body></html>`;
  return { body, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": HOST_CSP(canvasOrigin), "cache-control": "no-store" } };
}

export interface FrameSource { readonly entry: string; readonly manifest: AssetManifest }
export interface FrameServerOptions {
  readonly canvasOrigin: () => string;
  readonly secret: Buffer;
  readonly resolve: (screenId: string, itemId: string, contentVersion: string) => FrameSource | null;
  readonly read: (hash: string) => Uint8Array | null;
  readonly onDiagnostics?: (contentVersion: string, diagnostics: readonly string[]) => void;
}

const CACHE_CHARS = 128e6;

export function frameCapability(secret: Buffer, screenId: string): string {
  return crypto.createHmac("sha256", secret).update(`frames:${screenId}`).digest("hex").slice(0, 32);
}

/** Request handler for the frame origin: GET /host/<screen>/<item>/<contentVersion>?gen=…&cap=… */
export function createFrameHandler(o: FrameServerOptions): http.RequestListener {
  // Inlined pages, newest last, bounded by total size: one large bundle must not pin hundreds of MB.
  const cache = new Map<string, string>();
  let cached = 0;
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://frames");
    if (url.pathname === "/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ role: "frames" })); return; }
    const dm = url.pathname.match(/^\/draft\/([\w-]+)$/);
    if (dm && req.method === "GET") {
      const got = Buffer.from(url.searchParams.get("cap") ?? ""), expected = Buffer.from(frameCapability(o.secret, dm[1]!));
      if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) { res.statusCode = 403; res.end(); return; }
      const r = draftHostResponse(o.canvasOrigin());
      for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
      res.end(r.body); return;
    }
    const m = url.pathname.match(/^\/host\/([\w-]+)\/([\w-]+)\/([\w-]+)$/);
    if (!m || req.method !== "GET") { res.statusCode = 404; res.end(); return; }
    const [, screenId, itemId, contentVersion] = m as unknown as [string, string, string, string];
    const cap = url.searchParams.get("cap") ?? "";
    const want = frameCapability(o.secret, screenId);
    const got = Buffer.from(cap), expected = Buffer.from(want);
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) { res.statusCode = 403; res.end(); return; }
    let child = cache.get(contentVersion);
    if (!child) {
      const src = o.resolve(screenId, itemId, contentVersion);
      if (!src) { res.statusCode = 404; res.end(); return; }
      let r: InlineResult;
      try { r = inlineBundle(src.entry, src.manifest, o.read); }
      catch (e) { o.onDiagnostics?.(contentVersion, [`could not build the page: ${(e as Error).message}`]); res.statusCode = 500; res.end(); return; }
      if (r.diagnostics.length) o.onDiagnostics?.(contentVersion, r.diagnostics);
      child = r.html;
      if (child.length <= CACHE_CHARS) {
        cache.set(contentVersion, child); cached += child.length;
        while (cached > CACHE_CHARS) { const [k, v] = cache.entries().next().value!; cache.delete(k); cached -= v.length; }
      }
    }
    const r = hostResponse(child, o.canvasOrigin(), url.searchParams.get("gen") ?? "");
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    res.end(r.body);
  };
}
