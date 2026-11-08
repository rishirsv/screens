// Pieces: the addressable elements of an object's entry HTML. Pure: no I/O, no DOM, no dependency.
//
// The HTML stays the only source. A piece is an element carrying data-pid; its name and visibility are the data-name and
// data-hidden attributes. The tree is derived from the source every time it is needed, so nothing can drift from it.
// Edits splice only the bytes they change: what an agent wrote is what is stored, minus what it asked to change.

/** Elements that become pieces without being marked. Any element with a data-pid is a piece too. */
export const PIECE_TAGS: ReadonlySet<string> = new Set([
  "header", "footer", "main", "nav", "section", "article", "aside", "div", "form", "fieldset", "ul", "ol", "li", "dl", "table", "tr",
  "figure", "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "button", "img", "picture", "video", "audio", "canvas", "svg", "input",
  "textarea", "select", "label", "blockquote", "pre", "hr",
]);
export const PIECE_ATTR = "data-pid", NAME_ATTR = "data-name", HIDDEN_ATTR = "data-hidden";
/** Agent-chosen or stamped. "body" is the fixed root. */
export const PID = /^[a-z][a-z0-9-]{0,23}$/;
export const PIECE_NAME_MAX = 80;
export const EDITS_MAX = 100;
export const FRAGMENT_MAX = 500_000;
/** The rule every Screens render path injects (frames' inlineBundle), so data-hidden hides a piece. */
export const HIDDEN_RULE = `<style>[${HIDDEN_ATTR}]{display:none!important}</style>`;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title", "xmp"]);
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul"]);

// ── Tokenizer ──

interface Attr { readonly name: string; readonly value: string | null; readonly start: number; readonly end: number }
/** One element of the source. Offsets index the source text. An unclosed element was closed implicitly by the parser:
 *  its end is where the closer starts, so it can carry attributes but its extent is a guess. */
interface El {
  readonly tag: string; readonly start: number; readonly nameEnd: number; readonly openEnd: number;
  closeStart: number; end: number; unclosed: boolean;
  readonly attrs: readonly Attr[]; readonly children: El[]; readonly parent: El | null;
}
interface Parsed { readonly text: string; readonly root: El; readonly stray: number }

const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " })[e] ?? _m);
const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A forgiving HTML5-shaped parse: enough to find element extents and attributes, never a full tree builder. */
function parse(text: string): Parsed {
  const root: El = { tag: "#root", start: 0, nameEnd: 0, openEnd: 0, closeStart: text.length, end: text.length, unclosed: false, attrs: [], children: [], parent: null };
  const stack: El[] = [root];
  let stray = 0, i = 0;
  const top = () => stack[stack.length - 1]!;
  const closeImplicit = (at: number, el: El) => { el.closeStart = at; el.end = at; el.unclosed = true; };
  const popTo = (idx: number, at: number) => { while (stack.length - 1 > idx) closeImplicit(at, stack.pop()!); };
  const inForeign = () => stack.some((e) => e.tag === "svg" || e.tag === "math");
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    i = lt;
    if (text.startsWith("<!--", i)) { const e = text.indexOf("-->", i + 4); i = e < 0 ? text.length : e + 3; continue; }
    if (text[i + 1] === "!" || text[i + 1] === "?") { const e = text.indexOf(">", i); i = e < 0 ? text.length : e + 1; continue; }
    if (text[i + 1] === "/") {
      const m = /^<\/([a-zA-Z][\w:-]*)\s*>?/.exec(text.slice(i, i + 80));
      if (!m) { i++; continue; }
      const tag = m[1]!.toLowerCase(), gt = text.indexOf(">", i), end = gt < 0 ? text.length : gt + 1;
      let k = stack.length - 1;
      while (k > 0 && stack[k]!.tag !== tag) k--;
      if (k > 0) { popTo(k, i); const el = stack.pop()!; el.closeStart = i; el.end = end; el.unclosed = false; }
      else if (!["html", "head", "body", "br", "p"].includes(tag)) stray++;
      i = end; continue;
    }
    if (!/[a-zA-Z]/.test(text[i + 1] ?? "")) { i++; continue; }
    // Start tag: name, then attributes.
    let j = i + 1;
    while (j < text.length && !/[\s/>]/.test(text[j]!)) j++;
    const tag = text.slice(i + 1, j).toLowerCase(), nameEnd = j;
    const attrs: Attr[] = [];
    let selfClose = false;
    for (;;) {
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (j >= text.length) break;
      if (text[j] === ">") { j++; break; }
      if (text[j] === "/" ) { if (text[j + 1] === ">") { selfClose = true; j += 2; break; } j++; continue; }
      const as = j;
      while (j < text.length && !/[\s=/>]/.test(text[j]!)) j++;
      const name = text.slice(as, j).toLowerCase();
      let k = j; while (k < text.length && /\s/.test(text[k]!)) k++;
      let value: string | null = null;
      if (text[k] === "=") {
        k++; while (k < text.length && /\s/.test(text[k]!)) k++;
        const q = text[k];
        if (q === '"' || q === "'") { const e = text.indexOf(q, k + 1); value = text.slice(k + 1, e < 0 ? text.length : e); j = e < 0 ? text.length : e + 1; }
        else { const vs = k; while (k < text.length && !/[\s>]/.test(text[k]!)) k++; value = text.slice(vs, k); j = k; }
      }
      if (name) attrs.push({ name, value: value === null ? null : decode(value), start: as, end: j });
      else j++;
    }
    const openEnd = j;
    // Implied end tags for the common cases, so a list or paragraph without closers still nests right.
    const cur = () => top().tag;
    if (tag === "li") { const k = stack.findLastIndex((e) => e.tag === "li" || e.tag === "ul" || e.tag === "ol"); if (k > 0 && stack[k]!.tag === "li") { popTo(k, i); closeImplicit(i, stack.pop()!); } }
    else if (tag === "dt" || tag === "dd") { if (cur() === "dt" || cur() === "dd") closeImplicit(i, stack.pop()!); }
    else if (tag === "tr") { const k = stack.findLastIndex((e) => e.tag === "tr" || e.tag === "table"); if (k > 0 && stack[k]!.tag === "tr") { popTo(k, i); closeImplicit(i, stack.pop()!); } }
    else if (tag === "td" || tag === "th") { const k = stack.findLastIndex((e) => e.tag === "td" || e.tag === "th" || e.tag === "tr"); if (k > 0 && stack[k]!.tag !== "tr") { popTo(k, i); closeImplicit(i, stack.pop()!); } }
    else if (tag === "option") { if (cur() === "option") closeImplicit(i, stack.pop()!); }
    if (CLOSES_P.has(tag)) { const k = stack.findLastIndex((e) => e.tag === "p"); if (k > 0 && !stack.slice(k + 1).some((e) => !["span", "a", "b", "i", "em", "strong", "small"].includes(e.tag))) { popTo(k, i); closeImplicit(i, stack.pop()!); } }
    const el: El = { tag, start: i, nameEnd, openEnd, closeStart: openEnd, end: openEnd, unclosed: false, attrs, children: [], parent: top() };
    top().children.push(el);
    if (VOID.has(tag) || (selfClose && inForeign())) { i = openEnd; continue; }
    if (RAW.has(tag)) {
      const m = new RegExp(`</${tag}\\s*>`, "i").exec(text.slice(openEnd));
      if (m) { el.closeStart = openEnd + m.index; el.end = el.closeStart + m[0].length; } else { el.closeStart = text.length; el.end = text.length; el.unclosed = true; }
      i = el.end; continue;
    }
    stack.push(el);
    i = openEnd;
  }
  popTo(0, text.length);
  // Elements left open at the end of the document (html, body, a trailing p) extend to it.
  return { text, root, stray };
}

