// Pure helpers over state: handles, paths, expressions, compact encodings and document deltas.

import { docRects, threadPoint, type CanvasItem, type Comment, type ScreenDoc, type Stroke, type Thread } from "@screens/core";
import type { RefKind } from "./person.ts";
import type { Expr, Path, Ref, Segment } from "./script.ts";
import { DOC_FIELDS } from "./bindings.ts";

/** Short handles for long IDs. `@A` is an alias bound with as=; `@3f2a1c` is a unique ID prefix. */
export class Aliases {
  private byName = new Map<string, string>();
  private byId = new Map<string, string>();
  readonly known = new Set<string>();
  constructor(init: Record<string, string> = {}) { for (const [n, id] of Object.entries(init)) this.bind(n, id); }
  bind(name: string, id: string) {
    const old = this.byName.get(name); if (old) this.byId.delete(old);
    this.byName.set(name, id); this.byId.set(id, name); this.known.add(id);
  }
  learn(ids: Iterable<string>) { for (const id of ids) this.known.add(id); }
  resolve(r: Ref): string {
    const id = this.byName.get(r.name); if (id) return id;
    if (r.name.length >= 4) {
      const hits = [...this.known].filter((k) => k.startsWith(r.name));
      if (hits.length === 1) return hits[0]!;
      if (hits.length > 1) throw new Error(`@${r.name} matches ${hits.length} IDs`);
    }
    throw new Error(`@${r.name} is not bound (bind it with as=@${r.name})`);
  }
  tryResolve(name: string): string | null { try { return this.resolve({ kind: "ref", name }); } catch { return null; } }
  name(id: string): string { const n = this.byId.get(id); return n ? `@${n}` : `@${id.slice(0, 6)}`; }
  /** Replaces every known ID inside a string with its handle. */
  shorten(s: string): string {
    let out = s;
    for (const id of [...this.known].sort((a, b) => b.length - a.length)) if (id.length >= 8 && out.includes(id)) out = out.split(id).join(this.name(id));
    return out;
  }
  /** Replaces @handles in a value written by the person with the IDs they stand for. */
  expand(s: string): string { return s.replace(/@([\w-]+)/g, (m, n: string) => this.tryResolve(n) ?? m); }
  toJSON(): Record<string, string> { return Object.fromEntries(this.byName); }
}

// ── Documents ──

export function itemFields(it: CanvasItem): Record<string, unknown> {
  const base = { kind: it.kind === "html-snapshot" ? "html" : "img", title: it.title, x: it.x, y: it.y, width: it.width, height: it.height, z: it.z, revision: it.revision };
  return it.kind === "html-snapshot" ? { ...base, cv: it.contentVersion, poster: it.posterHash, entry: it.entry, files: Object.keys(it.assetManifest), sources: it.sourceReferenceIds } : { ...base, mediaType: it.mediaType };
}
export function strokeFields(s: Stroke): Record<string, unknown> {
  return { anchor: s.anchor.kind === "item" ? s.anchor.itemId : "world", points: s.points.length, color: s.color, size: s.size, author: s.author.kind };
}
/** A thread row. `at` is the pin tip in world units now, rounded; x/y are the stored position (fractions on an item). */
export function threadFields(doc: ScreenDoc, t: Thread): Record<string, unknown> {
  const p = threadPoint(t, docRects(doc));
  return { anchor: t.anchor.kind === "item" ? t.anchor.itemId : "world", x: t.x, y: t.y, at: p ? [Math.round(p.x), Math.round(p.y)] : null, resolved: t.resolved,
    area: t.area ? [t.area.w, t.area.h] : null, comments: t.comments.length, author: t.comments[0].author.kind, text: t.comments[0].text };
}
export function commentFields(t: Thread, c: Comment): Record<string, unknown> { return { thread: t.id, author: c.author.kind, text: c.text }; }

/** The doc layer: header fields, sizes, and every item, stroke, thread and comment keyed by ID. */
export function docObject(doc: ScreenDoc | null): Record<string, unknown> {
  if (!doc) return { open: false };
  const o: Record<string, unknown> = { id: doc.id, rev: doc.revision, title: doc.title, items: { size: Object.keys(doc.items).length }, strokes: { size: Object.keys(doc.strokes).length }, threads: { size: Object.keys(doc.threads).length } };
  for (const it of Object.values(doc.items)) o[it.id] = itemFields(it);
  for (const s of Object.values(doc.strokes)) o[s.id] = strokeFields(s);
  for (const t of Object.values(doc.threads)) { o[t.id] = threadFields(doc, t); for (const c of t.comments) o[c.id] = commentFields(t, c); }
  return o;
}

