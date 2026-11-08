// Opt-in observations of the real LibraryApp opening path. No test hook or alternate renderer.
import { observeOpeningRequests, submitOpeningTrace } from '../../../client/src/diagnostics.ts';
import { LIVE_POLICY } from '../engine/index.ts';
import type { CanvasRuntime } from './runtime.ts';

export interface OpeningConfig {
  readonly runId: string;
  readonly host: 'screens-app' | 'in-app-browser' | 'headless-control' | 'app-relay-control';
  readonly cases: readonly { readonly id: string; readonly screenId: string; readonly items: number }[];
  readonly reps: number;
  readonly revision: string;
  readonly canvasHash: string;
  readonly collector?: string;
  readonly token?: string;
  readonly adapterIdentity?: Readonly<Record<string, unknown>>;
  readonly resourceUri?: string;
  readonly serviceInstanceId?: string;
  readonly bootAt?: number;
}
declare global { interface Window { __SCREENS_OPENING__?: OpeningConfig } }
type Details = Record<string, string | number | boolean | null | readonly string[]>;
interface OpeningEvent { readonly stage: string; readonly start: number; readonly duration?: number; readonly details?: Details }
interface Target { readonly id: string; readonly version: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly clip: readonly [number, number, number, number] }
interface Repetition {
  readonly caseId: string; readonly screenId: string; readonly rep: number; readonly mode: 'first-open-in-view' | 'warm-reopen';
  readonly start: number; readonly events: OpeningEvent[]; readonly milestones: Record<string, number>;
  status: 'complete' | 'invalid' | 'timeout' | 'blocked'; reason?: string;
  targets: Target[]; scheduled: string[]; admitted?: string[]; evicted?: string[]; geometryDiagnostics?: { reason: string; expected: string; actual: string }; maxLive: number; frames: number; maxRafGap: number;
  browserErrors: { error: number; unhandledrejection: number };
  sampleWorkMs: number; rafLongGaps: number; framesOver50Ms: number; heapBeforeBytes: number | null; heapAfterBytes: number | null;
  cap?: number; contentSignature?: string; viewport?: { width: number; height: number; dpr: number };
  camera?: { x: number; y: number; z: number }; coverage?: { usableItems: number; targetItems: number; usableArea: number; targetArea: number };
}
const MAX_EVENTS = 20_000, TIMEOUT_MS = 30_000, SETTLE_MS = 400, RAF_WATCHDOG_MS = 3000;
const heap = () => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
/** Null for ordinary use: production call sites pay one optional-chain branch. */
export let opening: OpeningObserver | null = null;

export function configureOpening(): OpeningObserver | null {
  const config = window.__SCREENS_OPENING__;
  if (!config) return null;
  if (!config.runId || !config.revision || !/^[a-f0-9]{64}$/.test(config.canvasHash) || config.reps !== 7
    || !['screens-app', 'in-app-browser', 'headless-control', 'app-relay-control'].includes(config.host)
    || !config.cases?.length || config.cases.length > 20
    || config.cases.some((c) => !c.id || !/^[\w-]+$/.test(c.screenId) || !Number.isInteger(c.items) || c.items < 1 || c.items > 500)
    || new Set(config.cases.map((c) => c.id)).size !== config.cases.length) throw new Error('Invalid opening benchmark configuration');
  if ((config.host === 'screens-app' || config.host === 'app-relay-control') !== !!window.__SCREENS_APP__) throw new Error('Opening benchmark host does not match this surface');
  opening = new OpeningObserver(config);
  observeOpeningRequests((event) => opening?.request(event));
  opening.observeResources();
  return opening;
}