const attr = (el: El, name: string): string | null => { const a = el.attrs.find((x) => x.name === name); return a ? (a.value ?? "") : null; };

// ── Pieces ──

export type PieceKind = "box" | "text" | "image" | "control";
export interface PieceNode {
  readonly pid: string;
  readonly tag: string;
  readonly classes: readonly string[];
  readonly name: string | null;
  /** Short display text: the element's own text, an image's alt, a control's label. */
  readonly label: string;
  readonly kind: PieceKind;
  readonly hidden: boolean;
  /** Closed implicitly by the parser: it can be styled, renamed and hidden, but not moved, written into or removed. */
  readonly unclosed: boolean;
  /** True when it holds no child elements, so its text can be set directly. */
  readonly leaf: boolean;
  /** A leaf's whole text, decoded. Empty for a piece with child elements. */
  readonly text: string;
  /** The inline style attribute, as written. */
  readonly style: string;
  readonly children: readonly PieceNode[];
}

/** The body element, or the document when there is none. */
function bodyOf(p: Parsed): El {
  const find = (e: El): El | null => { if (e.tag === "body") return e; for (const c of e.children) { const f = find(c); if (f) return f; } return null; };
  return find(p.root) ?? p.root;
}
const isPiece = (e: El) => attr(e, PIECE_ATTR) !== null || PIECE_TAGS.has(e.tag);

