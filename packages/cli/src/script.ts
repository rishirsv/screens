// The screens-cli language: one step per line. A single command is a one-line script.
// VERBS is the only command list; the parser, help and coverage derive from it. Any other first word is an MCP tool.

import type { Fault } from "@screens/client";
import type { Handle } from "../../canvas/src/engine/index.ts";

export interface Point { readonly x: number; readonly y: number }
/** `@name` (an alias bound with as=) or `@3f2a…` (a unique ID prefix, four or more characters). Resolved at execution. */
export type Ref = { readonly kind: "ref"; readonly name: string };

export type Target =
  | { readonly kind: "ref"; readonly ref: Ref; readonly part: "surface" | "title" | "focus" | "row" | Handle; readonly offset: Point | null }
  | { readonly kind: "background"; readonly at: Point | null }
  | { readonly kind: "world"; readonly at: Point }
  | { readonly kind: "ui"; readonly label: string };
export type Destination = { readonly kind: "to"; readonly target: Target } | { readonly kind: "by"; readonly delta: Point };
export interface Mods { readonly shift: boolean; readonly mod: boolean; readonly alt: boolean }

export type PersonAction =
  | { readonly verb: "click"; readonly target: Target; readonly mods: Mods; readonly double: boolean }
  | { readonly verb: "drag"; readonly from: Target; readonly dest: Destination; readonly mods: Mods; readonly steps: number; readonly button: "left" | "middle"; readonly space: boolean }
  | { readonly verb: "press"; readonly target: Target; readonly mods: Mods; readonly button: "left" | "middle" }
  | { readonly verb: "move"; readonly dest: Destination; readonly steps: number }
  | { readonly verb: "release" }
  | { readonly verb: "cancel" }
  | { readonly verb: "draw"; readonly from: Target; readonly path: readonly Point[]; readonly pen: boolean; readonly pressure: number | null }
  | { readonly verb: "wheel"; readonly delta: Point; readonly at: Target | null; readonly zoom: "cmd" | "pinch" | null }

  | { readonly verb: "key"; readonly combos: readonly string[] }
  | { readonly verb: "type"; readonly text: string }
  | { readonly verb: "tool"; readonly tool: string }
  | { readonly verb: "pencil"; readonly what: "color" | "size"; readonly value: string }
  | { readonly verb: "zoom"; readonly how: "in" | "out" | "100" }
  | { readonly verb: "fit" }
  | { readonly verb: "focus"; readonly target: Target }
  | { readonly verb: "exit-focus" }
  | { readonly verb: "undo" } | { readonly verb: "redo" } | { readonly verb: "delete" }
  | { readonly verb: "theme"; readonly theme: "light" | "dark" }
  | { readonly verb: "invert-scroll"; readonly on: boolean }
  | { readonly verb: "edit-title"; readonly target: Target; readonly text: string }
  | { readonly verb: "rename-screen"; readonly text: string }
  | { readonly verb: "toast"; readonly button: "retry" | "dismiss" }
  /** Files are `fixture:NAME` (fixtures.ts FILE_FIXTURES) or paths. A real CDP drag that carries the files. */
  | { readonly verb: "drop"; readonly files: readonly string[]; readonly at: Target }
  /** Puts one image file on the page's clipboard, then presses Mod+v. */
  | { readonly verb: "paste"; readonly file: string }
  | { readonly verb: "inside"; readonly ref: Ref; readonly act: { readonly kind: "click"; readonly selector: string } | { readonly kind: "type"; readonly selector: string; readonly text: string } | { readonly kind: "text"; readonly selector: string | null } };

/** out:NAME is a path in the session's out/ folder; fixture-file:NAME writes a built-in file there and passes its path. */
export type ArgValue = { readonly kind: "literal"; readonly raw: string } | { readonly kind: "expand"; readonly how: "file" | "b64" | "dir" | "fixture" | "out" | "fixture-file"; readonly path: string };