export class OpeningObserver {
  private readonly boot: OpeningEvent[] = [];
  private active: Repetition | null = null;
  private rt: CanvasRuntime | null = null;
  private library = false;
  private running = false;
  private overflow = false;
  private readonly results: Repetition[] = [];
  private readonly signatures = new Map<string, string>();
  private readonly geometries = new Map<string, string>();
  private resources: PerformanceObserver | null = null;
  private readonly browserErrors = { error: 0, unhandledrejection: 0 };
  private readonly bootErrors = { error: 0, unhandledrejection: 0 };
  private readonly onError = (event: ErrorEvent) => this.recordBrowserError('error', event.message || 'Script error');
  private readonly onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    this.recordBrowserError('unhandledrejection', reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Unhandled promise rejection');
  };
  readonly config: OpeningConfig;
  constructor(config: OpeningConfig) {
    this.config = config;
    addEventListener('error', this.onError);
    addEventListener('unhandledrejection', this.onUnhandledRejection);
    if (config.bootAt !== undefined) this.duration('resource.bootstrap', config.bootAt);
    this.mark('bootstrap');
  }
  private recordBrowserError(kind: 'error' | 'unhandledrejection', message: string): void {
    this.browserErrors[kind]++;
    if (this.active) this.active.browserErrors[kind]++; else this.bootErrors[kind]++;
    // Keep browser exception text bounded. Do not serialize arbitrary rejection objects or stacks.
    this.mark(`browser.${kind}.failed`, { message: message.slice(0, 300) });
  }
  now(): number { return performance.now(); }
  mark(stage: string, details?: Details): void { this.append({ stage, start: performance.now(), ...(details ? { details } : {}) }); }
  duration(stage: string, start: number | undefined, details?: Details): void {
    if (start !== undefined) this.append({ stage, start, duration: performance.now() - start, ...(details ? { details } : {}) });
  }
  request(event: { operation: string; start: number; duration: number; bytes?: number }): void {
    this.append({ stage: 'request', start: event.start, duration: event.duration,
      details: { operation: event.operation, ...(event.bytes === undefined ? {} : { bytes: event.bytes }) } });
  }
  observeResources(): void {
    if (!('PerformanceObserver' in window)) return;
    this.resources = new PerformanceObserver((list) => this.resourceEntries(list.getEntries()));
    this.resources.observe({ type: 'resource', buffered: true });
  }
  private resourceEntries(entries: readonly PerformanceEntry[]): void {
    for (const value of entries) {
      if (!value.name.startsWith('http')) continue;
      const entry = value as PerformanceResourceTiming, url = new URL(entry.name);
      if (!/^\/(content|poster|host)\//.test(url.pathname)) continue;
      this.append({ stage: 'resource', start: entry.startTime, duration: entry.duration,
        details: { path: url.pathname, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, sameOrigin: url.origin === location.origin } });
    }
  }
  libraryReady(): void { this.library = true; this.mark('library.ready'); }
  runtime(rt: CanvasRuntime): void { this.rt = rt; this.mark('runtime.mounted', { screenId: rt.client.screenId }); }
  private append(event: OpeningEvent): void {
    const events = this.active?.events ?? this.boot;
    if (this.active && event.start < this.active.start) return;
    if (events.length < MAX_EVENTS) events.push(event); else this.overflow = true;
    if (this.active && event.stage.endsWith('.failed')) { this.active.status = 'invalid'; this.active.reason = event.stage; }
  }

  /** The button gives the operator a chance to make the real host surface visible before timing starts. */
  mount(navigate: (path: string) => void): void {
    const ui = document.createElement('div'); ui.className = 'toast';
    Object.assign(ui.style, { position: 'fixed', zIndex: '10000', top: '12px', right: '12px' });
    const button = document.createElement('button'); button.className = 'button primary'; button.textContent = 'Start opening benchmark';
    const status = document.createElement('span'); status.setAttribute('role', 'status');
    ui.append(button, status); document.body.append(ui);
    button.addEventListener('click', () => {
      if (this.running) return;
      this.running = true; button.disabled = true; ui.hidden = true; ui.style.display = 'none';
      void this.run(navigate).then(() => {
        status.textContent = `${this.results.length} openings recorded`; ui.hidden = false; ui.style.removeProperty('display'); button.remove();
      }, (error: unknown) => {
        status.textContent = `Opening benchmark failed: ${error instanceof Error ? error.message : String(error)}`;
        ui.hidden = false; ui.style.removeProperty('display'); button.remove();
      });
    });
  }

  private async run(navigate: (path: string) => void): Promise<void> {
    const visible = () => { if (document.visibilityState !== 'visible') throw new Error('benchmark surface is hidden'); };
    let runError: string | undefined;
    const fail = () => { if (this.active) { this.active.status = 'blocked'; this.active.reason = 'surface visibility changed'; } };
    const input = (e: Event) => { if (e.isTrusted && this.active) { this.active.status = 'invalid'; this.active.reason = 'user input during opening'; } };
    document.addEventListener('visibilitychange', fail);
    for (const name of ['pointerdown', 'wheel', 'keydown']) addEventListener(name, input, true);
    try {
      visible();
      navigate('/');
      await this.waitFor(() => this.library && !!document.querySelector('.screens-app[data-route="all"]'));
      await this.paintOpportunity();
      for (const c of this.config.cases) for (let rep = 0; rep < this.config.reps; rep++) {
        visible(); this.rt = null;
        const r: Repetition = { caseId: c.id, screenId: c.screenId, rep, mode: rep === 0 ? 'first-open-in-view' : 'warm-reopen',
          start: performance.now(), events: [], milestones: {}, targets: [], scheduled: [], maxLive: 0, frames: 0, maxRafGap: 0, sampleWorkMs: 0, rafLongGaps: 0, framesOver50Ms: 0, heapBeforeBytes: heap(), heapAfterBytes: null, browserErrors: { error: 0, unhandledrejection: 0 }, status: 'complete' };
        this.active = r; this.overflow = false; this.mark('library.activate', { screenId: c.screenId });
        navigate(`/s/${c.screenId}`);
        try { await this.sample(r, c.items); }
        catch (error: unknown) { r.status = 'invalid'; r.reason = error instanceof Error ? error.message : String(error); }
        this.active = null;
        if (r.contentSignature) {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(r.contentSignature));
          r.contentSignature = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
        }
        this.results.push(r);
        navigate('/');
        await this.waitFor(() => !!document.querySelector('.screens-app[data-route="all"]') && !document.querySelector('.screens-stage'));
        await this.paintOpportunity();
      }
    } catch (error: unknown) {
      runError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (this.resources) { this.resourceEntries(this.resources.takeRecords()); this.resources.disconnect(); }
      this.active = null; document.removeEventListener('visibilitychange', fail);
      for (const name of ['pointerdown', 'wheel', 'keydown']) removeEventListener(name, input, true);
      observeOpeningRequests(undefined);
      removeEventListener('error', this.onError);
      removeEventListener('unhandledrejection', this.onUnhandledRejection);
      // Submission is outside every timed opening; no collector traffic competes with content.
      const { token: _token, collector: _collector, ...metadata } = this.config;
      const workCounts: Record<string, number> = {};
      for (const result of this.results) for (const event of result.events) workCounts[event.stage] = (workCounts[event.stage] ?? 0) + 1;
      await submitOpeningTrace({ ...metadata, harnessVersion: 1,
        doctor: { testHookAbsent: !('__screensTest' in window), appSurface: !!window.__SCREENS_APP__, visibility: document.visibilityState },
        browserErrors: this.browserErrors, bootErrors: this.bootErrors,
        errorCount: this.results.filter((r) => r.status !== 'complete').length + this.browserErrors.error + this.browserErrors.unhandledrejection + (runError ? 1 : 0), ...(runError ? { runError } : {}), workCounts,
        userAgent: navigator.userAgent, timeOrigin: performance.timeOrigin, visibility: document.visibilityState,
        cacheSemantics: 'first-open-in-view is not host-cold; warm-reopen retains view/service and native browser caches',
        paintSemantics: 'surface observed usable across successive animation frames; paint opportunity, not compositor timestamp',
        boot: this.boot, repetitions: this.results, complete: !runError && this.browserErrors.error === 0 && this.browserErrors.unhandledrejection === 0 && this.results.length === this.config.cases.length * this.config.reps });
    }
  }