function textOf(p: Parsed, e: El): string {
  const out: string[] = [];
  const walk = (x: El, from: number, to: number) => {
    let at = from;
    for (const c of x.children) {
      if (c.start >= to) break;
      out.push(p.text.slice(at, c.start), " ");
      if (!RAW.has(c.tag) || c.tag === "textarea") walk(c, c.openEnd, c.closeStart);
      out.push(" ");
      at = c.end;
    }
    out.push(p.text.slice(at, to));
  };
  walk(e, e.openEnd, e.closeStart);
  return decode(out.join("").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function labelOf(p: Parsed, e: El): string {
  const own = e.tag === "img" ? attr(e, "alt") ?? "" : e.tag === "input" ? attr(e, "placeholder") ?? attr(e, "value") ?? attr(e, "type") ?? "" : e.tag === "svg" ? attr(e, "aria-label") ?? "" : textOf(p, e);
  return own.length > 40 ? `${own.slice(0, 39)}…` : own;
}
const kindOf = (tag: string): PieceKind => (["img", "picture", "video", "audio", "canvas", "svg"].includes(tag) ? "image"
  : ["button", "input", "textarea", "select", "a", "label"].includes(tag) ? "control" : /^(h[1-6]|p|blockquote|pre)$/.test(tag) ? "text" : "box");

interface Indexed { readonly node: PieceNode; readonly el: El }
/** The piece tree under body, plus every piece by pid. An element without a pid is listed under a provisional one only
 *  until it is stamped; pieces inside an svg are not listed. */
function index(p: Parsed): { readonly root: PieceNode; readonly byPid: ReadonlyMap<string, Indexed>; readonly body: El } {
  const body = bodyOf(p);
  const byPid = new Map<string, Indexed>();
  let anon = 0;
  const build = (e: El, pid: string): PieceNode => {
    const kids: PieceNode[] = [];
    const visit = (x: El) => {
      for (const c of x.children) {
        if (RAW.has(c.tag) && c.tag !== "textarea") continue;
        if (isPiece(c)) kids.push(build(c, attr(c, PIECE_ATTR) ?? `?${anon++}`));
        else if (c.tag !== "svg" && c.tag !== "math") visit(c);
      }
    };
    if (e.tag !== "svg" && e.tag !== "math") visit(e);
    const node: PieceNode = { pid, tag: e === p.root ? "body" : e.tag, classes: (attr(e, "class") ?? "").split(/\s+/).filter(Boolean), name: attr(e, NAME_ATTR),
      label: labelOf(p, e), kind: kindOf(e.tag), hidden: attr(e, HIDDEN_ATTR) !== null, unclosed: e.unclosed, leaf: e.children.length === 0, text: e.children.length === 0 && !VOID.has(e.tag) ? textOf(p, e) : "", style: attr(e, "style") ?? "", children: kids };
    if (!byPid.has(pid)) byPid.set(pid, { node, el: e });
    return node;
  };
  return { root: build(body, "body"), byPid, body };
}

/** The piece tree of an entry HTML source. Pure. */
export function pieceTree(source: string): PieceNode { return index(parse(source)).root; }

/** Indented rows, one per piece: `pid tag.class [Name] "label" hidden`. depth counts levels below `from`. */
export function outline(root: PieceNode, o: { readonly from?: string; readonly depth?: number } = {}): string {
  const find = (n: PieceNode): PieceNode | null => { if (n.pid === o.from) return n; for (const c of n.children) { const f = find(c); if (f) return f; } return null; };
  const start = o.from ? find(root) : root;
  if (!start) return "";
  const rows: string[] = [];
  const walk = (n: PieceNode, d: number) => {
    rows.push(`${"  ".repeat(d)}${row(n)}`);
    if (o.depth === undefined || d < o.depth) for (const c of n.children) walk(c, d + 1);
  };
  walk(start, 0);
  return rows.join("\n");
}
export const row = (n: PieceNode) => `${n.pid} ${n.tag}${n.classes[0] ? `.${n.classes[0]}` : ""}${n.name ? ` [${n.name}]` : ""}${n.label ? ` ${JSON.stringify(n.label)}` : ""}${n.hidden ? " hidden" : ""}`;

/** One piece's source, as written. */
export function pieceSource(source: string, pid: string): string | null {
  const p = parse(source), hit = index(p).byPid.get(pid);
  return hit ? source.slice(hit.el.start, hit.el.end) : null;
}

/** The inline style declarations of a piece, in order. */
export function styleDeclarations(style: string): [string, string][] {
  const out: [string, string][] = [];
  for (const d of splitTop(style, ";")) {
    const c = d.indexOf(":");
    if (c > 0) out.push([d.slice(0, c).trim().toLowerCase(), d.slice(c + 1).trim()]);
  }
  return out;
}
function splitTop(s: string, sep: string): string[] {
  const out: string[] = []; let depth = 0, q: string | null = null, from = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch; else if (ch === "(") depth++; else if (ch === ")") depth--; else if (ch === sep && depth === 0) { out.push(s.slice(from, i)); from = i + 1; }
  }
  out.push(s.slice(from));
  return out.map((x) => x.trim()).filter(Boolean);
}

// ── Stamping ──

/** Gives every unmarked piece a data-pid and renames duplicate or malformed ones. idFor(n) proposes the n-th new id;
 *  the first that is unused wins, so a replay with the same seed stamps the same ids. */
export function stamp(source: string, idFor: (n: number) => string): { readonly source: string; readonly stamped: readonly string[]; readonly renumbered: readonly { readonly asked: string; readonly got: string }[]; readonly at: ReadonlyMap<number, string> } {
  const p = parse(source), { body } = index(p);
  const all: El[] = [];
  const walk = (e: El, inForeign: boolean) => {
    for (const c of e.children) {
      if (RAW.has(c.tag) && c.tag !== "textarea") continue;
      if (!inForeign && isPiece(c)) all.push(c);
      walk(c, inForeign || c.tag === "svg" || c.tag === "math");
    }
  };
  walk(body, false);
  const used = new Set<string>(["body"]);
  const keep = new Set<El>();
  for (const e of all) { const v = attr(e, PIECE_ATTR); if (v !== null && PID.test(v) && !used.has(v)) { used.add(v); keep.add(e); } }
  let n = 0;
  const fresh = () => { for (;;) { const id = idFor(n++); if (PID.test(id) && !used.has(id)) { used.add(id); return id; } } };
  const splices: { at: number; end: number; text: string }[] = [];
  const stamped: string[] = [], renumbered: { asked: string; got: string }[] = [], at = new Map<number, string>();
  for (const e of all) {
    if (keep.has(e)) continue;
    const id = fresh(), had = e.attrs.find((a) => a.name === PIECE_ATTR);
    at.set(e.start, id);
    if (had) { splices.push({ at: had.start, end: had.end, text: `${PIECE_ATTR}="${id}"` }); renumbered.push({ asked: had.value ?? "", got: id }); }
    else splices.push({ at: e.nameEnd, end: e.nameEnd, text: ` ${PIECE_ATTR}="${id}"` });
    stamped.push(id);
  }
  return { source: applySplices(source, splices), stamped, renumbered, at };
}

function applySplices(text: string, splices: readonly { at: number; end: number; text: string }[]): string {
  let out = text;
  for (const s of [...splices].sort((a, b) => b.at - a.at)) out = out.slice(0, s.at) + s.text + out.slice(s.end);
  return out;
}

// ── Edits ──

/** Where a target is: a pid, or a query that must match exactly one piece (or every match with all: true). */
export interface PieceQuery { readonly tag?: string; readonly class?: string; readonly text?: string; readonly name?: string; readonly in?: string }
export type Target = string | PieceQuery;
export type Place = { readonly before: Target } | { readonly after: Target } | { readonly into: Target; readonly pos?: "start" | "end" };

/** One edit. Property changes (style, text, name, hidden, move) combine; write, remove and find each stand alone. */
export interface EditInput {
  readonly at?: Target;
  readonly all?: boolean;
  /** CSS property → value, or null to remove it. Written to the piece's inline style. */
  readonly style?: Readonly<Record<string, string | null>>;
  readonly text?: string;
  readonly name?: string | null;
  readonly hidden?: boolean;
  readonly move?: Place;
  /** HTML to insert. pos is relative to `at` (default: the end of body). */
  readonly write?: string;
  readonly pos?: "start" | "end" | "before" | "after" | "inner" | "replace";
  readonly remove?: true;
  /** Exact text to replace in one file of the bundle (default: the entry). Must occur once, or all: true. */
  readonly find?: string;
  readonly replace?: string;
  readonly file?: string;
}

/** What one editObject did, kept in the receipt so a replay returns the same. */
export interface ObjectDelta {
  readonly itemId: string;
  readonly contentVersion: string;
  /** Pieces each edit resolved to, by edit index. */
  readonly resolved: readonly (readonly string[])[];
  /** Rows of the pieces that changed or were added, in tree order. */
  readonly changed: string;
  readonly removed: readonly string[];
  readonly renumbered: readonly { readonly asked: string; readonly got: string }[];
  /** Whether the result can be saved without the pre-commit load check. */
  readonly inert: boolean;
}

/** A recorded change, so undo restores one field and only if it still holds what this edit wrote. */
export type PieceStep =
  | { readonly k: "style"; readonly pid: string; readonly prop: string; readonly before: string | null; readonly after: string | null }
  | { readonly k: "attr"; readonly pid: string; readonly attr: typeof NAME_ATTR | typeof HIDDEN_ATTR; readonly before: string | null; readonly after: string | null }
  | { readonly k: "text"; readonly pid: string; readonly before: string; readonly after: string }
  | { readonly k: "inner"; readonly pid: string; readonly before: string; readonly after: string }
  | { readonly k: "place"; readonly pid: string; readonly before: Anchor; readonly after: Anchor }
  /** A subtree created (before null) or removed (after null). html is its source. */
  | { readonly k: "node"; readonly pid: string; readonly before: { readonly html: string; readonly at: Anchor; readonly direct: boolean } | null; readonly after: { readonly html: string; readonly at: Anchor; readonly direct: boolean } | null }
  | { readonly k: "file"; readonly path: string; readonly before: string; readonly after: string };
/** A position: inside `parent`, right after the piece `prev` (null: first). */
export interface Anchor { readonly parent: string; readonly prev: string | null }

export class PieceError extends Error {
  readonly code: "invalid" | "not-found" | "conflict" | "limit";
  readonly matches: string | undefined;
  constructor(code: PieceError["code"], message: string, matches?: string) { super(message); this.code = code; this.matches = matches; }
}
const bad = (message: string, code: PieceError["code"] = "invalid", matches?: string): never => { throw new PieceError(code, message, matches); };

/** The files an edit list can change, and their text. */
export interface Files { entry: string; readonly texts: Map<string, string> }

/** Applies `edits` in order, each against the result of the last, so targets resolve against the newest source.
 *  Throws PieceError. Pure. */
export function applyEdits(files: Files, edits: readonly EditInput[], idFor: (n: number) => string, o: { readonly allowEmpty?: boolean } = {}):
  { readonly steps: readonly PieceStep[]; readonly resolved: string[][]; readonly touched: Set<string>; readonly removed: string[]; readonly renumbered: { asked: string; got: string }[] } {
  if (!Array.isArray(edits) || (edits.length === 0 && !o.allowEmpty)) bad("edits must be a non-empty list");
  if (edits.length > EDITS_MAX) bad(`at most ${EDITS_MAX} edits per call`, "limit");
  const steps: PieceStep[] = [], resolved: string[][] = [], touched = new Set<string>(), removed: string[] = [], renumbered: { asked: string; got: string }[] = [];
  let n = 0;
  const ids = () => idFor(n++);
  // Unmarked pieces get ids before anything resolves, so every pid an edit returns is a real one.
  const restamp = () => { const s = stamp(entryText(files), ids); setEntry(files, s.source); renumbered.push(...s.renumbered); return s; };
  // An object saved before it had pids lists its pieces as ?0, ?1, …: translate those to the ids the first stamp gives them.
  const first = parse(entryText(files)), provisional = new Map<string, number>();
  for (const [pid, x] of index(first).byPid) if (pid.startsWith("?")) provisional.set(pid, x.el.start);
  const s0 = restamp();
  const real = (t: Target | undefined): Target | undefined => {
    if (typeof t !== "string" || !t.startsWith("?")) return t;
    const start = provisional.get(t); const id = start === undefined ? undefined : s0.at.get(start);
    return id ?? bad(`no piece ${t}`, "not-found");
  };
  const translate = (e: EditInput): EditInput => {
    if (!e || typeof e !== "object") return e;
    let out: EditInput = e.at === undefined ? e : { ...e, at: real(e.at) };
    const m = e.move as Record<string, Target> | undefined;
    if (m && typeof m === "object") out = { ...out, move: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, k === "pos" ? v : real(v)])) as unknown as Place };
    return out;
  };
  edits.forEach((e0, i) => {
    let e = e0;
    try { e = translate(e0); } catch (err) { if (err instanceof PieceError) throw new PieceError(err.code, `edit ${i}: ${err.message}`); throw err; }
    try { resolved.push(applyOne(files, e, steps, touched, removed, restamp)); }
    catch (err) { if (err instanceof PieceError) throw new PieceError(err.code, `edit ${i}: ${err.message}`, err.matches); throw err; }
  });
  return { steps, resolved, touched, removed, renumbered };
}

