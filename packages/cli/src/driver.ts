import { verifyFrameMessages } from "./frame-messages.ts";
import { verifyBridge } from "./bridge-host.ts";
// The one executor. A session's daemon hosts exactly one Driver, which owns the dev service process, the MCP
// adapter, an observer connection, the browser and its views, handles, marks, the journal and evidence.
// Steps run one at a time. Mutations go through MCP or real browser input, never storage.

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { connectLocalService, type ScreenClient, type Service, type ServiceEvent } from "@screens/client";
import { imageInfo, type ScreenDoc } from "@screens/core";
import { liveRegistry, type Registry } from "@screens/service";
import { inspectLibrary } from "@screens/storage-local";
import { replayTrace, type TraceFile } from "../../canvas/src/engine/index.ts";
import { connectAgent, type AgentPort } from "./agent.ts";
import { fileArg } from "./fixtures.ts";
import { act, locate, targetText, type PersonView } from "./person.ts";
import { parseScript, type Block, type Expr, type Layer, type Line, type Path, type Step } from "./script.ts";
import { Aliases, createdRecord, docDiff, recordIds, recordKind, docObject, encodeDoc, encodeValue, evaluate, expectedValue, pathText, resolvePath } from "./state.ts";
import { probeLifecycle, probeSocketLimits } from "./probes.ts";
import { verifyHistoryReceipts } from "./receipt-probe.ts";
import { verifyCoreHistory } from "./core-history.ts";
import { EVENT_COUNTERS } from "./bindings.ts";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const SERVICE_CLI = path.join(REPO, "packages/service/src/cli.ts");
const INLINE_BYTES = 400;
/** " warnings network,script-error" when a result carries warnings, so a step line shows them. */
const warned = (v: Record<string, unknown>) => Array.isArray(v.warnings) && v.warnings.length ? ` warnings ${v.warnings.map((w: { code?: string }) => w.code).join(",")}` : "";

export interface SessionSpec {
  readonly name: string; readonly dir: string; readonly home: string;
  readonly ports: { readonly canvas: number; readonly frame: number };
  readonly headed: boolean; readonly motion: boolean; readonly viewport: { readonly width: number; readonly height: number };
  readonly browser: string; readonly theme: "light" | "dark";
}

/** rejected: the product refused (a tool error). assertion: an expect or wait did not hold. Only these satisfy a `!` step. */
type FailCode = "failed" | "rejected" | "assertion" | "indeterminate" | "timeout";
export type StepResult =
  | { readonly ok: true; readonly line: number; readonly block: string | null; readonly text: string; readonly ms: number; readonly data?: unknown }
  | { readonly ok: false; readonly line: number; readonly block: string | null; readonly text: string; readonly code: FailCode | "usage"; readonly evidence: readonly string[]; readonly ms: number };

export class BlockedError extends Error {}
class StepError extends Error {
  readonly code: FailCode;
  readonly data?: unknown;
  constructor(message: string, code: FailCode = "failed", data?: unknown) { super(message); this.code = code; this.data = data; }
}

interface View { readonly name: string; readonly page: Page; readonly context: BrowserContext; readonly person: PersonView; readonly console: { errors: number; warnings: number; last: string | null } }

export class Driver {
  private browser!: Browser;
  private context!: BrowserContext;
  private agent!: AgentPort;
  private readonly agents = new Map<string, AgentPort>();
  private readonly jobs = new Map<string, Promise<{ text: string; data?: unknown }>>();
  private observer!: Service;
  private reg!: Registry;
  private devSecret = "";
  private servicePid = 0;
  private readonly views = new Map<string, View>();
  private readonly screens = new Map<string, ScreenClient>();
  private screen: string | null = null;
  private aliases: Aliases;
  private readonly counters: Record<string, number> = { revisions: 0, history: 0, transients: 0, viewCommands: 0, rosters: 0, drafts: 0 };
  private lastEvent: string | null = null;
  private mark: { doc: ScreenDoc | null; layers: Map<Layer, unknown> } | null = null;
  private readonly checkpoints = new Map<string, Map<Layer, unknown>>();
  private last: unknown = null;
  private lastOpId: string | null = null;
  private block: string | null = null;
  private seq = 0;

  readonly spec: SessionSpec;
  private constructor(spec: SessionSpec) {
    this.spec = spec;
    this.aliases = new Aliases(readJson(this.file("aliases.json")) ?? {});
    for (const d of [spec.home, this.file("evidence")]) fs.mkdirSync(d, { recursive: true });
  }
  private file(...p: string[]) { return path.join(this.spec.dir, ...p); }

  static async start(spec: SessionSpec): Promise<Driver> {
    process.env.SCREENS_HOME = spec.home;
    const d = new Driver(spec);
    await d.ensureService();
    d.agent = await connectAgent(spec.home);
    d.agents.set("main", d.agent);
    try {
      const sel = spec.browser;
      d.browser = await chromium.launch({ ...(sel === "chrome" ? { channel: "chrome" } : sel === "chromium" ? {} : { executablePath: sel }), headless: !spec.headed });
    } catch (e) { throw new BlockedError(`browser could not launch (${sel(spec.browser)}): ${(e as Error).message.split("\n")[0]}`); }
    d.context = await d.newContext();
    const prior = readJson<{ screen?: string }>(d.file("state.json"));
    await d.openView("v1", d.context);
    if (prior?.screen) await d.useScreen(prior.screen).catch(() => {});
    return d;
  }

  // ── Service ──