/** Every record ID in a Screen, so a printed prefix resolves. */
export function recordIds(doc: ScreenDoc): string[] {
  return [doc.id, ...Object.keys(doc.items), ...Object.keys(doc.strokes), ...Object.values(doc.threads).flatMap((t) => [t.id, ...t.comments.map((c) => c.id)])];
}
export function recordKind(doc: ScreenDoc | null, id: string): RefKind {
  if (doc?.strokes[id]) return "stroke";
  if (doc?.threads[id]) return "thread";
  if (doc && Object.values(doc.threads).some((t) => t.comments.some((c) => c.id === id))) return "comment";
  return "item";
}
/** The one record a person step created: a new thread wins over its own first comment, then a reply, then a stroke, then an
 *  item (a dropped or pasted image; with several, the first in the row). Pure. */
export function createdRecord(before: ScreenDoc | null, after: ScreenDoc | null): string | null {
  if (!after) return null;
  const thread = Object.keys(after.threads).find((id) => !before?.threads[id]);
  if (thread) return thread;
  const had = new Set(before ? recordIds(before) : []);
  for (const t of Object.values(after.threads)) for (const c of t.comments) if (!had.has(c.id)) return c.id;
  const stroke = Object.keys(after.strokes).find((id) => !before?.strokes[id]);
  if (stroke) return stroke;
  return Object.values(after.items).filter((i) => !before?.items[i.id]).sort((x, y) => x.x - y.x)[0]?.id ?? null;
}

export function encodeDoc(doc: ScreenDoc, a: Aliases): string {
  const lines: string[] = [];
  const header = (Object.entries(DOC_FIELDS) as [keyof ScreenDoc, string][]).filter(([, how]) => how === "header").map(([k]) => (k === "title" ? JSON.stringify(doc.title) : `rev ${doc.revision}`));
  lines.push(`${header.join(" ")} items ${Object.keys(doc.items).length} strokes ${Object.keys(doc.strokes).length} threads ${Object.keys(doc.threads).length}`);
  for (const it of Object.values(doc.items).sort((x, y) => x.z - y.z)) lines.push(`${a.name(it.id)} ${it.kind === "html-snapshot" ? "html" : "img "} ${JSON.stringify(it.title)} ${it.width}x${it.height} @${it.x},${it.y} z${it.z} r${it.revision}${it.kind === "html-snapshot" ? ` cv:${it.contentVersion.slice(0, 6)}` : ""}`);
  for (const s of Object.values(doc.strokes)) lines.push(`${a.name(s.id)} stroke on ${s.anchor.kind === "item" ? a.name(s.anchor.itemId) : "world"} ${s.points.length}pts ${s.color} ${s.size}`);
  for (const t of Object.values(doc.threads)) lines.push(`${a.name(t.id)} thread on ${t.anchor.kind === "item" ? a.name(t.anchor.itemId) : "world"} ${t.x},${t.y}${t.resolved ? " resolved" : ""} ${t.comments.map((c) => `${a.name(c.id)} ${c.author.kind}:${JSON.stringify(clip(c.text))}`).join(" ")}`);
  return lines.join("\n");
}

/** "rev 3→4: @A x 0→100 y 0→-100 · +@B html "X" · -@C". Pure. */
export function docDiff(prev: ScreenDoc | null, next: ScreenDoc | null, a: Aliases): string {
  if (!next) return "";
  const parts: string[] = [];
  const p = prev ?? { revision: 0, title: next.title, items: {}, strokes: {} } as unknown as ScreenDoc;
  if (p.title !== next.title) parts.push(`title ${JSON.stringify(p.title)}→${JSON.stringify(next.title)}`);
  for (const it of Object.values(next.items)) {
    const was = p.items[it.id];
    if (!was) { parts.push(`+${a.name(it.id)} ${it.kind === "html-snapshot" ? "html" : "img"} ${JSON.stringify(it.title)} ${it.width}x${it.height} @${it.x},${it.y}`); continue; }
    const before = itemFields(was), after = itemFields(it);
    const ch = Object.keys(after).filter((k) => k !== "revision" && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      .map((k) => (k === "cv" || k === "poster" ? `${k} ${String(before[k]).slice(0, 6)}→${String(after[k]).slice(0, 6)}` : k === "files" || k === "sources" ? `${k} changed` : `${k} ${fmt(before[k])}→${fmt(after[k])}`));
    if (ch.length) parts.push(`${a.name(it.id)} ${ch.join(" ")}`);
  }
  for (const id of Object.keys(p.items)) if (!next.items[id]) parts.push(`-${a.name(id)}`);
  for (const s of Object.values(next.strokes)) if (!p.strokes[s.id]) parts.push(`+${a.name(s.id)} stroke on ${s.anchor.kind === "item" ? a.name(s.anchor.itemId) : "world"} ${s.points.length}pts`);
  for (const id of Object.keys(p.strokes)) if (!next.strokes[id]) parts.push(`-${a.name(id)}`);
  const anchorName = (t: Thread) => (t.anchor.kind === "item" ? a.name(t.anchor.itemId) : "world");
  const pThreads = p.threads ?? {};
  for (const t of Object.values(next.threads)) {
    const was = pThreads[t.id];
    if (!was) { parts.push(`+${a.name(t.id)} thread on ${anchorName(t)} ${JSON.stringify(clip(t.comments[0].text))}`); continue; }
    if (anchorName(was) !== anchorName(t) || was.x !== t.x || was.y !== t.y) parts.push(`${a.name(t.id)} moved ${anchorName(was)} ${was.x},${was.y}→${anchorName(t)} ${t.x},${t.y}`);
    if (was.resolved !== t.resolved) parts.push(`${a.name(t.id)} resolved ${was.resolved}→${t.resolved}`);
    const had = new Set(was.comments.map((c) => c.id)), has = new Set(t.comments.map((c) => c.id));
    for (const c of t.comments) if (!had.has(c.id)) parts.push(`+${a.name(c.id)} reply on ${a.name(t.id)} ${JSON.stringify(clip(c.text))}`);
    for (const c of was.comments) if (!has.has(c.id)) parts.push(`-${a.name(c.id)}`);
  }
  for (const id of Object.keys(pThreads)) if (!next.threads[id]) parts.push(`-${a.name(id)}`);
  return `rev ${p.revision}→${next.revision}${parts.length ? ": " + parts.join(" · ") : ""}`;
}
const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
const fmt = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));