const entryText = (f: Files) => f.texts.get(f.entry) ?? bad(`the entry ${f.entry} is not a text file`);
const setEntry = (f: Files, text: string) => { f.texts.set(f.entry, text); };

function resolve(p: Parsed, t: Target | undefined, all: boolean): Indexed[] {
  const { byPid } = index(p);
  if (t === undefined) return [byPid.get("body")!];
  if (typeof t === "string") {
    const hit = byPid.get(t);
    return hit ? [hit] : bad(`no piece ${t}`, "not-found");
  }
  if (!t || typeof t !== "object") bad("at must be a pid or a query");
  const scope = t.in ? byPid.get(t.in) ?? bad(`no piece ${t.in}`, "not-found") : byPid.get("body")!;
  const out: Indexed[] = [];
  const want = (n: PieceNode) => (!t.tag || n.tag === t.tag.toLowerCase()) && (!t.class || n.classes.includes(t.class))
    && (!t.name || n.name === t.name) && (!t.text || n.label.toLowerCase().includes(t.text.toLowerCase()));
  const walk = (n: PieceNode) => { for (const c of n.children) { if (want(c)) out.push(byPid.get(c.pid)!); walk(c); } };
  walk(scope.node);
  if (!t.tag && !t.class && !t.text && !t.name) bad("a query needs tag, class, text or name");
  if (out.length === 0) bad("the query matches no piece", "not-found");
  if (out.length > 1 && !all) bad(`the query matches ${out.length} pieces; name one by pid or pass all: true`, "invalid", out.map((x) => row(x.node)).join("\n"));
  return out;
}