export const LAYERS = ["doc", "view", "pending", "frames", "presence", "history", "dom", "context", "service", "storage", "events", "console", "op", "last"] as const;
export type Layer = (typeof LAYERS)[number];
export type Segment = string | number | Ref;
export interface Path { readonly layer: Layer; readonly segments: readonly Segment[] }
export type Op = "=" | "!=" | "<" | "<=" | ">" | ">=" | "~=" | "has" | "!has";
export type ExprValue = { readonly kind: "checkpoint"; readonly name: string } | { readonly kind: "abs"; readonly raw: string } | { readonly kind: "rel"; readonly delta: number } | { readonly kind: "path"; readonly path: Path };
export interface Expr { readonly source: string; readonly path: Path; readonly op: Op; readonly value: ExprValue }

export type Step =
  /** settle false (--no-settle): do not wait for the canvas, e.g. while a person is holding a drag there. */
  | { readonly kind: "agent"; readonly tool: string; readonly args: Readonly<Record<string, ArgValue>>; readonly bind: string | null; readonly client: string; readonly settle: boolean }
  | { readonly kind: "begin"; readonly job: string; readonly step: Extract<Step, { kind: "agent" }> }
  | { readonly kind: "join"; readonly job: string }
  | { readonly kind: "person"; readonly action: PersonAction; readonly view: string; readonly settle: boolean; readonly bind: string | null }
  | { readonly kind: "expect"; readonly exprs: readonly Expr[] }
  | { readonly kind: "wait"; readonly exprs: readonly Expr[]; readonly timeoutMs: number }
  | { readonly kind: "get"; readonly path: Path | null; readonly view: string }
  | { readonly kind: "mark"; readonly name: string | null; readonly layers: readonly Layer[] | null } | { readonly kind: "diff" } | { readonly kind: "settle"; readonly view: string }
  | { readonly kind: "shot"; readonly target: Target | null; readonly name: string | null; readonly view: string }
  | { readonly kind: "dump"; readonly layer: Layer | "all"; readonly name: string | null; readonly view: string }
  | { readonly kind: "trace"; readonly action: "start" | "stop"; readonly name: string | null; readonly view: string }
  | { readonly kind: "replay"; readonly file: string }
  | { readonly kind: "fault"; readonly fault: Fault }
  | { readonly kind: "use"; readonly screen: Ref }
  | { readonly kind: "view"; readonly action: "open" | "close" | "reload" | "ls"; readonly name: string | null; readonly newContext: boolean; readonly screen: Ref | null }
  /** reset: restart on the same origins with an empty library (the old one is moved aside in the session). */
  | { readonly kind: "service"; readonly action: "restart" | "reset" | "kill" | "terminate" | "log"; readonly lines: number }
  /** Kill and respawn the MCP adapter, as when an agent host restarts it. */
  | { readonly kind: "adapter"; readonly action: "restart" | "open" | "close"; readonly name: string }
  | { readonly kind: "probe"; readonly suite: "security" | "discovery" | "identity" | "idle" | "port" | "results" | "thumbnails" | "bridge" | "frame-messages" | "history-replay" | "history-invariants"; readonly tool?: string }
  | { readonly kind: "doctor" }
  | { readonly kind: "tools" };

export interface Line { readonly n: number; readonly source: string; readonly step: Step; readonly expectFailure: boolean }
export interface ParseError { readonly n: number; readonly source: string; readonly message: string }

class Usage extends Error {}
const usage = (m: string): never => { throw new Usage(m); };

// ── Tokens ──