  private async ensureService() {
    const live = await liveRegistry();
    if (live?.dev && new URL(live.canvasOrigin).port === String(this.spec.ports.canvas)) { this.reg = live; this.servicePid = live.pid; }
    else {
      if (live) try { process.kill(live.pid, "SIGTERM"); await waitFor(async () => !alive(live.pid), 5000); } catch { /* gone */ }
      const log = fs.openSync(path.join(this.spec.home, "service.log"), "a");
      const child = spawn(process.execPath, [SERVICE_CLI, "serve", "--dev", "--idle-exit", "--canvas-port", String(this.spec.ports.canvas), "--frame-port", String(this.spec.ports.frame)],
        { detached: true, stdio: ["ignore", log, log], env: { ...process.env, SCREENS_HOME: this.spec.home } });
      child.unref(); fs.closeSync(log);
      this.servicePid = child.pid!;
      const ok = await waitFor(async () => { const r = await liveRegistry(); if (r?.dev) { this.reg = r; return true; } return false; }, 20_000);
      if (!ok) throw new Error(`the dev service did not start; see ${path.join(this.spec.home, "service.log")}`);
    }
    this.devSecret = fs.readFileSync(path.join(this.spec.home, "dev.secret"), "utf8").trim();
    if (!this.observer) {
      this.observer = await connectLocalService({ origin: this.reg.canvasOrigin, token: this.reg.token, instanceId: this.reg.instanceId, role: "agent" });
      this.observer.onEvent((e) => this.onEvent(e));
    }
  }

  private onEvent(e: ServiceEvent) {
    if (!("screenId" in e) || e.screenId !== this.screen) {
      if (e.t === "catalog") { const k = EVENT_COUNTERS[e.t]; this.counters[k] = (this.counters[k] ?? 0) + 1; }
      return;
    }
    const k = EVENT_COUNTERS[e.t]; this.counters[k] = (this.counters[k] ?? 0) + 1;
    const line = e.t === "revision" ? `revision ${e.doc.revision} op ${e.opId?.slice(0, 8) ?? "-"} by ${e.sessionId ? this.viewOf(e.sessionId) : "?"}` : e.t;
    this.lastEvent = line;
    fs.appendFileSync(this.file("events.ndjson"), JSON.stringify({ at: Date.now(), t: e.t, screenId: e.screenId, ...(e.t === "revision" ? { rev: e.doc.revision, opId: e.opId, sessionId: e.sessionId } : {}) }) + "\n");
  }

  private async serviceLive(): Promise<boolean> { const r = await liveRegistry(); return !!r?.dev && r.instanceId === this.reg.instanceId; }

  // ── Views ──

  private newContext() {
    return this.browser.newContext({ viewport: this.spec.viewport, reducedMotion: this.spec.motion ? "no-preference" : "reduce", colorScheme: this.spec.theme });
  }

