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

/** Runs inside the opaque child before any snapshot script. Posts only allowlisted shapes.
 *  The canvas drives piece editing: it says which pieces are selected, and may start or end a text edit on one. Selected
 *  pieces move by drag or arrow keys and one resizes by its handles; a drag from a group or the background draws a marquee.
 *  A piece in the page's flow moves by a relative offset, so the layout around it holds. The page only reports what happened. */
export const CHILD_BRIDGE = `(()=>{const p=(m)=>parent.postMessage(m,"*");
addEventListener("load",()=>p({kind:"ready"}));
addEventListener("error",(e)=>{if(e.target===window)p({kind:"error",message:String(e.message||"error").slice(0,200)})});
const PID=/^[a-z][a-z0-9-]{0,23}$/,at=(pid)=>pid?document.querySelector('[data-pid="'+pid+'"]'):null,piece=(t)=>t&&t.closest?t.closest("[data-pid]"):null,pidOf=(el)=>el.getAttribute("data-pid");
const free=(el)=>/absolute|fixed/.test(getComputedStyle(el).position),px=(v,d)=>{const n=parseFloat(v);return isFinite(n)?n:d};
// Table parts are placed by their table: they take text and styles, never a position or a size of their own.
const fixed=(el)=>/^(TD|TH|TR|TBODY|THEAD|TFOOT)$/.test(el.tagName);
const TOP="position:fixed;z-index:2147483647;pointer-events:none;display:none;",OUT=TOP+"box-sizing:border-box;border:0 solid #2a74f5;border-radius:2px";
const mk=(css,into)=>{const d=document.createElement("div");d.setAttribute("aria-hidden","true");d.style.cssText=css;(into||document.documentElement).appendChild(d);return d};
let zoom=1,sel=[],boxes=[],grips=null,mq=null,ed=null,was="",ring="",press=null,queued=false,nudged=null,nudgeTimer=0;
// The outline and handles keep their size on screen: k is page pixels per screen pixel at the canvas zoom.
const box=()=>{const k=1/zoom,o=1.5*k;sel.forEach((pid,i)=>{const b=boxes[i]||(boxes[i]=mk(OUT)),el=at(pid),r=el&&el.getBoundingClientRect();if(!r||!r.width){b.style.display="none";return}
Object.assign(b.style,{display:"block",borderWidth:o+"px",left:r.left-o+"px",top:r.top-o+"px",width:r.width+2*o+"px",height:r.height+2*o+"px"})});
for(let i=sel.length;i<boxes.length;i++)boxes[i].style.display="none";
if(boxes[0]&&!grips){grips=mk("position:absolute;inset:0;display:none",boxes[0]);
for(const d of ["nw","n","ne","e","se","s","sw","w"]){const g=mk("position:absolute;box-sizing:border-box;border:0 solid #2a74f5;background:#fff;pointer-events:auto;touch-action:none;cursor:"+d+"-resize;left:"+(d.includes("w")?0:d.includes("e")?100:50)+"%;top:"+(d.includes("n")?0:d.includes("s")?100:50)+"%",grips);g.dataset.grip=d}}
const one=sel.length===1?at(sel[0]):null;if(!grips)return;grips.style.display=one&&!ed&&!fixed(one)?"block":"none";grips.style.inset=-o+"px";
for(const g of grips.children)Object.assign(g.style,{width:9*k+"px",height:9*k+"px",margin:-4.5*k+"px",borderWidth:1.5*k+"px",borderRadius:2*k+"px"})};
const send=()=>{const el=sel.length===1?at(sel[0]):null,r=el&&el.getBoundingClientRect(),cs=el&&getComputedStyle(el);
p({kind:"rect",pid:el?sel[0]:null,x:r?r.left:0,y:r?r.top:0,w:r?Math.round(r.width):0,h:r?Math.round(r.height):0,size:cs?px(cs.fontSize,0):0,weight:cs?parseInt(cs.fontWeight)||400:0,italic:!!cs&&cs.fontStyle!=="normal",
align:cs?cs.textAlign:"",color:cs?cs.color:"",fill:cs?cs.backgroundColor:"",font:cs?cs.fontFamily:"",fit:cs?cs.objectFit:"",free:!!el&&free(el),
fonts:[...new Set([...document.fonts].map((f)=>String(f.family).replace(/["']/g,"")))].slice(0,12)})};
const follow=()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;box();if(sel.length)send()})};
// Where a piece starts a move or resize from, and how its position is written: left and top, absolute or as an offset.
const start=(el)=>{const cs=getComputedStyle(el),f=free(el);return{el,pid:pidOf(el),rel:!f,l:px(cs.left,f?el.offsetLeft:0),t:px(cs.top,f?el.offsetTop:0),w:px(cs.width,el.offsetWidth),h:px(cs.height,el.offsetHeight),moved:false,wide:false,tall:false}};
const starts=()=>sel.map(at).filter((el)=>el&&!fixed(el)).map(start);
const put=(s,l,t)=>{const st=s.el.style;if(s.rel&&getComputedStyle(s.el).position==="static")st.position="relative";st.left=Math.round(l)+"px";st.top=Math.round(t)+"px";if(!s.rel){st.right="auto";st.bottom="auto"}s.moved=true};
const report=(list)=>{p({kind:"move",items:list.map((s)=>({pid:s.pid,rel:s.rel,x:s.moved?px(s.el.style.left,0):null,y:s.moved?px(s.el.style.top,0):null,w:s.wide?px(s.el.style.width,0):null,h:s.tall?px(s.el.style.height,0):null}))});send()};
const finish=(keep)=>{const el=ed;if(!el)return;ed=null;el.removeEventListener("blur",blur);el.removeAttribute("contenteditable");el.style.outline=ring;
const text=el.textContent||"";if(!keep)el.textContent=was;p({kind:"text",pid:pidOf(el),text:keep&&text!==was?text.slice(0,20000):null});box();if(sel.length)send()};
const blur=()=>finish(true);
addEventListener("pointerdown",(e)=>{const t=piece(e.target),grip=e.target&&e.target.dataset?e.target.dataset.grip:null;
if(!grip)p({kind:"pointer",x:e.clientX,y:e.clientY,pid:t?pidOf(t):null,shift:e.shiftKey});
if(ed||e.button!==0)return;const at0={x:e.clientX,y:e.clientY,on:false};
if(grip){press={...at0,mode:"size",dir:grip,list:starts()};e.preventDefault()}
// A press on a group or on the background draws a marquee; on anything else it moves the selection once the press has selected it.
else if(!t||t.querySelector("[data-pid]"))press={...at0,mode:"marquee"};
else if(!fixed(t))press={...at0,mode:"move",pid:pidOf(t),list:null}},true);
addEventListener("pointermove",(e)=>{const d=press;if(!d)return;const dx=e.clientX-d.x,dy=e.clientY-d.y;
if(!d.on){if(Math.abs(dx)+Math.abs(dy)<4)return;if(d.mode==="move"){if(!sel.includes(d.pid))return;d.list=starts()}d.on=true;getSelection().removeAllRanges()}
e.preventDefault();
if(d.mode==="marquee"){if(!mq)mq=mk(TOP+"border:1px solid #2a74f5;background:rgba(42,116,245,.12)");
Object.assign(mq.style,{display:"block",left:Math.min(d.x,e.clientX)+"px",top:Math.min(d.y,e.clientY)+"px",width:Math.abs(dx)+"px",height:Math.abs(dy)+"px"});return}
for(const s of d.list){if(d.mode==="move"){put(s,s.l+dx,s.t+dy);continue}
const g=d.dir,st=s.el.style;if(/[ew]/.test(g)){st.width=Math.max(8,Math.round(s.w+(g.includes("w")?-dx:dx)))+"px";s.wide=true}
if(/[ns]/.test(g)){st.height=Math.max(8,Math.round(s.h+(g.includes("n")?-dy:dy)))+"px";s.tall=true}
if(/[nw]/.test(g))put(s,s.l+(g.includes("w")?dx:0),s.t+(g.includes("n")?dy:0))}box()},true);
const drop=(e)=>{const d=press;press=null;if(!d||!d.on)return;if(d.mode!=="marquee"){report(d.list);return}
mq.style.display="none";const x0=Math.min(d.x,e.clientX),y0=Math.min(d.y,e.clientY),x1=Math.max(d.x,e.clientX),y1=Math.max(d.y,e.clientY);
// Every piece wholly inside the marquee, without the pieces inside one already taken.
const inside=[...document.querySelectorAll("[data-pid]")].filter((el)=>{const r=el.getBoundingClientRect();return r.width>0&&r.left>=x0&&r.right<=x1&&r.top>=y0&&r.bottom<=y1});
p({kind:"select",pids:inside.filter((el)=>!inside.some((o)=>o!==el&&o.contains(el))).slice(0,50).map(pidOf)})};
addEventListener("pointerup",drop,true);addEventListener("pointercancel",drop,true);
addEventListener("dblclick",(e)=>{const t=piece(e.target);if(t&&!ed)p({kind:"dbl",pid:pidOf(t)})},true);
addEventListener("message",(e)=>{const d=e.data;if(e.source!==parent||!d)return;const pid=typeof d.pid==="string"&&PID.test(d.pid)?d.pid:null;
if(d.kind==="commit"){finish(true);return}
if(d.kind==="edit"){const el=at(pid);if(!el||ed)return;ed=el;was=el.textContent||"";ring=el.style.outline;el.style.outline="none";
try{el.contentEditable="plaintext-only"}catch(_){el.contentEditable="true"}el.focus();
const s=getSelection();if(!s.rangeCount||!el.contains(s.anchorNode)){const r=document.createRange();r.selectNodeContents(el);s.removeAllRanges();s.addRange(r)}
el.addEventListener("blur",blur);box();return}
if(d.kind!=="highlight")return;if(typeof d.zoom==="number"&&d.zoom>0.01)zoom=d.zoom;sel=Array.isArray(d.pids)?d.pids.filter((x)=>typeof x==="string"&&PID.test(x)).slice(0,50):[];box();send()});
addEventListener("scroll",follow,true);addEventListener("resize",follow);
// Only scrollingElement scrolls the viewport. Body overflow can propagate to it, without making body a scroll container.
const room=(el,dx,dy)=>{const root=document.documentElement,body=document.body,scroller=document.scrollingElement,rs=getComputedStyle(root);
const fromBody=body&&getComputedStyle(body).display!=="none"&&rs.overflowX==="visible"&&rs.overflowY==="visible",vs=fromBody?getComputedStyle(body):rs;
for(let n=el instanceof Element?el:root;n;n=n.parentElement){const top=n===scroller;if(!top&&(n===root||(n===body&&fromBody)))continue;const cs=top?vs:getComputedStyle(n);
const sy=top?!/hidden|clip/.test(cs.overflowY):/auto|scroll|overlay/.test(cs.overflowY),sx=top?!/hidden|clip/.test(cs.overflowX):/auto|scroll|overlay/.test(cs.overflowX);
if(sy&&dy&&(dy>0?n.scrollTop+n.clientHeight<n.scrollHeight-1:n.scrollTop>0))return true;if(sx&&dx&&(dx>0?n.scrollLeft+n.clientWidth<n.scrollWidth-1:n.scrollLeft>0))return true}return false};
addEventListener("wheel",(e)=>{if(e.ctrlKey||e.metaKey){e.preventDefault();p({kind:"zoom",x:e.clientX,y:e.clientY,dy:e.deltaY,pinch:e.ctrlKey&&!e.metaKey});return}
const k=e.deltaMode===1?16:e.deltaMode===2?innerHeight:1,dx=e.deltaX*k,dy=e.deltaY*k;if(room(e.target,dx,dy))return;e.preventDefault();p({kind:"pan",dx,dy})},{passive:false,capture:true});
addEventListener("keydown",(e)=>{if(ed){e.stopPropagation();if(e.key==="Escape"){e.preventDefault();finish(false)}else if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();finish(true)}return}
// Arrow keys nudge the selection, ten pixels with Shift. A run of presses is reported once it pauses, as one move.
const dir={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];
if(dir&&sel.length&&!e.metaKey&&!e.ctrlKey&&!e.altKey){e.preventDefault();e.stopPropagation();const k=e.shiftKey?10:1;
if(!nudged)nudged={list:starts(),x:0,y:0};nudged.x+=dir[0]*k;nudged.y+=dir[1]*k;for(const s of nudged.list)put(s,s.l+nudged.x,s.t+nudged.y);box();
clearTimeout(nudgeTimer);nudgeTimer=setTimeout(()=>{const n=nudged;nudged=null;if(n&&n.list.length)report(n.list)},350);return}
// The person's undo and redo belong to the canvas, which cannot see keys pressed in here.
if((e.metaKey||e.ctrlKey)&&!e.altKey&&e.key.toLowerCase()==="z"){e.preventDefault();p({kind:"history",redo:e.shiftKey});return}
if(e.key==="Escape")p({kind:"escape"})},true);})();`;