/** Splits on whitespace. Quotes group at the start of a token or value; `\` escapes inside double quotes. A lone `#` starts a comment. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "", has = false, i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (/\s/.test(ch)) { if (has) { out.push(cur); cur = ""; has = false; } i++; continue; }
    if (ch === "#" && !has && (i + 1 >= line.length || /\s/.test(line[i + 1]!))) break;
    // Quotes group only at the start of a token or a value (after = or ui:), so JSON keeps its own quotes.
    const opens = !has || cur.endsWith("=") || cur === "ui:";
    if (ch === '"' && opens) {
      i++; has = true;
      while (i < line.length && line[i] !== '"') { if (line[i] === "\\" && i + 1 < line.length) i++; cur += line[i]; i++; }
      if (line[i] !== '"') usage("unterminated quote");
      i++; continue;
    }
    if (ch === "'" && opens) {
      i++; has = true;
      while (i < line.length && line[i] !== "'") { cur += line[i]; i++; }
      if (line[i] !== "'") usage("unterminated quote");
      i++; continue;
    }
    cur += ch; has = true; i++;
  }
  if (has) out.push(cur);
  return out;
}

/** The inverse of tokenize for argv: quotes what needs it. */
export function quoteArgv(argv: readonly string[]): string {
  return argv.map((a) => {
    if (a !== "" && !/[\s"'#\\]/.test(a)) return a;
    const eq = a.indexOf("=");
    const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    return eq > 0 && /^[\w-]+$/.test(a.slice(0, eq)) ? `${a.slice(0, eq)}=${q(a.slice(eq + 1))}` : q(a);
  }).join(" ");
}

// ── Pieces ──

const num = (s: string, what: string): number => { const n = Number(s); if (s === "" || !Number.isFinite(n)) usage(`${what}: expected a number, got "${s}"`); return n; };
const pair = (s: string, what: string): Point => { const m = s.split(","); if (m.length !== 2) usage(`${what}: expected X,Y, got "${s}"`); return { x: num(m[0]!, what), y: num(m[1]!, what) }; };
const ref = (s: string): Ref => { if (!/^@[\w-]+$/.test(s)) usage(`expected a handle like @A, got "${s}"`); return { kind: "ref", name: s.slice(1) }; };

export function parseTarget(s: string): Target {
  if (s === "bg") return { kind: "background", at: null };
  if (s.startsWith("bg:")) return { kind: "background", at: pair(s.slice(3), "bg") };
  if (s.startsWith("w:")) return { kind: "world", at: pair(s.slice(2), "w") };
  if (s.startsWith("ui:")) return { kind: "ui", label: s.slice(3) };
  const m = s.match(/^(@[\w-]+)(?:\.(surface|title|focus|row|nw|ne|sw|se|n|e|s|w))?(?:\+(-?[\d.]+,-?[\d.]+))?$/);
  if (!m) usage(`bad target "${s}" (use @A, @A.title, @A.focus, @A.se (a resize handle: n ne e se s sw w nw; the selection box's when @A is one of several selected), @A+X,Y, @T (a pin), @T.row, bg, bg:X,Y, w:X,Y or ui:LABEL)`);
  return { kind: "ref", ref: ref(m![1]!), part: (m![2] as "surface" | "title" | "focus" | "row" | Handle | undefined) ?? "surface", offset: m![3] ? pair(m![3], "offset") : null };
}

export function parsePath(s: string): Path {
  const parts = splitPath(s);
  const layer = parts[0] as Layer;
  if (!(LAYERS as readonly string[]).includes(layer)) usage(`unknown layer "${parts[0]}" (layers: ${LAYERS.join(" ")})`);
  return { layer, segments: parts.slice(1).map((p) => (p.startsWith("@") ? ref(p) : /^\d+$/.test(p) ? Number(p) : p)) };
}
/** Dots separate segments; an opId segment may itself contain dots only when quoted, which never happens for generated IDs. */
const splitPath = (s: string) => s.split(".").filter((p) => p !== "");

const OPS: readonly Op[] = ["!=", "<=", ">=", "~=", "=", "<", ">"];
const looksLikePath = (s: string) => { const head = s.split(".")[0]!; return s.includes(".") && (LAYERS as readonly string[]).includes(head); };

export function parseExprs(tokens: readonly string[]): Expr[] {
  const out: Expr[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (tokens[i + 1] === "has" || tokens[i + 1] === "!has") {
      const v = tokens[i + 2] ?? usage(`"${t} ${tokens[i + 1]}" needs a value`);
      out.push({ source: `${t} ${tokens[i + 1]} ${v}`, path: parsePath(t), op: tokens[i + 1] as Op, value: { kind: "abs", raw: v } });
      i += 2; continue;
    }
    let at = -1, op: Op | null = null;
    for (let k = 0; k < t.length && op === null; k++) for (const o of OPS) if (t.startsWith(o, k)) { at = k; op = o; break; }
    if (op === null || at <= 0) usage(`bad expression "${t}" (use PATH=VALUE, !=, <, <=, >, >=, ~= or "PATH has VALUE")`);
    const raw = t.slice(at + op!.length);
    const value: ExprValue = raw.startsWith("mark:") ? { kind: "checkpoint", name: raw.slice(5) } : /^\+-?\d+(\.\d+)?$/.test(raw) ? { kind: "rel", delta: Number(raw.slice(1)) } : looksLikePath(raw) ? { kind: "path", path: parsePath(raw) } : { kind: "abs", raw };
    out.push({ source: t, path: parsePath(t.slice(0, at)), op: op!, value });
  }
  if (out.length === 0) usage("expected at least one expression");
  return out;
}

const ms = (s: string): number => { const m = s.match(/^(\d+(?:\.\d+)?)(ms|s)?$/); if (!m) usage(`bad duration "${s}"`); return Number(m![1]) * (m![2] === "s" ? 1000 : 1); };

// ── Lines ──

interface Ctx { readonly words: string[]; readonly flags: Set<string>; readonly kv: Map<string, string>; readonly exprs: string[]; view: string; settle: boolean; bind: string | null }

/** Pulls --flags, key=value and the per-step options out of the tokens after the verb. */
function context(tokens: readonly string[]): Ctx {
  const words: string[] = [], flags = new Set<string>(), kv = new Map<string, string>(), exprs: string[] = [];
  let view = "v1", settle = true, bind: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--view") { view = tokens[++i] ?? usage("--view needs a name"); continue; }
    if (t === "--no-settle") { settle = false; continue; }
    if (t.startsWith("--")) { flags.add(t.slice(2)); continue; }
    if (!t.startsWith("timeout=")) exprs.push(t);
    const m = t.match(/^([a-zA-Z][\w-]*)=(.*)$/);
    if (m && m[1] === "as") { if (!/^@?[\w-]+$/.test(m[2]!)) usage(`as= takes a name, got "${m[2]}"`); bind = m[2]!.replace(/^@/, ""); continue; }
    if (m) { kv.set(m[1]!, m[2]!); continue; }
    words.push(t);
  }
  return { words, flags, kv, exprs, view, settle, bind };
}

const mods = (c: Ctx): Mods => ({ shift: c.flags.has("shift"), mod: c.flags.has("mod"), alt: c.flags.has("alt") });
const dest = (w: readonly string[], verb: string): Destination => {
  if (w[0] === "to" && w[1]) return { kind: "to", target: parseTarget(w[1]) };
  if (w[0] === "by" && w[1]) return { kind: "by", delta: pair(w[1], verb) };
  return usage(`${verb} needs "to TARGET" or "by DX,DY"`);
};
const person = (c: Ctx, action: PersonAction): Step => ({ kind: "person", action, view: c.view, settle: c.settle, bind: c.bind });
const one = <T extends string>(w: string | undefined, allowed: readonly T[], verb: string): T => (allowed.includes(w as T) ? (w as T) : usage(`${verb} takes ${allowed.join("|")}`));

export interface Verb { readonly summary: string; readonly group: "person" | "state" | "session" | "evidence"; readonly parse: (c: Ctx) => Step }

/** THE verb table. Names must not collide with MCP tool names (screens-cli check). */
export const VERBS: Readonly<Record<string, Verb>> = {
  click: { group: "person", summary: "click T [--double] [--shift] [--mod]", parse: (c) => person(c, { verb: "click", target: parseTarget(c.words[0] ?? usage("click needs a target")), mods: mods(c), double: c.flags.has("double") }) },
  drag: { group: "person", summary: "drag T (to T | by DX,DY) [--steps N] [--shift] [--mod] [--space] [--middle]", parse: (c) => person(c, { verb: "drag", from: parseTarget(c.words[0] ?? usage("drag needs a target")), dest: dest(c.words.slice(1), "drag"), mods: mods(c),
    steps: c.kv.has("steps") ? num(c.kv.get("steps")!, "steps") : 8, button: c.flags.has("middle") ? "middle" : "left", space: c.flags.has("space") }) },
  press: { group: "person", summary: "press T [--middle]   (then move, release or cancel; never settles)", parse: (c) => person({ ...c, settle: false }, { verb: "press", target: parseTarget(c.words[0] ?? usage("press needs a target")), mods: mods(c), button: c.flags.has("middle") ? "middle" : "left" }) },
  move: { group: "person", summary: "move (to T | by DX,DY) [steps=N]   (never settles)", parse: (c) => person({ ...c, settle: false }, { verb: "move", dest: dest(c.words, "move"), steps: c.kv.has("steps") ? num(c.kv.get("steps")!, "steps") : 8 }) },
  release: { group: "person", summary: "release", parse: (c) => person(c, { verb: "release" }) },
  cancel: { group: "person", summary: "cancel   (Escape during a gesture)", parse: (c) => person(c, { verb: "cancel" }) },
  draw: { group: "person", summary: "draw T by DX,DY [DX,DY …] [--pen pressure=P]", parse: (c) => {
    if (c.words[1] !== "by" || !c.words[2]) usage("draw needs: draw T by DX,DY [DX,DY …]");
    return person(c, { verb: "draw", from: parseTarget(c.words[0]!), path: c.words.slice(2).map((p) => pair(p, "draw")), pen: c.flags.has("pen"), pressure: c.kv.has("pressure") ? num(c.kv.get("pressure")!, "pressure") : null });
  } },
  wheel: { group: "person", summary: "wheel DX,DY [at T] [--cmd | --pinch]   (--cmd holds Meta; --pinch is a trackpad pinch, which browsers report as Ctrl)", parse: (c) => person(c, { verb: "wheel", delta: pair(c.words[0] ?? usage("wheel needs DX,DY"), "wheel"), at: c.words[1] === "at" && c.words[2] ? parseTarget(c.words[2]) : null,
    zoom: c.flags.has("cmd") ? "cmd" : c.flags.has("pinch") ? "pinch" : null }) },
  key: { group: "person", summary: "key COMBO …   (Mod+z, Shift+1, Escape, Backspace, v, Space-down, Space-up)", parse: (c) => person(c, { verb: "key", combos: c.words.length ? c.words : usage("key needs a combo") }) },
  type: { group: "person", summary: "type TEXT", parse: (c) => person(c, { verb: "type", text: c.words.join(" ") }) },
  tool: { group: "person", summary: "tool move|hand|pencil|comment", parse: (c) => person(c, { verb: "tool", tool: one(c.words[0], ["move", "hand", "pencil", "comment"], "tool") }) },
  pencil: { group: "person", summary: "pencil color NAME | pencil size N", parse: (c) => person(c, { verb: "pencil", what: one(c.words[0], ["color", "size"], "pencil"), value: c.words[1] ?? usage("pencil needs a value") }) },
  zoom: { group: "person", summary: "zoom in|out|100", parse: (c) => person(c, { verb: "zoom", how: one(c.words[0], ["in", "out", "100"], "zoom") }) },
  fit: { group: "person", summary: "fit", parse: (c) => person(c, { verb: "fit" }) },
  focus: { group: "person", summary: "focus T   (selects it, then presses its Focus action)", parse: (c) => person(c, { verb: "focus", target: parseTarget(c.words[0] ?? usage("focus needs a target")) }) },
  "exit-focus": { group: "person", summary: "exit-focus", parse: (c) => person(c, { verb: "exit-focus" }) },
  undo: { group: "person", summary: "undo   (Mod+z)", parse: (c) => person(c, { verb: "undo" }) },
  redo: { group: "person", summary: "redo   (Mod+Shift+z)", parse: (c) => person(c, { verb: "redo" }) },
  delete: { group: "person", summary: "delete   (Backspace on the selection)", parse: (c) => person(c, { verb: "delete" }) },
  theme: { group: "person", summary: "theme light|dark", parse: (c) => person(c, { verb: "theme", theme: one(c.words[0], ["light", "dark"], "theme") }) },
  "invert-scroll": { group: "person", summary: "invert-scroll on|off", parse: (c) => person(c, { verb: "invert-scroll", on: one(c.words[0], ["on", "off"], "invert-scroll") === "on" }) },
  "edit-title": { group: "person", summary: "edit-title T TEXT", parse: (c) => person(c, { verb: "edit-title", target: parseTarget(c.words[0] ?? usage("edit-title needs a target")), text: c.words.slice(1).join(" ") }) },
  "rename-screen": { group: "person", summary: "rename-screen TEXT", parse: (c) => person(c, { verb: "rename-screen", text: c.words.join(" ") }) },
  toast: { group: "person", summary: "toast retry|dismiss", parse: (c) => person(c, { verb: "toast", button: one(c.words[0], ["retry", "dismiss"], "toast") }) },
  drop: { group: "person", summary: "drop FILE… at T   (fixture:NAME or a path; a real drag carrying files)", parse: (c) => {
    const i = c.words.indexOf("at");
    if (i < 1 || !c.words[i + 1]) usage("drop needs: drop FILE… at T");
    return person(c, { verb: "drop", files: c.words.slice(0, i), at: parseTarget(c.words[i + 1]!) });
  } },
  paste: { group: "person", summary: "paste FILE   (an image on the clipboard, then Mod+v)", parse: (c) => person(c, { verb: "paste", file: c.words[0] ?? usage("paste needs a file") }) },
  inside: { group: "person", summary: "inside @A click SEL | type SEL TEXT | text [SEL]   (in the snapshot's own page)", parse: (c) => {
    const r = ref(c.words[0] ?? usage("inside needs @item")), k = c.words[1];
    if (k === "click") return person(c, { verb: "inside", ref: r, act: { kind: "click", selector: c.words[2] ?? usage("inside click needs a selector") } });
    if (k === "type") return person(c, { verb: "inside", ref: r, act: { kind: "type", selector: c.words[2] ?? usage("inside type needs a selector"), text: c.words.slice(3).join(" ") } });
    if (k === "text") return person(c, { verb: "inside", ref: r, act: { kind: "text", selector: c.words[2] ?? null } });
    return usage("inside takes click|type|text");
  } },

  get: { group: "state", summary: "get LAYER[.path]   (no argument: every layer's summary)", parse: (c) => ({ kind: "get", path: c.words[0] ? parsePath(c.words[0]) : null, view: c.view }) },
  expect: { group: "state", summary: "expect EXPR …   (PATH=V, !=, <, <=, >, >=, ~=, PATH has V; V may be +N from mark, or another PATH)", parse: (c) => ({ kind: "expect", exprs: parseExprs(c.exprs) }) },
  wait: { group: "state", summary: "wait EXPR … [timeout=5s]", parse: (c) => ({ kind: "wait", exprs: parseExprs(c.exprs), timeoutMs: c.kv.has("timeout") ? ms(c.kv.get("timeout")!) : 5000 }) },
  settle: { group: "state", summary: "settle   (wait until the canvas is idle)", parse: (c) => ({ kind: "settle", view: c.view }) },
  mark: { group: "state", summary: "mark [NAME] [LAYER…]   (+N or PATH=mark:NAME compares against values here)", parse: (c) => ({ kind: "mark", name: c.words[0] ?? null, layers: c.words.length > 1 ? c.words.slice(1).map((l) => one(l, LAYERS, "mark layer")) : null }) },
  diff: { group: "state", summary: "diff   (document changes since mark)", parse: () => ({ kind: "diff" }) },
  use: { group: "session", summary: "use @S   (make a Screen current and show it in every view)", parse: (c) => ({ kind: "use", screen: ref(c.words[0] ?? usage("use needs @S")) }) },
  view: { group: "session", summary: "view open [NAME] [screen=@S] [--context] | close NAME | reload [NAME] | ls", parse: (c) => ({ kind: "view", action: one(c.words[0], ["open", "close", "reload", "ls"], "view"), name: c.words[1] ?? null, newContext: c.flags.has("context"), screen: c.kv.has("screen") ? ref(c.kv.get("screen")!) : null }) },
  begin: { group: "session", summary: "begin NAME TOOL key=value … [client=NAME]   (start a real MCP call without waiting)", parse: (c) => {
    const [job, tool] = c.words;
    if (!job || !tool) usage("begin needs NAME TOOL key=value …");
    const step = agentStep(tool!, [...c.kv].map(([k, v]) => `${k}=${v}`));
    return { kind: "begin", job: job!, step: { ...step, bind: c.bind } };
  } },
  join: { group: "session", summary: "join NAME   (wait for a begun MCP call)", parse: (c) => ({ kind: "join", job: c.words[0] ?? usage("join needs NAME") }) },
  service: { group: "session", summary: "service restart|reset|kill|terminate|log [N]   (reset: an empty library)", parse: (c) => ({ kind: "service", action: one(c.words[0], ["restart", "reset", "kill", "terminate", "log"], "service"), lines: c.words[1] ? num(c.words[1], "lines") : 20 }) },
  agent: { group: "session", summary: "agent restart | open NAME | close NAME", parse: (c) => { const action = one(c.words[0], ["restart", "open", "close"], "agent"); return { kind: "adapter", action, name: c.words[1] ?? "main" }; } },
  fault: { group: "session", summary: "fault delay-commit MS [count=N] | fail-commit storage|conflict [count=N] | drop-result [count=N] | crash before-write|after-content-flush|after-temp-write|after-temp-flush|after-rename|after-write | disk-full content|poster|document | corrupt-document @S [json|schema|threads] | disconnect | no-browser [count=N] | drop-upload after=N [count=N] | fail-upload after=N | corrupt-upload [count=N] | expire-uploads | expire-presence | clear", parse: (c) => ({ kind: "fault", fault: parseFault(c) }) },
  probe: { group: "session", summary: "probe security|discovery|identity|idle|port|results|thumbnails|bridge|frame-messages|history-replay|history-invariants [tool=TOOL]", parse: (c) => { return { kind: "probe", suite: one(c.words[0], ["security", "discovery", "identity", "idle", "port", "results", "thumbnails", "bridge", "frame-messages", "history-replay", "history-invariants"], "probe"), tool: c.kv.get("tool") }; } },
  doctor: { group: "session", summary: "doctor", parse: () => ({ kind: "doctor" }) },
  tools: { group: "session", summary: "tools   (MCP tools and their arguments; * marks required)", parse: () => ({ kind: "tools" }) },
  shot: { group: "evidence", summary: "shot [T] [as=NAME]", parse: (c) => ({ kind: "shot", target: c.words[0] ? parseTarget(c.words[0]) : null, name: c.bind, view: c.view }) },
  dump: { group: "evidence", summary: "dump [LAYER|all] [as=NAME]", parse: (c) => ({ kind: "dump", layer: (c.words[0] ? (c.words[0] === "all" ? "all" : parsePath(c.words[0]).layer) : "all"), name: c.bind, view: c.view }) },
  trace: { group: "evidence", summary: "trace start | trace stop [as=NAME]", parse: (c) => ({ kind: "trace", action: one(c.words[0], ["start", "stop"], "trace"), name: c.bind, view: c.view }) },
  engine: { group: "evidence", summary: "engine replay FILE   (fold step() over a recorded trace in Node)", parse: (c) => { one(c.words[0], ["replay"], "engine"); return { kind: "replay", file: c.words[1] ?? usage("engine replay needs a file") }; } },
};

function parseFault(c: Ctx): Fault {
  const kind = c.words[0], count = c.kv.has("count") ? num(c.kv.get("count")!, "count") : 1;
  switch (kind) {
    case "delay-commit": return { kind, ms: num(c.words[1] ?? usage("delay-commit needs MS"), "ms"), count };
    case "fail-commit": return { kind, code: one(c.words[1], ["storage", "conflict"], "fail-commit"), count };
    case "drop-result": return { kind, count };
    case "crash": return { kind, at: one(c.words[1], ["before-write", "after-write", "after-content-flush", "after-temp-write", "after-temp-flush", "after-rename"], "crash") };
    case "disk-full": return { kind, at: one(c.words[1], ["content", "poster", "document"], "disk-full") };
    case "corrupt-document": return { kind, screenId: c.words[1] ?? usage("corrupt-document needs @Screen"), mode: one(c.words[2] ?? "json", ["json", "schema", "threads"], "corrupt-document") };
    case "disconnect": return { kind, sessionId: null };
    case "no-browser": return { kind, count };
    case "drop-upload": return { kind, after: num(c.kv.get("after") ?? "1", "after"), count };
    case "fail-upload": return { kind, after: num(c.kv.get("after") ?? "1", "after") };
    case "corrupt-upload": return { kind, count };
    case "expire-uploads": return { kind };
    case "expire-presence": return { kind };
    case "clear": return { kind };
    default: return usage("fault takes delay-commit|fail-commit|drop-result|crash|disk-full|corrupt-document|disconnect|no-browser|drop-upload|fail-upload|corrupt-upload|expire-uploads|expire-presence|clear");
  }
}

function agentStep(tool: string, tokens: readonly string[]): Extract<Step, { kind: "agent" }> {
  const args: Record<string, ArgValue> = {};
  let bind: string | null = null, client = "main", settle = true;
  for (const t of tokens) {
    if (t === "--no-settle") { settle = false; continue; }
    const m = t.match(/^([a-zA-Z][\w-]*)=(.*)$/s);
    if (!m) usage(`${tool}: arguments are key=value, got "${t}"`);
    const [, k, v] = m!;
    if (k === "client") { client = v!; continue; }
    if (k === "as") { bind = ref(v!).name; continue; }
    const ex = v!.match(/^(file|b64|dir|fixture|out|fixture-file):(.+)$/);
    args[k!] = ex ? { kind: "expand", how: ex[1] as Extract<ArgValue, { kind: "expand" }>["how"], path: ex[2]! } : { kind: "literal", raw: v! };
  }
  return { kind: "agent", tool, args, bind, client, settle };
}

export function parseLine(source: string, n: number): Line | ParseError | null {
  try {
    let tokens = tokenize(source);
    if (tokens.length === 0) return null;
    let expectFailure = false;
    if (tokens[0] === "!") { expectFailure = true; tokens = tokens.slice(1); }
    else if (tokens[0]!.startsWith("!")) { expectFailure = true; tokens = [tokens[0]!.slice(1), ...tokens.slice(1)]; }
    const [head, ...rest] = tokens;
    const verb = VERBS[head!];
    const step = verb ? verb.parse(context(rest)) : agentStep(head!, rest);
    return { n, source: source.trim(), step, expectFailure };
  } catch (e) {
    if (e instanceof Usage) return { n, source: source.trim(), message: e.message };
    throw e;
  }
}

export function parseScript(text: string, firstLine = 1): { readonly lines: Line[]; readonly errors: ParseError[] } {
  const lines: Line[] = [], errors: ParseError[] = [];
  text.split("\n").forEach((src, i) => {
    const r = parseLine(src, firstLine + i);
    if (!r) return;
    if ("step" in r) lines.push(r); else errors.push(r);
  });
  return { lines, errors };
}

export interface Block { readonly id: string; readonly file: string; readonly line: number; readonly text: string; readonly attrs: Readonly<Record<string, string>> }

/** ```screens id=… blocks, in file order. */
export function extractBlocks(markdown: string, file: string): Block[] {
  const out: Block[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^```screens\b(.*)$/);
    if (!m) continue;
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.trim().split(/\s+/).filter(Boolean)) { const [k, v] = a.split("="); if (k) attrs[k] = v ?? ""; }
    const start = i + 1;
    let j = start;
    while (j < lines.length && !lines[j]!.startsWith("```")) j++;
    out.push({ id: attrs.id ?? `${file}:${start}`, file, line: start + 1, text: lines.slice(start, j).join("\n"), attrs });
    i = j;
  }
  return out;
}