type Index = ReturnType<typeof index>;
const anchorOf = (p: Parsed, el: El): Anchor => {
  const ix = index(p);
  const parentPid = anchorParent(p, el, ix);
  // The nearest earlier piece inside the same parent piece, in document order.
  let prev: string | null = null;
  for (const [pid, x] of ix.byPid) {
    if (pid === "body" || x.el.end > el.start) continue;
    if (anchorParent(p, x.el, ix) === parentPid) prev = pid;
  }
  return { parent: parentPid, prev };
};
function anchorParent(p: Parsed, el: El, ix: Index = index(p)): string {
  const { byPid, body } = ix;
  let parent = el.parent;
  while (parent && parent !== body && !(attr(parent, PIECE_ATTR) && byPid.has(attr(parent, PIECE_ATTR)!))) parent = parent.parent;
  return !parent || parent === body ? "body" : attr(parent, PIECE_ATTR)!;
}
/** The offset an anchor names in the current source. */
function offsetOf(p: Parsed, a: Anchor): number {
  const ix = index(p), { byPid } = ix;
  if (a.prev) { const prev = byPid.get(a.prev); if (prev && anchorParent(p, prev.el, ix) === a.parent) return prev.el.end; }
  const parent = byPid.get(a.parent) ?? bad(`piece ${a.parent} is gone`, "conflict");
  if (parent.el.unclosed) bad(`piece ${a.parent} has no closing tag`, "conflict");
  return parent.el.openEnd;
}

function checkFragment(html: string): void {
  if (typeof html !== "string" || html.trim() === "") bad("write needs HTML");
  if (html.length > FRAGMENT_MAX) bad(`write is limited to ${FRAGMENT_MAX} characters`, "limit");
  const p = parse(html);
  const unclosed: string[] = [];
  const walk = (e: El) => { for (const c of e.children) { if (c.unclosed && !["p", "li", "dt", "dd", "tr", "td", "th", "option"].includes(c.tag)) unclosed.push(c.tag); walk(c); } };
  walk(p.root);
  if (p.stray || unclosed.length) bad(`write must be balanced HTML${unclosed.length ? ` (unclosed <${unclosed[0]}>)` : ""}`);
  if (/<\/?(html|head|body)\b/i.test(html)) bad("write cannot contain html, head or body tags; write into body instead");
}

