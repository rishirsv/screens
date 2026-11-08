// Recorded traces: the inputs a live canvas dispatched, with the clock readings, generated IDs and documents
// step() saw. replayTrace folds step() over them in plain JS, so a gesture captured in the browser can be
// re-run and changed in milliseconds. Matching the recorded final view shows the shell added no policy.

import { baseDocOf, type BaseInput } from "./display.ts";
import { step, type CanvasInput, type ViewState } from "./controller.ts";

export interface TraceEvent { readonly input: CanvasInput; readonly base: unknown | null; readonly nows: readonly number[]; readonly ids: readonly string[] }
export interface TraceFile { readonly version: 1; readonly reducedMotion: boolean; readonly initial: unknown; readonly events: readonly TraceEvent[]; readonly final: unknown }

/** Maps and Sets as tagged JSON, so a trace restores the same structures. */
export function toJson(v: unknown): unknown {
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [k, toJson(x)]) };
  if (v instanceof Set) return { $set: [...v].map(toJson) };
  if (Array.isArray(v)) return v.map(toJson);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJson(x)]));
  return v;
}
export function fromJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fromJson);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.$map)) return new Map((o.$map as [unknown, unknown][]).map(([k, x]) => [k, fromJson(x)]));
    if (Array.isArray(o.$set)) return new Set((o.$set as unknown[]).map(fromJson));
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, fromJson(x)]));
  }
  return v;
}

export interface ReplayReport { readonly inputs: number; readonly docs: number; readonly matches: boolean; readonly mismatch: string | null; readonly final: ViewState }

export function replayTrace(t: TraceFile): ReplayReport {
  let state = fromJson(t.initial) as ViewState;
  let doc = baseDocOf({ committed: null, pending: new Map(), remote: new Map() } as BaseInput);
  let docs = 0;
  for (const e of t.events) {
    if (e.base !== null) { doc = baseDocOf(fromJson(e.base) as BaseInput); docs++; }
    let i = 0, j = 0;
    const nows = e.nows, ids = e.ids;
    state = step(state, fromJson(e.input) as CanvasInput, doc, {
      reducedMotion: t.reducedMotion,
      now: () => nows[Math.min(i++, nows.length - 1)] ?? 0,
      newId: () => ids[j++] ?? `replay${j}`,
    }).state;
  }
  const got = JSON.stringify(toJson(state)), want = JSON.stringify(t.final);
  let mismatch: string | null = null;
  if (got !== want) {
    const g = toJson(state) as Record<string, unknown>, w = t.final as Record<string, unknown>;
    mismatch = Object.keys(w).filter((k) => JSON.stringify(g[k]) !== JSON.stringify(w[k])).join(", ") || "structure";
  }
  return { inputs: t.events.length, docs, matches: mismatch === null, mismatch, final: state };
}