  private waitFor(ready: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      let frame = 0;
      const timeout = setTimeout(() => { cancelAnimationFrame(frame); reject(new Error('library did not become ready')); }, TIMEOUT_MS);
      const tick = () => { if (ready()) { clearTimeout(timeout); resolve(); } else frame = requestAnimationFrame(tick); };
      frame = requestAnimationFrame(tick);
    });
  }
  private async paintOpportunity(): Promise<void> {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  private sample(r: Repetition, expectedItems: number): Promise<void> {
    return new Promise((resolve) => {
      let frame = 0, finished = false, last = performance.now(), stableSince = 0, stableKey = '';
      let targetArea = 0, frozenDocRevision = -1, geometryFrozen = false, geometryKey = '', geometrySamples = 0;
      let candidateCoverageAt: number | undefined, lastCoverageKey = '', coveredArea = 0;
      const elements = new Map<string, { el: HTMLElement; surface: HTMLElement }>(), previouslyUsable = new Set<string>(), admitted = new Map<string, number>();
      const finish = () => {
        if (finished) return;
        finished = true; r.heapAfterBytes = heap(); clearTimeout(timeout); clearInterval(watchdog); cancelAnimationFrame(frame);
        if (this.resources) this.resourceEntries(this.resources.takeRecords());
        const rt = this.rt;
        r.scheduled = rt?.client.screenId === r.screenId ? [...rt.frames.live].map((id) => `${id}:${rt.frames.gen.get(id) ?? 0}`) : [];
        r.admitted = [...admitted].map(([id, gen]) => `${id}:${gen}`);
        r.evicted = r.admitted.filter((id) => !r.scheduled.includes(id));
        resolve();
      };
      const invalid = (reason: string) => { r.status = 'invalid'; r.reason = reason; finish(); };
      const geometryInvalid = (reason: string, expected: string, actual: string) => {
        r.geometryDiagnostics = { reason, expected, actual };
        this.mark('geometry.invalid', { reason, expected, actual }); invalid(reason);
      };
      const blocked = (reason: string) => { r.status = 'blocked'; r.reason = reason; finish(); };
      const timeout = setTimeout(() => { r.status = 'timeout'; r.reason = 'opening did not settle within 30 seconds'; finish(); }, TIMEOUT_MS);
      const watchdog = setInterval(() => { if (performance.now() - last > RAF_WATCHDOG_MS) blocked('animation frame watchdog exceeded 3 seconds'); }, 1000);
      const tick = () => {
        if (finished) return;
        const start = performance.now();
        try {
          const elapsed = start - r.start, gap = start - last; last = start;
          r.frames++; r.maxRafGap = Math.max(r.maxRafGap, gap);
          if (r.status !== 'complete') { finish(); return; }
          if (this.overflow) { invalid('trace buffer overflow'); return; }
          if (gap > 250) r.rafLongGaps++;
          if (gap > 50) r.framesOver50Ms++;
          if (gap > RAF_WATCHDOG_MS) { blocked('animation frame watchdog exceeded 3 seconds'); return; }
          if (document.visibilityState !== 'visible') { blocked('surface is hidden'); return; }
          const rt = this.rt;
          if (!rt || rt.client.screenId !== r.screenId || !rt.stage) { frame = requestAnimationFrame(tick); return; }
          const state = rt.client.get(), doc = state.committed;
          if (state.connection !== 'ready' || !doc) { invalid('canvas connection is not ready'); return; }
          if (state.pending.size || state.remote.size || state.drafts.size || rt.view.gesture || rt.view.animation || !rt.view.autoFit) { invalid('opening has concurrent edits or interaction'); return; }
          if (frozenDocRevision < 0) {
            if (Object.keys(doc.items).length !== expectedItems) { invalid('fixture item count changed'); return; }
            const signature = JSON.stringify(doc);
            if (this.signatures.has(r.caseId) && this.signatures.get(r.caseId) !== signature) { invalid('fixture content changed between repetitions'); return; }
            this.signatures.set(r.caseId, signature); r.contentSignature = signature; frozenDocRevision = doc.revision;
          }
          if (doc.revision !== frozenDocRevision) { invalid('document changed during opening'); return; }
          const box = rt.stage.getBoundingClientRect();
          if (!box.width || !box.height) { frame = requestAnimationFrame(tick); return; }
          // ResizeObserver and production auto-fit may reconcile after the runtime first mounts.
          // Observe actual clipped content immediately; freeze only after two unchanged rAF intervals.
          const actual = { viewport: { width: box.width, height: box.height, dpr: devicePixelRatio }, camera: { ...rt.view.camera } };
          const actualKey = JSON.stringify(actual);
          if (geometryFrozen && actualKey !== geometryKey) { geometryInvalid('camera or viewport changed after initialization', geometryKey, actualKey); return; }
          if (actualKey !== geometryKey) {
            this.mark('initialization.geometry', { previous: geometryKey, actual: actualKey });
            geometryKey = actualKey; geometrySamples = 1; candidateCoverageAt = undefined; lastCoverageKey = ''; coveredArea = 0;
            r.viewport = actual.viewport; r.camera = actual.camera;
            const { x, y, z } = actual.camera;
            r.targets = rt.doc().items.flatMap((it) => {
              const left = Math.max(0, x + it.x * z), top = Math.max(0, y + it.y * z);
              const right = Math.min(actual.viewport.width, x + (it.x + it.width) * z), bottom = Math.min(actual.viewport.height, y + (it.y + it.height) * z);
              return right > left && bottom > top ? [{ id: it.id, version: it.contentVersion ?? it.assetHash ?? '', x: it.x, y: it.y, width: it.width, height: it.height,
                clip: [left, top, right, bottom] as const }] : [];
            });
            if (!r.targets.length) { invalid('fixture has no visible targets'); return; }
            targetArea = unionArea(r.targets.map((t) => t.clip));
          } else geometrySamples++;
          const viewportReconciled = Math.abs(box.width - rt.view.viewport.width) < 0.01 && Math.abs(box.height - rt.view.viewport.height) < 0.01;
          if (!geometryFrozen && geometrySamples >= 3 && viewportReconciled) {
            const geometry = JSON.stringify({ ...actual, targets: r.targets });
            const expected = this.geometries.get(r.caseId);
            if (expected !== undefined && expected !== geometry) { geometryInvalid('initialized viewport or targets changed between repetitions', expected, geometry); return; }
            this.geometries.set(r.caseId, geometry); geometryFrozen = true;
            this.mark('targets.frozen', { count: r.targets.length, targetArea, samples: geometrySamples });
          }
          r.cap = LIVE_POLICY[rt.view.pointer].cap;
          r.maxLive = Math.max(r.maxLive, rt.frames.live.size);
          if (rt.frames.live.size > LIVE_POLICY[rt.view.pointer].cap) { invalid('live frame policy cap exceeded'); return; }
          for (const id of rt.frames.live) {
            admitted.set(id, rt.frames.gen.get(id) ?? 0);
            if (rt.frames.load.get(id) === 'failed') { invalid(`live frame failed: ${id}`); return; }
          }
          const usable = new Set<string>();
          if (elements.size < r.targets.length) for (const el of rt.stage.querySelectorAll<HTMLElement>('.frame[data-item]')) {
            const surface = el.querySelector<HTMLElement>('.frame-surface');
            if (surface && el.dataset.item) elements.set(el.dataset.item, { el, surface });
          }
          for (const target of r.targets) {
            const cached = elements.get(target.id);
            if (!cached) continue;
            const { el, surface } = cached;
            if (!el.isConnected || el.style.visibility === 'hidden' || el.style.opacity === '0') continue;
            if (el.classList.contains('failed')) { invalid(`visible frame failed: ${target.id}`); return; }
            let img: HTMLImageElement | undefined, iframe: HTMLIFrameElement | undefined;
            for (const child of surface.children) {
              if (child.tagName === 'IMG') img = child as HTMLImageElement;
              else if (child.tagName === 'IFRAME') iframe = child as HTMLIFrameElement;
            }
            const image = !!img && img.style.opacity !== '0' && img.style.visibility !== 'hidden' && img.complete && img.naturalWidth > 0;
            const live = !!iframe && iframe.style.opacity === '1' && rt.frames.load.get(target.id) === 'ready';
            if (img?.getAttribute('src') && img.complete && img.naturalWidth === 0) { invalid(`image failed: ${target.id}`); return; }
            if (image || live) {
              usable.add(target.id);
              if (!previouslyUsable.has(target.id)) this.mark('surface.observed', { itemId: target.id, surface: live ? 'live' : 'poster-or-reference', provisional: !geometryFrozen });
            }
          }
          const confirmed = r.targets.filter((t) => usable.has(t.id) && previouslyUsable.has(t.id));
          const coverageKey = confirmed.map((t) => t.id).join(',');
          if (coverageKey !== lastCoverageKey) {
            lastCoverageKey = coverageKey; coveredArea = unionArea(confirmed.map((t) => t.clip));
            this.mark('coverage', { usableItems: confirmed.length, targetItems: r.targets.length, usableArea: coveredArea, targetArea, provisional: !geometryFrozen });
          }
          if (confirmed.length && r.milestones.firstContent === undefined) { r.milestones.firstContent = elapsed; this.mark('first-content.paint-opportunity', { provisional: !geometryFrozen }); }
          if (geometrySamples >= 2 && confirmed.length === r.targets.length && candidateCoverageAt === undefined) {
            candidateCoverageAt = elapsed;
            this.mark('viewport-coverage.observed', { provisional: !geometryFrozen });
          }
          if (geometryFrozen && candidateCoverageAt !== undefined && r.milestones.viewportCoverage === undefined) {
            r.milestones.viewportCoverage = candidateCoverageAt;
            this.mark('viewport-coverage.paint-opportunity', { observedAt: candidateCoverageAt });
          }
          previouslyUsable.clear(); for (const id of usable) previouslyUsable.add(id);
          r.coverage = { usableItems: confirmed.length, targetItems: r.targets.length, usableArea: coveredArea, targetArea };
          // Frames admitted only for provisional geometry may be evicted normally during auto-fit.
          // Readiness describes the final active set; admitted/evicted history remains in the result.
          const liveReady = [...rt.frames.live].every((id) => rt.frames.load.get(id) === 'ready');
          const key = JSON.stringify([...rt.frames.live].map((id) => [id, rt.frames.gen.get(id)]));
          if (key !== stableKey) { stableKey = key; stableSince = start; }
          const fullCoverageNow = confirmed.length === r.targets.length;
          if (geometryFrozen && fullCoverageNow && liveReady && !rt.timersPending() && r.milestones.viewportCoverage !== undefined) {
            if (r.milestones.allScheduledLiveReady === undefined) {
              r.milestones.allScheduledLiveReady = elapsed; this.mark('scheduled-live.ready', { live: rt.frames.live.size });
            }
            if (!stableSince) stableSince = start;
            if (start - stableSince >= SETTLE_MS) {
              if (JSON.stringify(doc) !== r.contentSignature) { invalid('fixture content changed during opening'); return; }
              r.milestones.settled = elapsed; this.mark('opening.settled', { live: rt.frames.live.size }); finish(); return;
            }
          } else {
            stableSince = start;
            if (r.milestones.allScheduledLiveReady !== undefined) { delete r.milestones.allScheduledLiveReady; this.mark('scheduled-live.readiness-reset'); }
          }
          frame = requestAnimationFrame(tick);
        } catch (error: unknown) { invalid(error instanceof Error ? error.message : String(error)); }
        finally { r.sampleWorkMs += performance.now() - start; }
      };
      frame = requestAnimationFrame(tick);
    });
  }

}

/** Union of clipped target rectangles, so overlapping objects never count twice. */
function unionArea(rects: readonly (readonly [number, number, number, number])[]): number {
  const xs = [...new Set(rects.flatMap((r) => [r[0], r[2]]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 1; i < xs.length; i++) {
    const left = xs[i - 1]!, right = xs[i]!;
    const ys = rects.filter((r) => r[0] < right && r[2] > left).map((r) => [r[1], r[3]] as const).sort((a, b) => a[0] - b[0]);
    let bottom = -Infinity, height = 0;
    for (const [top, next] of ys) { height += Math.max(0, next - Math.max(top, bottom)); bottom = Math.max(bottom, next); }
    area += (right - left) * height;
  }
  return area;
}