function applyOne(f: Files, e: EditInput, steps: PieceStep[], touched: Set<string>, removed: string[], restamp: () => unknown): string[] {
  if (!e || typeof e !== "object") bad("an edit must be an object");
  const props = e.style !== undefined || e.text !== undefined || e.name !== undefined || e.hidden !== undefined || e.move !== undefined;
  const kinds = [props, e.write !== undefined, e.remove !== undefined, e.find !== undefined].filter(Boolean).length;
  if (kinds === 0) bad("an edit needs style, text, name, hidden, move, write, remove or find");
  if (kinds > 1) bad("write, remove and find each stand alone in an edit");

  if (e.find !== undefined) {
    const path = e.file ?? f.entry;
    const cur = f.texts.get(path) ?? bad(`no text file ${path} in the object`, "not-found");
    if (typeof e.find !== "string" || e.find === "" || typeof e.replace !== "string") bad("find needs a non-empty find and a replace string");
    const count = cur.split(e.find).length - 1;
    if (count === 0) bad("find matches nothing", "not-found");
    if (count > 1 && !e.all) bad(`find matches ${count} places; give more context or pass all: true`);
    const next = e.all ? cur.split(e.find).join(e.replace!) : cur.replace(e.find, () => e.replace!);
    f.texts.set(path, next);
    // Stamp first, so undo compares against what is actually stored.
    if (path === f.entry) restamp();
    steps.push({ k: "file", path, before: cur, after: f.texts.get(path)! });
    return [];
  }

  let p = parse(entryText(f));
  if (e.write !== undefined) {
    checkFragment(e.write);
    const mark = steps.length, before = p.text;
    const created = writeFragment(f, p, { ...e, write: e.write }, steps, touched, removed, restamp);
    // Undo by piece only when the fragment is nothing but pieces and a replaced piece sat directly in its parent piece;
    // otherwise text or wrappers would be left behind or put back in the wrong place, so guard the whole entry instead.
    const pure = onlyPieces(e.write) && !(e.pos === "replace" && steps.slice(mark).some((s) => s.k === "node" && s.after === null && !s.before!.direct));
    if (!pure) { steps.splice(mark); steps.push({ k: "file", path: f.entry, before, after: entryText(f) }); }
    return created;
  }
  return applyProps(f, p, e, steps, touched, removed);
}

/** True when a fragment is only piece elements, with nothing but whitespace between them. */
function onlyPieces(html: string): boolean {
  const p = parse(html);
  let at = 0;
  for (const c of p.root.children) {
    if (p.text.slice(at, c.start).trim() !== "" || !isPiece(c)) return false;
    at = c.end;
  }
  return p.text.slice(at).trim() === "" && p.root.children.length > 0;
}

/** Whether an element sits directly inside its anchor parent (a piece or body), so an anchor puts it back exactly. */
function direct(p: Parsed, el: El): boolean {
  const ix = index(p), parent = anchorParent(p, el, ix);
  return el.parent === (parent === "body" ? ix.body : ix.byPid.get(parent)?.el);
}

function writeFragment(f: Files, p: Parsed, e: EditInput & { write: string }, steps: PieceStep[], touched: Set<string>, removed: string[], restamp: () => unknown): string[] {
  {
    const pos = e.pos ?? "end";
    if (!["start", "end", "before", "after", "inner", "replace"].includes(pos)) bad("pos must be start, end, before, after, inner or replace");
    const [t] = resolve(p, e.at, false);
    const el = t!.el, pid = t!.node.pid;
    if ((pos === "before" || pos === "after" || pos === "replace") && pid === "body") bad(`cannot write ${pos} body`);
    if (el.unclosed && pos !== "before") bad(`piece ${pid} has no closing tag; write before or after it`);
    if (pos === "inner") {
      const before = p.text.slice(el.openEnd, el.closeStart);
      setEntry(f, p.text.slice(0, el.openEnd) + e.write + p.text.slice(el.closeStart));
      restamp();
      steps.push({ k: "inner", pid, before, after: innerOf(f, pid) });
      touched.add(pid);
      return [pid];
    }
    const prevPids = new Set(index(p).byPid.keys());
    if (pos === "replace") {
      const at = anchorOf(p, el), html = p.text.slice(el.start, el.end);
      for (const x of descendants(p, pid)) removed.push(x);
      steps.push({ k: "node", pid, before: { html, at, direct: direct(p, el) }, after: null });
      setEntry(f, p.text.slice(0, el.start) + e.write + p.text.slice(el.end));
    } else {
      const off = pos === "start" ? el.openEnd : pos === "end" ? el.closeStart : pos === "before" ? el.start : el.end;
      setEntry(f, p.text.slice(0, off) + e.write + p.text.slice(off));
    }
    restamp();
    p = parse(entryText(f));
    const ix = index(p), { byPid } = ix;
    // Each new top-level piece is one created node, so undo removes exactly what this write added.
    const created: string[] = [];
    for (const [id, x] of byPid) if (!prevPids.has(id) || removed.includes(id)) {
      const parentPid = anchorParent(p, x.el, ix);
      if (prevPids.has(parentPid) && !removed.includes(parentPid) || parentPid === "body") created.push(id);
      touched.add(id);
    }
    for (const id of created) { const x = byPid.get(id)!; steps.push({ k: "node", pid: id, before: null, after: { html: p.text.slice(x.el.start, x.el.end), at: anchorOf(p, x.el), direct: true } }); }
    return created;
  }
}