// ── Generic values ──

/** Compact text: scalars plain, small objects as k:v pairs, nested to depth 2. IDs become handles. */
export function encodeValue(v: unknown, a: Aliases, depth = 0): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return a.shorten(depth === 0 ? v : /[\s:]/.test(v) || v === "" ? JSON.stringify(v) : v);
  if (typeof v === "number") return String(Number.isInteger(v) ? v : Math.round(v * 1000) / 1000);
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => encodeValue(x, a, depth + 1)).join(",")}]`;
  if (depth >= 3) return a.shorten(JSON.stringify(v));
  const body = Object.entries(v as Record<string, unknown>).map(([k, x]) => `${a.shorten(k)}:${encodeValue(x, a, depth + 1)}`).join(" ");
  return depth === 0 ? body : `{${body}}`;
}

// ── Paths and expressions ──

export function segmentKey(s: Segment, a: Aliases): string | number { return typeof s === "object" ? a.resolve(s) : s; }

/** Walks a value by path segments. `size` on an array or object counts it. Missing paths return undefined. */
export function resolvePath(v: unknown, segments: readonly Segment[], a: Aliases): unknown {
  let cur = v;
  for (const seg of segments) {
    const k = segmentKey(seg, a);
    if (cur === null || cur === undefined) return undefined;
    if (k === "size" && typeof cur === "object" && !("size" in (cur as object))) { cur = Array.isArray(cur) ? cur.length : Object.keys(cur as object).length; continue; }
    if (Array.isArray(cur) && typeof k === "number") { cur = cur[k]; continue; }
    if (typeof cur === "object") { cur = (cur as Record<string, unknown>)[String(k)]; continue; }
    return undefined;
  }
  return cur;
}

export function pathText(p: Path): string { return [p.layer, ...p.segments.map((s) => (typeof s === "object" ? `@${s.name}` : String(s)))].join("."); }

/** Parses an expected value: @handles become IDs, then JSON if it parses, else the plain string. */
export function expectedValue(raw: string, a: Aliases): unknown {
  const listed = raw.match(/^\[(.*)\]$/);
  if (listed && /@/.test(raw)) return listed[1]!.split(",").filter(Boolean).map((x) => { const t = x.trim(); return t.startsWith("@") ? a.resolve({ kind: "ref", name: t.slice(1) }) : t; });
  if (/^@[\w-]+$/.test(raw)) return a.resolve({ kind: "ref", name: raw.slice(1) });
  const s = a.expand(raw);
  try { return JSON.parse(s); } catch { return s; }
}

const same = (x: unknown, y: unknown): boolean => {
  // Layout math leaves float noise (345.0000023): numbers match within 1e-5 of their size.
  if (typeof x === "number" && typeof y === "number") return Math.abs(x - y) <= 1e-5 * Math.max(1, Math.abs(x), Math.abs(y));
  if (typeof x === "object" || typeof y === "object") return JSON.stringify(x) === JSON.stringify(y);
  return String(x) === String(y);
};

/** Pure. `actual` and `want` are already resolved. */
export function evaluate(e: Expr, actual: unknown, want: unknown): boolean {
  switch (e.op) {
    case "=": return actual !== undefined && same(actual, want);
    case "!=": return !same(actual, want);
    case "<": return typeof actual === "number" && actual < Number(want);
    case "<=": return typeof actual === "number" && actual <= Number(want);
    case ">": return typeof actual === "number" && actual > Number(want);
    case ">=": return typeof actual === "number" && actual >= Number(want);
    case "~=": return actual !== undefined && actual !== null && String(typeof actual === "object" ? JSON.stringify(actual) : actual).includes(String(want));
    case "has": case "!has": {
      const yes = Array.isArray(actual) ? actual.some((x) => same(x, want)) : typeof actual === "string" ? actual.includes(String(want)) : !!actual && typeof actual === "object" && String(want) in (actual as object);
      return e.op === "has" ? yes : !yes;
    }
  }
}