  private async openView(name: string, context: BrowserContext) {
    const page = await context.newPage();
    const v: View = { name, page, context, console: { errors: 0, warnings: 0, last: null },
      person: { page, screenId: () => this.screen, resolve: (n) => this.refKind(n), pointer: { down: false, x: 0, y: 0, button: "left" }, cdp: null,
        file: (spec) => fileArg(spec, this.file("out"), process.cwd()) } };
    // Match a browser console without Preserve log: old-page restart errors do not belong to a new Screen's checks.
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) { v.console.errors = 0; v.console.warnings = 0; v.console.last = null; } });
    page.on("console", (m) => { if (m.type() === "error") { v.console.errors++; v.console.last = m.text(); } else if (m.type() === "warning") { v.console.warnings++; v.console.last = m.text(); } });
    page.on("pageerror", (e) => { v.console.errors++; v.console.last = e.message; });
    this.views.set(name, v);
    await this.navigate(v);
  }

  private async navigate(v: View) {
    await v.page.goto(this.screen ? `${this.reg.canvasOrigin}/s/${this.screen}` : this.reg.canvasOrigin);
    if (this.screen) await this.waitReady(v);
  }

  private async waitReady(v: View, timeout = 15_000) {
    try {
      await v.page.waitForFunction(() => {
        const h = (window as unknown as { __screensTest?: { probe(r: string[]): { stamp: { connection: string } } } }).__screensTest;
        return h && h.probe([]).stamp.connection === "ready";
      }, null, { timeout, polling: 50 });
    } catch { throw new StepError(`view ${v.name} did not load the canvas (is the service a --dev service?)`, "timeout"); }
  }

  private viewOf(sessionId: string): string {
    for (const v of this.views.values()) if (v.person.page && (v as View & { sessionId?: string }).sessionId === sessionId) return v.name;
    return "agent";
  }

  private async sessionIdOf(v: View): Promise<string | null> {
    const id = await v.page.evaluate(() => (window as unknown as { __screensTest?: { sessionId: string } }).__screensTest?.sessionId ?? null);
    if (id) { (v as View & { sessionId?: string }).sessionId = id; this.aliases.bind(v.name, id); }
    return id;
  }

  private view(name: string): View { const v = this.views.get(name); if (!v) throw new StepError(`no view ${name} (view open ${name})`); return v; }

  private refKind(name: string) {
    const id = this.aliases.resolve({ kind: "ref", name });
    return { id, kind: recordKind(this.doc(), id) };
  }

  // ── Screens ──

  private async useScreen(id: string) {
    // Observe only the current Screen; a later `use` reopens one we left.
    for (const [k, c] of this.screens) if (k !== id) { c.close(); this.screens.delete(k); }
    if (!this.screens.has(id)) this.screens.set(id, await this.observer.openScreen(id));
    this.screen = id;
    this.aliases.learn([id]);
    fs.writeFileSync(this.file("state.json"), JSON.stringify({ screen: id }));
    for (const v of this.views.values()) { await this.navigate(v); await this.sessionIdOf(v); }
    this.learn();
  }
  private doc(): ScreenDoc | null { return this.screen ? this.screens.get(this.screen)?.get().committed ?? null : null; }
  private learn() { const d = this.doc(); if (d) this.aliases.learn(recordIds(d)); }

  /** Waits until the observer has a revision at least `rev`. A revision that never arrives is a failure. */
  private async caughtUp(rev: number) {
    if (!(await waitFor(async () => (this.doc()?.revision ?? -1) >= rev, 3000))) throw new StepError(`revision ${rev} never reached the observer`, "timeout");
  }

  private async settle(v: View, timeout = 5000) {
    const idle = () => v.page.evaluate(() => (window as unknown as { __screensTest?: { idle(): boolean } }).__screensTest?.idle() ?? true);
    const deadline = Date.now() + timeout;
    let calm = 0;
    while (Date.now() < deadline) {
      calm = (await idle()) ? calm + 1 : 0;
      if (calm >= 2) break;
      await sleep(40);
    }
    if (calm < 2) {
      const p = await this.probe(v, ["pending", "frames"]).catch(() => null) as { pending?: { sending: number }; frames?: Record<string, { load?: string }> } | null;
      const loading = Object.entries(p?.frames ?? {}).filter(([, f]) => f && typeof f === "object" && f.load === "loading").map(([id]) => this.aliases.name(id));
      throw new StepError(`canvas did not settle in ${timeout} ms${p?.pending?.sending ? `; ${p.pending.sending} pending` : ""}${loading.length ? `; frames loading ${loading.join(" ")}` : ""}`, "timeout");
    }
    const rev = ((await this.probe(v, [])) as { stamp: { revision: number | null } }).stamp.revision;
    if (rev !== null) await this.caughtUp(rev);
  }

  private async settleAll(rev: number | null) {
    for (const v of this.views.values()) {
      if (!this.screen) continue;
      if (rev !== null) await v.page.waitForFunction((r) => ((window as unknown as { __screensTest?: { probe(x: string[]): { stamp: { revision: number | null } } } }).__screensTest?.probe([]).stamp.revision ?? -1) >= r, rev, { timeout: 5000, polling: 25 })
        .catch(() => { throw new StepError(`view ${v.name} never received revision ${rev}`, "timeout"); });
      await this.settle(v);
    }
  }

  // ── State ──

  private async probe(v: View, roots: readonly string[]): Promise<Record<string, unknown>> {
    const r = await v.page.evaluate((x) => (window as unknown as { __screensTest?: { probe(r: readonly string[]): Record<string, unknown> } }).__screensTest?.probe(x) ?? null, roots as string[]);
    if (!r) throw new StepError(`no canvas in view ${v.name}`);
    return r;
  }

  async readLayer(layer: Layer, viewName: string, segments: Path["segments"] = []): Promise<unknown> {
    switch (layer) {
      case "doc": return docObject(this.doc());
      case "dom": {
        const v = this.view(viewName);
        const has = await v.page.evaluate(() => !!(window as unknown as { __screensTest?: unknown }).__screensTest);
        return has ? (await this.probe(v, ["dom"])).dom : { text: await v.page.locator("body").innerText() };
      }
      case "view": case "pending": case "frames": case "presence": return (await this.probe(this.view(viewName), [layer]))[layer];
      case "history": {
        const v = this.view(viewName);
        const h = (await this.probe(v, ["history"])).history as Record<string, unknown>;
        const sid = await this.sessionIdOf(v);
        const st = (await this.observer.inspect(this.devSecret)).stacks.find((s) => s.sessionId === sid && s.screenId === this.screen);
        return { ...h, undo: { size: st?.undo.length ?? 0 }, redo: { size: st?.redo.length ?? 0 } };
      }
      case "context": return this.screen ? this.observer.readContext(this.screen) : { open: false };
      case "service": return this.observer.inspect(this.devSecret);
      case "storage": {
        const s = inspectLibrary(path.join(this.spec.home, "library"));
        return { rev: s.screens.find((x) => x.id === this.screen)?.revision ?? null, screens: s.screens.length, content: s.content, thumbs: s.thumbs, doc: s.screens.find((x) => x.id === this.screen)?.doc ?? null, staging: s.staging, orphans: s.orphans, damaged: s.damaged, collectionSuspended: s.collectionSuspended, catalog: s.catalog };
      }
      case "events": return { ...this.counters, last: this.lastEvent };
      case "console": return { ...this.view(viewName).console };
      case "op": {
        const key = segments[0];
        const opId = key === "last" ? this.lastOpId : typeof key === "string" ? key : null;
        if (!opId) throw new StepError("op needs an operation ID or `last` (op.last.status)");
        return { [String(key)]: await this.observer.status(opId) };
      }
      case "last": return this.last;
    }
  }

  private async valueAt(p: Path, view: string, cache: Map<Layer, unknown>): Promise<unknown> {
    const key = p.layer;
    if (!cache.has(key) || key === "op") cache.set(key, await this.readLayer(key, view, p.segments));
    return resolvePath(cache.get(key), p.segments, this.aliases);
  }

  private async check(exprs: readonly Expr[], view: string): Promise<string[]> {
    const cache = new Map<Layer, unknown>(), fails: string[] = [];
    for (const e of exprs) {
      const actual = await this.valueAt(e.path, view, cache);
      let want: unknown;
      if (e.value.kind === "rel") {
        if (!this.mark) throw new StepError(`${e.source}: +N needs a mark`);
        const base = resolvePath(this.mark.layers.get(e.path.layer), e.path.segments, this.aliases);
        if (typeof base !== "number") throw new StepError(`${e.source}: ${pathText(e.path)} was ${String(base)} at mark, not a number`);
        want = base + e.value.delta;
      } else if (e.value.kind === "checkpoint") {
        const checkpoint = this.checkpoints.get(e.value.name);
        if (!checkpoint || !checkpoint.has(e.path.layer)) throw new StepError(`no checkpoint ${e.value.name} for ${e.path.layer}`);
        want = resolvePath(checkpoint.get(e.path.layer), e.path.segments, this.aliases);
      } else want = e.value.kind === "path" ? await this.valueAt(e.value.path, view, cache) : expectedValue(e.value.raw, this.aliases);
      if (!evaluate(e, actual, want)) fails.push(`${pathText(e.path)} ${e.op} ${encodeValue(want, this.aliases)}, got ${actual === undefined ? "nothing" : encodeValue(actual, this.aliases, 1)}`);
    }
    return fails;
  }

  // ── Steps ──

  async run(blocks: readonly Block[], o: { readonly bail: boolean; readonly freshScreen: boolean }, emit: (r: StepResult) => void): Promise<boolean> {
    let ok = true;
    for (const b of blocks) {
      this.block = b.id.startsWith("-") ? null : b.id;
      const { lines, errors } = parseScript(b.text, b.line);
      if (errors.length) {
        for (const e of errors) emit({ ok: false, line: e.n, block: this.block, text: `${e.source}: ${e.message}`, code: "usage", evidence: [], ms: 0 });
        ok = false; continue;
      }
      if (o.freshScreen) {
        const r = await this.exec({ n: 0, source: "create_screen", expectFailure: false, step: { kind: "agent", tool: "create_screen", args: { title: { kind: "literal", raw: b.id } }, bind: "S", client: "main", settle: true } });
        if (!r.ok) { emit(r); ok = false; continue; }
      }
      for (const l of lines) {
        const r = await this.exec(l);
        emit(r);
        if (!r.ok) { ok = false; if (o.bail) break; }
      }
    }
    this.block = null;
    fs.writeFileSync(this.file("aliases.json"), JSON.stringify(this.aliases));
    return ok;
  }

  async exec(l: Line): Promise<StepResult> {
    const t0 = Date.now();
    const base = { line: l.n, block: this.block };
    try {
      const { text, data } = await this.step(l.step);
      this.last = data ?? null;
      this.learn();
      if (l.expectFailure) return { ...base, ok: false, text: `${l.source}: expected this step to fail, and it passed`, code: "failed", evidence: await this.evidence(l), ms: Date.now() - t0 };
      return { ...base, ok: true, text, ms: Date.now() - t0, ...(data !== undefined ? { data } : {}) };
    } catch (e) {
      if (e instanceof StepError && e.data !== undefined) this.last = e.data;
      const err = e as Error & { code?: string; indeterminate?: boolean };
      const msg = this.aliases.shorten(err.message.split("\n")[0]!);
      const code = err.code === "bundle-path" ? "rejected" : err.indeterminate ? "indeterminate" : e instanceof StepError ? e.code : "failed";
      // `!` expects the product to refuse, or a check not to hold; a harness or transport failure never satisfies it.
      if (l.expectFailure && (code === "rejected" || code === "assertion")) return { ...base, ok: true, text: `${l.source} (failed as expected: ${msg})`, ms: Date.now() - t0 };
      return { ...base, ok: false, text: `${l.source}: ${msg}`, code, evidence: await this.evidence(l), ms: Date.now() - t0 };
    }
  }

  private async step(s: Step): Promise<{ text: string; data?: unknown }> {
    switch (s.kind) {
      case "agent": return this.agentStep(s);
      case "begin": {
        if (this.jobs.has(s.job)) throw new StepError(`job ${s.job} already exists`);
        let dispatched!: () => void;
        const sent = new Promise<void>((resolve) => { dispatched = resolve; });
        const p = this.agentStep(s.step, dispatched); void p.catch(() => {}); this.jobs.set(s.job, p);
        // Begin promises dispatch order, not just construction of an async task still doing health/argument work.
        await Promise.race([sent, p.then(() => {}, () => {})]);
        return { text: `begin ${s.job}` };
      }
      case "join": {
        const p = this.jobs.get(s.job); if (!p) throw new StepError(`no job ${s.job}`);
        try { return await p; } finally { this.jobs.delete(s.job); }
      }
      case "person": return this.personStep(s);
      case "expect": {
        const fails = await this.check(s.exprs, "v1");
        if (fails.length) throw new StepError(`${fails.length}/${s.exprs.length} failed: ${fails.join("; ")}`, "assertion");
        return { text: `expect ${s.exprs.length}/${s.exprs.length}` };
      }
      case "wait": {
        const t0 = Date.now();
        let fails: string[] = [];
        while (Date.now() - t0 < s.timeoutMs) { fails = await this.check(s.exprs, "v1"); if (!fails.length) return { text: `wait ${((Date.now() - t0) / 1000).toFixed(2)}s` }; await sleep(50); }
        throw new StepError(`timed out after ${s.timeoutMs} ms: ${fails.join("; ")}`, "timeout");
      }
      case "get": {
        if (!s.path) return { text: await this.summary(s.view) };
        if (s.path.layer === "doc" && s.path.segments.length === 0 && this.doc()) return { text: encodeDoc(this.doc()!, this.aliases), data: this.doc() };
        const value = resolvePath(await this.readLayer(s.path.layer, s.view, s.path.segments), s.path.segments, this.aliases);
        return { text: this.inline(value, `get-${s.path.layer}`), data: value };
      }
      case "mark": {
        const layers = new Map<Layer, unknown>();
        for (const l of s.layers ?? ["doc", "events", "storage", "service"] as const) layers.set(l, await this.readLayer(l, "v1"));
        const v1 = this.views.get("v1");
        if (!s.layers && v1 && this.screen) {
          const p = await this.probe(v1, ["view", "pending", "frames", "presence", "dom"]);
          for (const l of ["view", "pending", "frames", "presence", "dom"] as const) layers.set(l, p[l]);
          layers.set("history", await this.readLayer("history", "v1"));
        }
        if (s.name) this.checkpoints.set(s.name, layers);
        this.mark = { doc: this.doc(), layers };
        return { text: `mark rev ${this.doc()?.revision ?? "-"}` };
      }
      case "diff": return { text: docDiff(this.mark?.doc ?? null, this.doc(), this.aliases) };
      case "settle": await this.settle(this.view(s.view)); return { text: "settle" };
      case "shot": return { text: `shot → ${await this.shot(s.view, s.target, s.name ?? `shot-${++this.seq}`)}` };
      case "dump": {
        const out = s.layer === "all" ? await this.dumpAll(s.view) : { [s.layer]: await this.readLayer(s.layer, s.view) };
        const f = this.write(`${s.name ?? `dump-${++this.seq}`}.json`, JSON.stringify(out, null, 1));
        return { text: `dump → ${f}` };
      }
      case "trace": {
        const v = this.view(s.view);
        if (s.action === "start") { await v.page.evaluate(() => (window as unknown as { __screensTest: { trace: { start(): void } } }).__screensTest.trace.start()); return { text: "trace start" }; }
        const t = await v.page.evaluate(() => (window as unknown as { __screensTest: { trace: { stop(): unknown } } }).__screensTest.trace.stop()) as TraceFile | null;
        if (!t) throw new StepError("no trace is recording (trace start)");
        const f = this.write(`trace-${s.name ?? ++this.seq}.json`, JSON.stringify(t));
        return { text: `trace stop ${t.events.length} inputs → ${f}` };
      }
      case "replay": {
        const file = [s.file, path.join(this.file("evidence"), s.file)].find((f) => fs.existsSync(f));
        if (!file) throw new StepError(`no trace file ${s.file}`);
        const r = replayTrace(JSON.parse(fs.readFileSync(file, "utf8")) as TraceFile);
        if (!r.matches) throw new StepError(`replay of ${r.inputs} inputs diverged from the page in: ${r.mismatch}`);
        return { text: `replay ${r.inputs} inputs ${r.docs} doc epochs: final view matches the page` };
      }
      case "fault": await this.observer.fault(this.devSecret, s.fault.kind === "corrupt-document" ? { ...s.fault, screenId: this.aliases.expand(s.fault.screenId) } : s.fault); return { text: `fault ${s.fault.kind}${"ms" in s.fault ? ` ${s.fault.ms}ms` : ""}${"count" in s.fault ? ` ×${s.fault.count}` : ""}` };
      case "use": await this.useScreen(this.aliases.resolve(s.screen)); return { text: `use ${this.aliases.name(this.screen!)}` };
      case "view": return this.viewStep(s);
      case "service": return this.serviceStep(s);
      case "adapter": {
        if (s.action === "open") {
          if (this.agents.has(s.name)) throw new StepError(`agent ${s.name} exists`);
          this.agents.set(s.name, await connectAgent(this.spec.home));
        } else if (s.action === "close") {
          if (s.name === "main") throw new StepError("main agent stays open");
          await this.agents.get(s.name)?.close(); this.agents.delete(s.name);
        } else await this.agent.restart();
        return { text: `agent ${s.action} ${s.name}` };
      }
      case "probe": {
        if (s.suite === "security") return this.probeSecurity();
        if (s.suite === "history-invariants") {
          const data = await verifyCoreHistory(this.reg, this.observer);
          return { text: `probe history-invariants ${JSON.stringify(data)}`, data };
        }
        if (s.suite === "history-replay") {
          const data = await verifyHistoryReceipts(this.reg, this.observer, this.devSecret, this.spec.home);
          return { text: `probe history-replay ${JSON.stringify(data)}`, data };
        }
        if (s.suite === "frame-messages") {
          if (!this.screen) throw new StepError("open a Screen before the frame message probe");
          const browser = await verifyFrameMessages(this.view("v1").page.mainFrame(), this.observer, this.screen, this.devSecret);
          const app = await verifyBridge(this.browser, this.spec.home, this.screen, this.observer, this.devSecret, [this.reg.canvasOrigin, this.reg.frameOrigin], true);
          return { text: `probe frame-messages ${JSON.stringify({ browser, app })}`, data: { browser, app } };
        }
        if (s.suite === "bridge") {
          if (!this.screen) throw new StepError("open a Screen before the bridge probe");
          const data = await verifyBridge(this.browser, this.spec.home, this.screen, this.observer, this.devSecret, [this.reg.canvasOrigin, this.reg.frameOrigin]);
          return { text: `probe bridge ${JSON.stringify(data)}`, data };
        }
        if (s.suite === "thumbnails") {
          const doc = this.doc(); if (!doc) throw new StepError("open a Screen before requesting thumbnails");
          const hashes = [...new Set(Object.values(doc.items).map((i) => i.kind === "reference-image" ? i.assetHash : i.posterHash).filter((h): h is string => !!h))];
          await Promise.all(hashes.map(async (h) => {
            const r = await fetch(`${this.reg.canvasOrigin}/thumb/${h}`);
            if (!r.ok) throw new StepError(`thumbnail request failed (${r.status})`);
            await r.arrayBuffer();
          }));
          return { text: `requested ${hashes.length} thumbnails through the service`, data: { fetched: hashes.length } };
        }
        if (s.suite === "results") return { text: "MCP results are scanned on every call", data: this.agent.audit() };
        const data = await probeLifecycle(s.suite, this.file("probes"), s.tool);
        return { text: `probe ${s.suite} ${JSON.stringify(data)}`, data };
      }
      case "doctor": return this.doctor();
      case "tools": return { text: `tools ${this.agent.tools.size}\n` + [...this.agent.tools.values()].map((t) => `  ${t.name} ${[...t.required.map((r) => r + "*"), ...t.optional].join(" ")}`).join("\n") };
    }
  }

  private async agentStep(s: Extract<Step, { kind: "agent" }>, dispatched?: () => void): Promise<{ text: string; data?: unknown }> {
    if (!(await this.serviceLive())) throw new StepError("the dev service is down (service restart)");
    const before = this.doc();
    const agent = this.agents.get(s.client); if (!agent) throw new StepError(`no agent ${s.client}`);
    const r = await agent.call(s.tool, s.args, { aliases: this.aliases, screenId: this.screen, cwd: process.cwd(), outDir: this.file("out"), ownedText: before ? [before.title, ...Object.values(before.items).map((i) => i.title), ...Object.values(before.threads).flatMap((t) => t.comments.map((c) => c.text))] : [], dispatched, journal: (e) => fs.appendFileSync(this.file("journal.ndjson"), JSON.stringify(e) + "\n") });
    if (r.opId) this.lastOpId = r.opId;
    // Images become evidence files; `last.images` holds what an expect can check, never the bytes.
    // width and height are read from the image's own header, so an expect checks the picture, not what the result says.
    const images = r.images.map((img) => ({ mimeType: img.mimeType, bytes: img.bytes.length, sha256: crypto.createHash("sha256").update(img.bytes).digest("hex"),
      width: imageInfo(img.bytes)?.width ?? null, height: imageInfo(img.bytes)?.height ?? null,
      file: this.write(`${s.tool}-${++this.seq}.${img.mimeType.split("/")[1] ?? "bin"}`, img.bytes) }));
    const v: Record<string, unknown> = { ...r.value, images };
    const shown = images.length ? ` image ${images.map((i) => i.file).join(" ")}` : "";
    const produced = typeof v.itemId === "string" ? v.itemId : typeof v.id === "string" ? v.id : typeof v.screenId === "string" ? v.screenId : null;
    if (s.bind && produced) this.aliases.bind(s.bind, produced);
    if (r.isError) {
      // A refusal is { error }, { message } or plain text, which the adapter wraps as { result }.
      const err = v.error as { code?: string; message?: string } | undefined;
      const why = err ? ` ${err.code}: ${err.message}` : v.message ? `: ${String(v.message)}` : typeof v.result === "string" ? `: ${v.result}` : "";
      throw new StepError(`${s.tool} ${String(v.status ?? "error")}${why}`, "rejected", v);
    }
    if (s.tool === "create_screen" && typeof v.id === "string") {
      if (s.bind) this.aliases.bind(s.bind, v.id);
      await this.useScreen(v.id);
      return { text: `create_screen ${this.aliases.name(v.id)} ${JSON.stringify(v.title)}`, data: v };
    }
    // A result naming another Screen (or none is current, as after `service reset`) has no revision for this observer to wait on.
    const target = typeof v.screenId === "string" ? v.screenId : r.screenId;
    const elsewhere = !this.screen || (target !== null && target !== this.screen);
    if (v.status === "committed" && typeof v.revision === "number" && !elsewhere) {
      await this.caughtUp(v.revision);
      if (s.settle) await this.settleAll(v.revision);
      return { text: `${s.tool} ${docDiff(before, this.doc(), this.aliases)}${v.recovered ? " (result recovered by op_status)" : ""}${warned(v)}${shown}`, data: v };
    }
    return { text: `${s.tool} ${this.inline(r.value, s.tool)}${shown}`, data: v };
  }

  private async personStep(s: Extract<Step, { kind: "person" }>): Promise<{ text: string; data?: unknown }> {
    const v = this.view(s.view);
    if (!this.screen) throw new StepError("no Screen is open (create_screen or use @S)");
    const before = this.doc();
    let r: { note?: string; data?: unknown };
    try { r = await act(v.person, s.action); }
    catch (e) { throw new StepError(`${(e as Error).message.split("\n")[0]}`); }
    if (s.settle) await this.settle(v); else await sleep(30);
    const after = this.doc();
    if (s.bind) {
      const made = createdRecord(before, after);
      if (!made) throw new StepError(`as=@${s.bind}: the step created no item, stroke, thread or comment`);
      this.aliases.bind(s.bind, made);
    }
    const delta = after && before && after.revision !== before.revision ? ` ${docDiff(before, after, this.aliases)}` : "";
    return { text: `${actionText(s.action)}${r.note ? ` → ${r.note}` : ""}${delta}${s.settle || s.action.verb === "press" || s.action.verb === "move" ? "" : " (unsettled)"}`, data: r.data };
  }

  private async viewStep(s: Extract<Step, { kind: "view" }>): Promise<{ text: string }> {
    switch (s.action) {
      case "ls": return { text: [...this.views.values()].map((v) => `${v.name} ${v.page.url().replace(this.reg.canvasOrigin, "") || "/"}`).join("\n") };
      case "open": {
        const name = s.name ?? `v${this.views.size + 1}`;
        if (this.views.has(name)) throw new StepError(`view ${name} is already open`);
        await this.openView(name, s.newContext ? await this.newContext() : this.context);
        if (s.screen) {
          const v = this.views.get(name)!;
          await v.page.goto(`${this.reg.canvasOrigin}/s/${this.aliases.resolve(s.screen)}`);
          await Promise.race([this.waitReady(v), v.page.getByRole("heading", { name: /This Screen is damaged/ }).waitFor()]);
        }
        const sid = await this.sessionIdOf(this.views.get(name)!);
        return { text: `view ${name}${s.newContext ? " (new person)" : ""} session ${sid ? sid.slice(0, 6) : "-"}` };
      }
      case "close": {
        const v = this.view(s.name ?? "");
        if (v.name === "v1") throw new StepError("v1 stays open");
        await v.page.close(); if (v.context !== this.context && v.context.pages().length === 0) await v.context.close();
        this.views.delete(v.name);
        return { text: `view close ${v.name}` };
      }
      case "reload": { const v = this.view(s.name ?? "v1"); await v.page.reload(); if (this.screen) await Promise.race([this.waitReady(v), v.page.getByRole("heading", { name: /This Screen is damaged/ }).waitFor()]); return { text: `view reload ${v.name}` }; }
    }
  }

  private async serviceStep(s: Extract<Step, { kind: "service" }>): Promise<{ text: string }> {
    if (s.action === "log") {
      const lines = fs.readFileSync(path.join(this.spec.home, "service.log"), "utf8").trimEnd().split("\n");
      return { text: lines.slice(-s.lines).join("\n") };
    }
    const pid = this.servicePid;
    if (s.action === "terminate") {
      process.kill(pid, "SIGTERM");
      if (!await waitFor(async () => !alive(pid), 10_000)) throw new StepError("service did not finish shutdown");
      return { text: `service terminated pid ${pid}` };
    }
    if (s.action === "kill") {
      if (alive(pid)) process.kill(pid, "SIGKILL");
      await waitFor(async () => !alive(pid), 5000);
      return { text: `service kill pid ${pid}` };
    }
    if (alive(pid)) { process.kill(pid, "SIGTERM"); await waitFor(async () => !alive(pid), 5000); if (alive(pid)) process.kill(pid, "SIGKILL"); }
    const t0 = Date.now();
    if (s.action === "reset") {
      // Move the library aside inside the session, so nothing is lost and the next service starts empty.
      const lib = path.join(this.spec.home, "library");
      if (fs.existsSync(lib)) fs.renameSync(lib, path.join(this.spec.home, `library.reset-${Date.now()}`));
      for (const c of this.screens.values()) c.close();
      this.screens.clear(); this.screen = null;
      fs.writeFileSync(this.file("state.json"), JSON.stringify({}));
      await this.ensureService();
      await waitFor(async () => this.observer.connected, 15_000);
      for (const v of this.views.values()) await this.navigate(v);
      return { text: `service reset pid ${this.servicePid} instance ${this.reg.instanceId.slice(0, 6)} empty library ${((Date.now() - t0) / 1000).toFixed(1)}s` };
    }
    await this.ensureService();
    // Every client reconnects to the same origins on its own; wait until they have.
    await waitFor(async () => this.observer.connected, 15_000);
    for (const v of this.views.values()) if (this.screen) await Promise.race([this.waitReady(v, 20_000), v.page.getByRole("heading", { name: /This Screen is damaged/ }).waitFor()]);
    return { text: `service restart pid ${this.servicePid} instance ${this.reg.instanceId.slice(0, 6)} ${((Date.now() - t0) / 1000).toFixed(1)}s` };
  }

  private async probeSecurity(): Promise<{ text: string }> {
    const o = this.reg.canvasOrigin, port = new URL(o).port, framePort = new URL(this.reg.frameOrigin).port;
    const checks: [string, boolean, string][] = [];
    const host = await rawGet(port, "/health", { host: `evil.test:${port}` });
    checks.push(["host", host === 421, `bad Host → ${host}`]);
    const origin = await wsOutcome(o, { origin: "http://evil.test" }, null);
    checks.push(["origin", origin === "refused", `foreign Origin → ${origin}`]);
    const token = await wsOutcome(o, { origin: o }, "0".repeat(48));
    checks.push(["token", token === "4401", `wrong token → ${token}`]);
    // The capability check needs a real snapshot, and a companion request with the right capability that loads.
    const snap = Object.values(this.doc()?.items ?? {}).find((i) => i.kind === "html-snapshot");
    const access = this.screen ? this.screens.get(this.screen)?.get().frameAccess : null;
    if (!snap || snap.kind !== "html-snapshot" || !access) throw new StepError("probe security needs a snapshot on the current Screen");
    const hostPath = (cap: string) => `/host/${this.screen}/${snap.id}/${snap.contentVersion}?gen=1&cap=${cap}`;
    const frameHost = { host: `127.0.0.1:${framePort}` };
    const bad = await rawGet(framePort, hostPath("0".repeat(access.capability.length)), frameHost), good = await rawGet(framePort, hostPath(access.capability), frameHost);
    checks.push(["capability", bad === 403 && good === 200, `frame host with a wrong capability → ${bad}, with the right one → ${good}`]);
    const dev = await this.observer.inspect("not-the-secret").then(() => "open", (e: Error) => e.message);
    checks.push(["dev", dev !== "open", `inspect without the dev secret → ${dev}`]);
    const limits = await probeSocketLimits(this.reg);
    checks.push(["payload", limits.unauthenticated === 1009 && limits.authenticated === 1009,
      `oversized frames before/after authentication → ${limits.unauthenticated}/${limits.authenticated}`]);
    const health = await fetch(`${o}/health`).then((r) => r.json()) as { instanceId: string };
    checks.push(["alive", health.instanceId === this.reg.instanceId && this.observer.connected, "oversized frames preserve the service instance"]);
    const failed = checks.filter((c) => !c[1]);
    if (failed.length) throw new StepError(`probe security ${checks.length - failed.length}/${checks.length}: ${failed.map((c) => c[2]).join("; ")}`);
    return { text: `probe security ${checks.length}/${checks.length}: ${checks.map((c) => c[2]).join("; ")}` };
  }

  private async doctor(): Promise<{ text: string }> {
    const lines: string[] = [];
    const reg = await liveRegistry();
    lines.push(`${reg?.dev ? "ok" : "FAIL"} service ${reg ? `pid ${reg.pid} ${reg.canvasOrigin}${reg.dev ? " dev" : " NOT dev (replaced by another client?)"}` : "down"}`);
    lines.push(`${this.observer.connected ? "ok" : "FAIL"} observer ${this.observer.connected ? "connected" : "disconnected"}`);
    const insp = await this.observer.inspect(this.devSecret).then(() => true, () => false);
    lines.push(`${insp ? "ok" : "FAIL"} dev controls`);
    lines.push(`ok mcp ${this.agent.tools.size} tools`);
    lines.push(`ok browser ${this.browser.version()} ${this.spec.headed ? "headed" : "headless"}`);
    for (const v of this.views.values()) {
      const has = await v.page.evaluate(() => !!(window as unknown as { __screensTest?: unknown }).__screensTest);
      lines.push(`${has || !this.screen ? "ok" : "FAIL"} view ${v.name} ${has ? "canvas" : "no canvas"}`);
    }
    const bad = lines.filter((x) => x.startsWith("FAIL"));
    const text = `doctor ${lines.length - bad.length}/${lines.length}\n${lines.map((x) => "  " + x).join("\n")}`;
    if (bad.length) throw new StepError(text);
    return { text };
  }

  private async summary(view: string): Promise<string> {
    const doc = this.doc();
    if (!doc) return "no Screen (create_screen or use @S)";
    const p = await this.probe(this.view(view), ["view", "pending"]);
    const vw = p.view as Record<string, unknown>, pd = p.pending as { size: number; failed: number };
    return `${encodeDoc(doc, this.aliases)}\n${vw.tool} z${Number((vw.camera as { z: number }).z).toFixed(2)} sel ${encodeValue(vw.selection, this.aliases, 1)} focus ${this.aliases.shorten(String(vw.focus))} gesture ${vw.gesture ?? "-"} editing ${vw.editing ?? "-"} · pending ${pd.size}${pd.failed ? ` (${pd.failed} failed)` : ""}`;
  }

  private inline(v: unknown, name: string): string {
    const text = encodeValue(v, this.aliases);
    if (Buffer.byteLength(text) <= INLINE_BYTES) return text;
    const f = this.write(`${name}-${++this.seq}.json`, JSON.stringify(v, null, 1));
    return `→ ${f} ${(Buffer.byteLength(JSON.stringify(v)) / 1024).toFixed(1)} KB`;
  }

  private write(name: string, data: string | Buffer): string {
    const f = this.file("evidence", name);
    fs.writeFileSync(f, data);
    return path.relative(process.cwd(), f);
  }

  private async dumpAll(view: string): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { aliases: this.aliases.toJSON() };
    for (const l of ["doc", "view", "pending", "frames", "presence", "history", "dom", "context", "service", "storage", "events", "console"] as const)
      out[l] = await this.readLayer(l, view).catch((e: Error) => ({ unavailable: e.message }));
    return out;
  }

  private async shot(view: string, target: import("./script.ts").Target | null, name: string): Promise<string> {
    const v = this.view(view);
    let clip: { x: number; y: number; width: number; height: number } | undefined;
    if (target?.kind === "ref") {
      const id = this.aliases.resolve(target.ref);
      const box = await v.page.locator(`[data-item="${id}"]`).boundingBox();
      if (box) clip = box;
    }
    const f = this.file("evidence", `${name}.png`);
    await v.page.screenshot({ path: f, clip });
    return path.relative(process.cwd(), f);
  }

  private async evidence(l: Line): Promise<string[]> {
    const prefix = `${this.block ? this.block.replace(/[^\w-]/g, "_") + "-" : ""}L${l.n}`;
    const out: string[] = [];
    try { out.push(this.write(`${prefix}.json`, JSON.stringify(await this.dumpAll("v1"), null, 1))); } catch { /* best effort */ }
    if (this.views.has("v1")) try { out.push(await this.shot("v1", null, prefix)); } catch { /* best effort */ }
    return out;
  }

  async close() {
    fs.writeFileSync(this.file("aliases.json"), JSON.stringify(this.aliases));
    for (const a of this.agents.values()) await a.close().catch(() => {});
    this.observer?.close();
    await this.browser?.close().catch(() => {});
    const pid = this.servicePid;
    if (alive(pid)) { process.kill(pid, "SIGTERM"); await waitFor(async () => !alive(pid), 5000); if (alive(pid)) process.kill(pid, "SIGKILL"); }
  }
}