function applyProps(f: Files, p: Parsed, e: EditInput, steps: PieceStep[], touched: Set<string>, removed: string[]): string[] {
  if (e.at === undefined) bad("this edit needs at: a pid or a query");
  const targets = resolve(p, e.at, !!e.all);
  const pids = targets.map((t) => t.node.pid);

  if (e.remove !== undefined) {
    if (e.remove !== true) bad("remove must be true");
    for (const pid of pids) {
      p = parse(entryText(f));
      const x = index(p).byPid.get(pid) ?? bad(`no piece ${pid}`, "not-found");
      if (pid === "body") bad("cannot remove body");
      if (x.el.unclosed) bad(`piece ${pid} has no closing tag; it cannot be removed`);
      for (const d of descendants(p, pid)) removed.push(d);
      const next = p.text.slice(0, x.el.start) + p.text.slice(x.el.end);
      steps.push(direct(p, x.el) ? { k: "node", pid, before: { html: p.text.slice(x.el.start, x.el.end), at: anchorOf(p, x.el), direct: true }, after: null }
        : { k: "file", path: f.entry, before: p.text, after: next });
      setEntry(f, next);
    }
    return pids;
  }

  for (const pid of pids) {
    if (e.style !== undefined) {
      if (!e.style || typeof e.style !== "object" || Array.isArray(e.style)) bad("style must be an object of property → value or null");
      for (const [prop0, value] of Object.entries(e.style)) {
        const prop = prop0.trim().toLowerCase();
        if (!/^-{0,2}[a-z][a-z0-9-]*$/.test(prop)) bad(`bad CSS property ${prop0}`);
        if (value !== null && (typeof value !== "string" || value.trim() === "" || /[;{}<]/.test(value))) bad(`bad value for ${prop}`);
        p = parse(entryText(f));
        const x = index(p).byPid.get(pid)!;
        const decls = styleDeclarations(attr(x.el, "style") ?? "");
        const i = decls.findIndex(([k]) => k === prop);
        const before = i >= 0 ? decls[i]![1] : null, after = value === null ? null : value.trim();
        if (before === after) continue;
        if (after === null) decls.splice(i, 1); else if (i >= 0) decls[i] = [prop, after]; else decls.push([prop, after]);
        setEntry(f, setAttr(p, x.el, "style", decls.length ? decls.map(([k, v]) => `${k}: ${v}`).join("; ") : null));
        steps.push({ k: "style", pid, prop, before, after }); touched.add(pid);
      }
    }
    if (e.text !== undefined) {
      if (typeof e.text !== "string") bad("text must be a string");
      p = parse(entryText(f));
      const x = index(p).byPid.get(pid)!;
      if (!x.node.leaf) bad(`piece ${pid} holds other elements; write its inner HTML instead`);
      if (x.el.unclosed || VOID.has(x.el.tag)) bad(`piece ${pid} has no text content to set`);
      const before = p.text.slice(x.el.openEnd, x.el.closeStart), after = escText(e.text);
      if (before !== after) {
        setEntry(f, p.text.slice(0, x.el.openEnd) + after + p.text.slice(x.el.closeStart));
        steps.push({ k: "text", pid, before, after }); touched.add(pid);
      }
    }
    if (e.name !== undefined) {
      if (e.name !== null && (typeof e.name !== "string" || e.name.trim() === "" || e.name.trim().length > PIECE_NAME_MAX)) bad(`name must be 1-${PIECE_NAME_MAX} characters, or null to clear it`);
      setAttrStep(f, pid, NAME_ATTR, e.name === null ? null : e.name.trim(), steps, touched);
    }
    if (e.hidden !== undefined) {
      if (typeof e.hidden !== "boolean") bad("hidden must be true or false");
      if (pid === "body") bad("cannot hide body");
      setAttrStep(f, pid, HIDDEN_ATTR, e.hidden ? "" : null, steps, touched);
    }
    if (e.move !== undefined) movePiece(f, pid, e.move, steps, touched);
  }
  return pids;
}

function setAttrStep(f: Files, pid: string, name: typeof NAME_ATTR | typeof HIDDEN_ATTR, value: string | null, steps: PieceStep[], touched: Set<string>) {
  const p = parse(entryText(f));
  const x = index(p).byPid.get(pid)!;
  const before = attr(x.el, name);
  if (before === value) return;
  setEntry(f, setAttr(p, x.el, name, value));
  steps.push({ k: "attr", pid, attr: name, before, after: value }); touched.add(pid);
}

function setAttr(p: Parsed, el: El, name: string, value: string | null): string {
  const a = el.attrs.find((x) => x.name === name);
  const t = p.text;
  if (a) {
    // Removing takes the whitespace before it too, so the tag reads as if the attribute was never there.
    if (value === null) { let s = a.start; while (s > el.nameEnd && /\s/.test(t[s - 1]!)) s--; return t.slice(0, s) + t.slice(a.end); }
    return t.slice(0, a.start) + `${name}="${escAttr(value)}"` + t.slice(a.end);
  }
  if (value === null) return t;
  // After the last attribute, so the tag keeps its shape.
  const at = el.attrs.length ? el.attrs[el.attrs.length - 1]!.end : el.nameEnd;
  return t.slice(0, at) + ` ${name}="${escAttr(value)}"` + t.slice(at);
}

function movePiece(f: Files, pid: string, place: Place, steps: PieceStep[], touched: Set<string>) {
  if (pid === "body") bad("cannot move body");
  let p = parse(entryText(f));
  const x = index(p).byPid.get(pid)!;
  if (x.el.unclosed) bad(`piece ${pid} has no closing tag; it cannot be moved`);
  if (!place || typeof place !== "object") bad("move needs before, after or into");
  const ref = "before" in place ? place.before : "after" in place ? place.after : "into" in place ? place.into : bad("move needs before, after or into");
  const [dest] = resolve(p, ref, false);
  const d = dest!;
  if (d.el.start >= x.el.start && d.el.end <= x.el.end) bad(`cannot move ${pid} into itself`);
  if ("into" in place && (d.el.unclosed || VOID.has(d.el.tag))) bad(`cannot move into ${d.node.pid}`);
  if (!("into" in place) && d.node.pid === "body") bad("cannot move before or after body");
  const before = anchorOf(p, x.el), wasDirect = direct(p, x.el), text0 = p.text;
  const off = "before" in place ? d.el.start : "after" in place ? d.el.end : place.pos === "start" ? d.el.openEnd : d.el.closeStart;
  // Already there.
  if (off === x.el.start || off === x.el.end) return;
  const html = p.text.slice(x.el.start, x.el.end);
  const cut = p.text.slice(0, x.el.start) + p.text.slice(x.el.end);
  const at = off > x.el.start ? off - (x.el.end - x.el.start) : off;
  setEntry(f, cut.slice(0, at) + html + cut.slice(at));
  p = parse(entryText(f));
  const moved = index(p).byPid.get(pid)!.el, after = anchorOf(p, moved);
  steps.push(wasDirect && direct(p, moved) ? { k: "place", pid, before, after } : { k: "file", path: f.entry, before: text0, after: entryText(f) });
  touched.add(pid);
}

