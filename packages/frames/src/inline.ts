// Shared by the frame server and MCP App canvas. No Node APIs or network access.
import { HIDDEN_RULE, type AssetManifest } from "@screens/core";
const normalize = (from: string, ref: string): string => {
  const parts: string[] = [];
  for (const part of (from.slice(0, from.lastIndexOf("/") + 1) + ref).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length && parts.at(-1) !== "..") parts.pop(); else parts.push(part); } else parts.push(part);
  }
  return parts.join("/");
};
const base64 = (bytes: Uint8Array): string => {
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export const HOST_CSP = (canvasOrigin: string): string =>
  `default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; ` +
  `font-src data:; media-src data:; worker-src 'none'; frame-ancestors ${canvasOrigin}`;

export interface InlineResult { readonly html: string; readonly diagnostics: readonly string[]; readonly bytes: number }

const JS = /\.(m?js)$/i;
const CSS = /\.css$/i;

/** Pure given `read`. Unresolvable references become diagnostics, never network URLs. */
export function inlineBundle(entry: string, manifest: AssetManifest, read: (hash: string) => Uint8Array | null): InlineResult {
  const diagnostics: string[] = [];
  const text = (p: string) => { const b = read(manifest[p]!.hash); if (!b) throw new Error(`missing content for ${p}`); return new TextDecoder().decode(b); };
  const resolve = (from: string, ref: string): string | null => {
    if (/^(data:|#|about:|javascript:)/i.test(ref)) return null;
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) { diagnostics.push(`network reference left unresolved: ${ref}`); return null; }
    const clean = ref.split(/[?#]/)[0]!;
    const p = normalize(from, clean);
    if (!manifest[p]) { diagnostics.push(`missing file ${p} (from ${from})`); return null; }
    return p;
  };
  const cache = new Map<string, string>();
  const expanding = new Set<string>();
  /** null when p is already being expanded: an import cycle, reported instead of recursing forever. */
  const dataUrl = (p: string): string | null => {
    const hit = cache.get(p); if (hit) return hit;
    if (expanding.has(p)) { diagnostics.push(`import cycle through ${p}`); return null; }
    expanding.add(p);
    let body: Uint8Array;
    try {
      if (CSS.test(p)) body = new TextEncoder().encode(rewriteCss(p, text(p)));
      else if (JS.test(p)) body = new TextEncoder().encode(rewriteJs(p, text(p)));
      else { const b = read(manifest[p]!.hash); if (!b) throw new Error(`missing content for ${p}`); body = b; }
    } finally { expanding.delete(p); }
    const url = `data:${manifest[p]!.mediaType};base64,${base64(body)}`;
    cache.set(p, url);
    return url;
  };
  const inlined = (from: string, ref: string): string | null => { const p = resolve(from, ref); return p ? dataUrl(p) : null; };
  const rewriteCss = (from: string, css: string): string =>
    css.replace(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)["']?\s*\)?/g, (m, ref: string) => {
      const u = inlined(from, ref); return u ? `@import url("${u}")` : m;
    }).replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (m, _q, ref: string) => {
      const u = inlined(from, ref.trim()); return u ? `url("${u}")` : m;
    });
  // Relative module specifiers become screens:/<path> keys that the import map resolves to data: modules.
  const rewriteJs = (from: string, js: string): string =>
    js.replace(/(\bimport\s*\(\s*|\bfrom\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+|\/[^"']+)\2/g, (m, lead: string, q: string, ref: string) => {
      const p = resolve(from, ref); return p ? `${lead}${q}screens:/${p}${q}` : m;
    });

  let html = text(entry);
  // Inline module scripts and styles first, so their bodies get rewritten too.
  html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_m, attrs: string, css: string) => `<style${attrs}>${rewriteCss(entry, css)}</style>`);
  html = html.replace(/<script([^>]*\btype=["']module["'][^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs: string, js: string) =>
    /\bsrc=/.test(attrs) ? m : `<script${attrs}>${rewriteJs(entry, js)}</script>`);
  // Every asset attribute of every start tag, quoted or not. Links are navigation, not assets.
  html = html.replace(/<([a-zA-Z][\w-]*)(\s[^>]*)?>/g, (tag, name: string, attrs: string | undefined) => {
    if (!attrs) return tag;
    const out = attrs.replace(/(\s)(src|href|poster|srcset)=(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi, (m, sp: string, attr: string, d?: string, s?: string, bare?: string) => {
      const ref = d ?? s ?? bare ?? "", a = attr.toLowerCase();
      if (a === "href" && name.toLowerCase() === "a") return m;
      if (a === "srcset") return `${sp}${attr}="${ref.split(",").map((part) => { const [r, ...w] = part.trim().split(/\s+/); return [(r && inlined(entry, r)) || r, ...w].join(" "); }).join(", ")}"`;
      const u = inlined(entry, ref); return u ? `${sp}${attr}="${u}"` : m;
    });
    return `<${name}${out}>`;
  });

  const imports: Record<string, string> = {};
  for (const p of Object.keys(manifest)) if (JS.test(p)) { const u = dataUrl(p); if (u) imports[`screens:/${p}`] = u; }
  const head = `<script type="importmap">${JSON.stringify({ imports })}</script><script>${CHILD_BRIDGE}</script>${HIDDEN_RULE}`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + head) : head + html;
  return { html, diagnostics, bytes: new TextEncoder().encode(html).length };
}

/** Runs inside the opaque child before any snapshot script. Posts only allowlisted shapes. */
export const CHILD_BRIDGE = `(()=>{const p=(m)=>parent.postMessage(m,"*");
addEventListener("load",()=>p({kind:"ready"}));
addEventListener("error",(e)=>{if(e.target===window)p({kind:"error",message:String(e.message||"error").slice(0,200)})});
addEventListener("pointerdown",(e)=>{const t=e.target&&e.target.closest?e.target.closest("[data-pid]"):null;p({kind:"pointer",x:e.clientX,y:e.clientY,pid:t?t.getAttribute("data-pid"):null})},true);
let hl=null,hp=null;const box=()=>{if(!hl)return;const el=hp&&document.querySelector('[data-pid="'+hp+'"]');const r=el&&el.getBoundingClientRect();if(!r||!r.width){hl.style.display="none";return}
Object.assign(hl.style,{display:"block",left:r.left-2+"px",top:r.top-2+"px",width:r.width+4+"px",height:r.height+4+"px"});};
addEventListener("message",(e)=>{const d=e.data;if(e.source!==parent||!d||d.kind!=="highlight")return;hp=typeof d.pid==="string"&&/^[a-z][a-z0-9-]{0,23}$/.test(d.pid)?d.pid:null;
if(!hl){hl=document.createElement("div");hl.setAttribute("aria-hidden","true");hl.style.cssText="position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2a74f5;border-radius:2px;display:none";document.documentElement.appendChild(hl)}
box();const el=hp&&document.querySelector('[data-pid="'+hp+'"]');const r=el&&el.getBoundingClientRect();p({kind:"rect",pid:hp,w:r?Math.round(r.width):0,h:r?Math.round(r.height):0})});
addEventListener("scroll",box,true);addEventListener("resize",box);
// Only scrollingElement scrolls the viewport. Body overflow can propagate to it, without making body a scroll container.
const room=(el,dx,dy)=>{const root=document.documentElement,body=document.body,scroller=document.scrollingElement,rs=getComputedStyle(root);
const fromBody=body&&getComputedStyle(body).display!=="none"&&rs.overflowX==="visible"&&rs.overflowY==="visible",vs=fromBody?getComputedStyle(body):rs;
for(let n=el instanceof Element?el:root;n;n=n.parentElement){const top=n===scroller;if(!top&&(n===root||(n===body&&fromBody)))continue;const cs=top?vs:getComputedStyle(n);
const sy=top?!/hidden|clip/.test(cs.overflowY):/auto|scroll|overlay/.test(cs.overflowY),sx=top?!/hidden|clip/.test(cs.overflowX):/auto|scroll|overlay/.test(cs.overflowX);
if(sy&&dy&&(dy>0?n.scrollTop+n.clientHeight<n.scrollHeight-1:n.scrollTop>0))return true;if(sx&&dx&&(dx>0?n.scrollLeft+n.clientWidth<n.scrollWidth-1:n.scrollLeft>0))return true}return false};
addEventListener("wheel",(e)=>{if(e.ctrlKey||e.metaKey){e.preventDefault();p({kind:"zoom",x:e.clientX,y:e.clientY,dy:e.deltaY,pinch:e.ctrlKey&&!e.metaKey});return}
const k=e.deltaMode===1?16:e.deltaMode===2?innerHeight:1,dx=e.deltaX*k,dy=e.deltaY*k;if(room(e.target,dx,dy))return;e.preventDefault();p({kind:"pan",dx,dy})},{passive:false,capture:true});
addEventListener("keydown",(e)=>{if(e.key==="Escape")p({kind:"escape"})},true);})();`;