function actionText(a: import("./script.ts").PersonAction): string {
  switch (a.verb) {
    case "click": return `click ${targetText(a.target)}${a.double ? " (double)" : ""}`;
    case "drag": return `drag ${targetText(a.from)} ${a.dest.kind === "by" ? `by ${a.dest.delta.x},${a.dest.delta.y}` : `to ${targetText(a.dest.target)}`}`;
    case "press": return `press ${targetText(a.target)}`;
    case "move": return `move ${a.dest.kind === "by" ? `by ${a.dest.delta.x},${a.dest.delta.y}` : `to ${targetText(a.dest.target)}`}`;
    case "draw": return `draw ${targetText(a.from)} ${a.path.length} segments${a.pen ? " (pen)" : ""}`;
    case "wheel": return `wheel ${a.delta.x},${a.delta.y}${a.zoom ? ` (${a.zoom})` : ""}`;
    case "key": return `key ${a.combos.join(" ")}`;
    case "type": return `type ${JSON.stringify(a.text)}`;
    case "tool": return `tool ${a.tool}`;
    case "pencil": return `pencil ${a.what} ${a.value}`;
    case "zoom": return `zoom ${a.how}`;
    case "focus": return `focus ${targetText(a.target)}`;
    case "theme": return `theme ${a.theme}`;
    case "invert-scroll": return `invert-scroll ${a.on ? "on" : "off"}`;
    case "edit-title": return `edit-title ${targetText(a.target)} ${JSON.stringify(a.text)}`;
    case "rename-screen": return `rename-screen ${JSON.stringify(a.text)}`;
    case "drop": return `drop ${a.files.join(" ")} at ${targetText(a.at)}`;
    case "paste": return `paste ${a.file}`;
    case "toast": return `toast ${a.button}`;
    case "inside": return `inside @${a.ref.name} ${a.act.kind}${"selector" in a.act && a.act.selector ? " " + a.act.selector : ""}`;
    default: return a.verb;
  }
}

const sel = (b: string) => (b === "chrome" ? "installed Chrome" : b === "chromium" ? "Playwright Chromium (npx playwright-core install chromium)" : b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function alive(pid: number): boolean { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitFor(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(50); }
  return false;
}
function readJson<T = Record<string, string>>(f: string): T | null { try { return JSON.parse(fs.readFileSync(f, "utf8")) as T; } catch { return null; } }

async function rawGet(port: string, p: string, headers: Record<string, string>): Promise<number> {
  const http = await import("node:http");
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: Number(port), path: p, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", () => resolve(0)); req.end();
  });
}

async function wsOutcome(origin: string, headers: Record<string, string>, token: string | null): Promise<string> {
  const { WebSocket } = await import("ws");
  return new Promise((resolve) => {
    const ws = new WebSocket(origin.replace(/^http/, "ws") + "/ws", { headers });
    const done = (s: string) => { try { ws.terminate(); } catch { /* closed */ } resolve(s); };
    ws.on("open", () => { if (token === null) done("open"); else ws.send(JSON.stringify({ t: "hello", protocol: 1, token, role: "agent" })); });
    ws.on("close", (code) => done(String(code)));
    ws.on("error", () => done("refused"));
    setTimeout(() => done("timeout"), 3000);
  });
}