function descendants(p: Parsed, pid: string): string[] {
  const { byPid } = index(p);
  const x = byPid.get(pid);
  if (!x) return [];
  return [...byPid].filter(([, y]) => y.el.start >= x.el.start && y.el.end <= x.el.end).map(([id]) => id);
}
function innerOf(f: Files, pid: string): string {
  const p = parse(entryText(f)), x = index(p).byPid.get(pid)!;
  return p.text.slice(x.el.openEnd, x.el.closeStart);
}

/** Undoes `steps` (newest first) if every touched field still holds what the steps wrote. Throws PieceError("conflict").
 *  Returns the steps that redo it. Pure. */
export function restoreSteps(f: Files, steps: readonly PieceStep[]): PieceStep[] {
  const redo: PieceStep[] = [];
  for (const s of [...steps].reverse()) {
    if (s.k === "file") {
      const cur = f.texts.get(s.path);
      if (cur !== s.after) bad(`${s.path} changed since this edit`, "conflict");
      f.texts.set(s.path, s.before);
      redo.push({ ...s, before: s.after, after: s.before });
      continue;
    }
    const p = parse(entryText(f));
    const { byPid } = index(p);
    const x = byPid.get(s.pid);
    if (s.k === "node") {
      if (s.after === null) {
        if (x) bad(`piece ${s.pid} exists again`, "conflict");
        const off = offsetOf(p, s.before!.at);
        setEntry(f, p.text.slice(0, off) + s.before!.html + p.text.slice(off));
      } else {
        if (!x || p.text.slice(x.el.start, x.el.end) !== s.after.html) bad(`piece ${s.pid} changed since this edit`, "conflict");
        setEntry(f, p.text.slice(0, x!.el.start) + p.text.slice(x!.el.end));
        if (s.before) { const q = parse(entryText(f)); const off = offsetOf(q, s.before.at); setEntry(f, q.text.slice(0, off) + s.before.html + q.text.slice(off)); }
      }
      redo.push({ ...s, before: s.after, after: s.before });
      continue;
    }
    if (!x) bad(`piece ${s.pid} was removed since this edit`, "conflict");
    const el = x!.el;
    if (s.k === "style") {
      const decls = styleDeclarations(attr(el, "style") ?? "");
      const i = decls.findIndex(([k]) => k === s.prop);
      if ((i >= 0 ? decls[i]![1] : null) !== s.after) bad(`piece ${s.pid}'s ${s.prop} changed since this edit`, "conflict");
      if (s.before === null) decls.splice(i, 1); else if (i >= 0) decls[i] = [s.prop, s.before]; else decls.push([s.prop, s.before]);
      setEntry(f, setAttr(p, el, "style", decls.length ? decls.map(([k, v]) => `${k}: ${v}`).join("; ") : null));
    } else if (s.k === "attr") {
      if (attr(el, s.attr) !== s.after) bad(`piece ${s.pid} changed since this edit`, "conflict");
      setEntry(f, setAttr(p, el, s.attr, s.before));
    } else if (s.k === "text" || s.k === "inner") {
      if (p.text.slice(el.openEnd, el.closeStart) !== s.after) bad(`piece ${s.pid}'s content changed since this edit`, "conflict");
      setEntry(f, p.text.slice(0, el.openEnd) + s.before + p.text.slice(el.closeStart));
    } else if (s.k === "place") {
      const now = anchorOf(p, el);
      if (now.parent !== s.after.parent || now.prev !== s.after.prev) bad(`piece ${s.pid} moved since this edit`, "conflict");
      const html = p.text.slice(el.start, el.end);
      setEntry(f, p.text.slice(0, el.start) + p.text.slice(el.end));
      const q = parse(entryText(f)), off = offsetOf(q, s.before);
      setEntry(f, q.text.slice(0, off) + html + q.text.slice(off));
    }
    redo.push({ ...s, before: s.after, after: s.before } as PieceStep);
  }
  return redo;
}

// ── Load-check class ──

/** "inert" when nothing in the bundle can run or fetch: no scripts, handlers, frames, links, meta refresh, base or custom
 *  elements. Such a page always reaches load, so an edit to it can commit before Chrome sees it. Pure. */
export function checkClassOf(entrySource: string, manifest: Readonly<Record<string, { readonly mediaType: string }>>): "inert" | "load" {
  for (const [path, a] of Object.entries(manifest)) if (/javascript|ecmascript|wasm/i.test(a.mediaType) || /\.(m?js|wasm)$/i.test(path)) return "load";
  const t = entrySource;
  if (/<script\b/i.test(t) || /<(iframe|frame|frameset|object|embed|base|portal|link|applet)\b/i.test(t)) return "load";
  if (/<meta\b[^>]*http-equiv/i.test(t)) return "load";
  if (/\son[a-z]+\s*=/i.test(t) || /javascript:/i.test(t)) return "load";
  if (/<[a-z][a-z0-9]*-[a-z0-9-]*[\s/>]/i.test(t)) return "load";
  return "inert";
}

/** Whether a manifest entry is text the piece model reads or find/replace edits. */
export const isTextMedia = (mediaType: string): boolean => /^text\/|svg|json|xml|javascript/i.test(mediaType);
