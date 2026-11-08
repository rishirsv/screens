// Domain client for the local service. Used by the canvas (browser), the MCP adapter and the CLI (Node).
// Owns the committed document, the pending-operation ledger and operation outcomes for one Screen.

import { applyChanges, type FolderId, type ItemId, type Layout, type LibraryCatalog, type LibraryOperation, type LibraryRef, type MediaSort, type Operation, type OperationError, type Placement, type Rect, type ScreenDoc, type ScreenId } from "@screens/core";
import { CHUNK_BYTES, PROTOCOL_VERSION, archiveFiles, contentVersionOf, encodeArchive, encodeChunk, isArchive, splitArchive, type ClientMessage, type Fault, type ImportOutcome, type LibraryOpenResult, type MediaSearchResult, type OpenResult, type OtherParticipant, type Outcome, type Participant, type PosterAnswer, type MontageAnswer, type PresencePatch, type ScreenSummary, type ServerMessage, type ServiceInspection, type SnapshotCheck, type ViewCommand, type ViewCommandOutcome, type ViewContext } from "@screens/protocol";
import { openingRequest } from "./diagnostics.ts";

export { observeOpeningRequests, openingRequest, setOpeningTraceSink, submitOpeningTrace, type RequestObservation } from "./diagnostics.ts";

export type { Outcome, Participant, PresencePatch, OtherParticipant, PosterAnswer, MontageAnswer, ImportOutcome, ScreenSummary, ViewCommand, ViewCommandOutcome, ViewContext, Fault, ServiceInspection, SnapshotCheck, MediaSearchResult };
export { contentVersionOf, isArchive };
export { DRAFT_MAX_CHARS, PRESENCE_IDLE_MS, PRESENCE_INCOMING_MS, PRESENCE_STATUS_MS } from "@screens/protocol";
/** Broadcasts a connection receives for the Screens it has open. */
export type ServiceEvent = Exclude<ServerMessage, { t: "result" } | { t: "welcome" }>;

/** "uploading": the op's files are still going up, so the op has not been sent and a dropped socket cannot make it unknown. */
export interface PendingEntry {
  readonly opId: string; readonly op: Operation | { readonly type: "undo" | "redo" }; readonly seq: number;
  readonly outcome: Outcome | { readonly status: "sending" } | { readonly status: "uploading" };
  /** The bytes the op names, kept until it settles so a retry can upload them again. */
  readonly files?: ReadonlyMap<string, Uint8Array>;
}
export interface ScreenState {
  readonly connection: "connecting" | "ready" | "reconnecting" | "gone";
  readonly committed: ScreenDoc | null;
  /** Invariant: an entry leaves in the same update that applies its committed revision. */
  readonly pending: ReadonlyMap<string, PendingEntry>;
  readonly remote: ReadonlyMap<string, Readonly<Record<ItemId, Placement>>>;
  readonly history: { readonly canUndo: boolean; readonly canRedo: boolean };
  readonly frameAccess: { readonly origin: string; readonly capability: string } | null;
  /** Agents on this Screen, as the service last sent them. Presence only: never a revision. */
  readonly roster: readonly Participant[];
  /** Local clock minus the service clock when the roster arrived, so activeAt can be compared with Date.now(). */
  readonly rosterSkew: number;
  /** Objects being written in parts, by participant. Presence only: never a revision, never saved. */
  readonly drafts: ReadonlyMap<string, { readonly itemId: ItemId | null; readonly rev: number; readonly text: string }>;
}
export interface OperationHandle { readonly id: string; settled(): Promise<Outcome> }

export interface ScreenClient {
  readonly transportKind: "websocket" | "app";
  readContent(hash: string): Promise<Uint8Array>;
  poster(itemId: string, contentVersion?: string): Promise<PosterAnswer>;
  readonly screenId: ScreenId;
  get(): ScreenState;
  subscribe(cb: () => void): () => void;
  /** Assigns the operation ID. Never resubmits under a new ID while the outcome is unknown.
   *  files: hash → bytes the op names. The entry shows as "uploading" at once; the op goes out under the same ID once every
   *  file is stored. An upload failure marks it failed; retry uploads again, which resumes. */
  submit(op: Operation, files?: ReadonlyMap<string, Uint8Array>): OperationHandle;
  retry(opId: string): void;
  dismiss(opId: string): void;
  undo(): OperationHandle;
  redo(): OperationHandle;
  /** Presence only, never a revision. null ends the broadcast. */
  transient(gestureId: string, rects: Readonly<Record<ItemId, Placement>> | null): void;
  publishContext(ctx: ViewContext): void;
  onViewCommand(cb: (c: ViewCommand) => void): () => void;
  answerViewCommand(id: string, outcome: ViewCommandOutcome): void;
  close(): void;
}

/** Library operations wait here until the catalog change carrying their opId arrives. */
export interface LibraryPendingEntry { readonly opId: string; readonly op: LibraryOperation | { readonly type: "undo" | "redo" | "purge" }; readonly outcome: Outcome | { readonly status: "sending" } }
export interface LibraryState {
  readonly connection: ScreenState["connection"];
  /** Committed only. */
  readonly catalog: LibraryCatalog | null;
  readonly pending: ReadonlyMap<string, LibraryPendingEntry>;
  readonly history: { readonly canUndo: boolean; readonly canRedo: boolean };
}
export interface LibraryClient {
  get(): LibraryState;
  subscribe(cb: () => void): () => void;
  submit(op: LibraryOperation): OperationHandle;
  /** Permanent delete from Archive. Not undoable. */
  purge(targets: readonly LibraryRef[] | "all"): OperationHandle;
  dismiss(opId: string): void;
  undo(): OperationHandle;
  redo(): OperationHandle;
  close(): void;
}

export interface Service {
  readonly sessionId: string;
  listScreens(filter?: { folderId?: FolderId | null; archived?: boolean; query?: string }): Promise<ScreenSummary[]>;
  createScreen(title: string, folderId?: FolderId, layout?: Layout): Promise<{ id: string; title: string }>;
  openLibrary(): Promise<LibraryClient>;
  /** One-shot library operation for agents. */
  runLibrary(op: LibraryOperation, opId?: string): Promise<Outcome>;
  readLibrary(): Promise<LibraryCatalog>;
  searchMedia(query: string, o?: { sort?: MediaSort; archived?: boolean; offset?: number; limit?: number }): Promise<MediaSearchResult>;
  /** Puts bytes in the service's content store and returns their SHA-256. Hashes locally, asks how much the service holds and
   *  sends the rest in chunks. After a dropped connection it waits for the reconnect and asks again, so it resumes. Content
   *  already stored sends nothing. Rejects on corrupt, limit, a closed client or no reconnect within 30 s. */
  upload(bytes: Uint8Array): Promise<string>;
  /** The committed Screen as one export file: the document and every file it references, at one revision. */
  /** parts, written in order, are the file; they are not joined, so the caller can write them without another copy. */
  exportScreen(screenId: ScreenId): Promise<{ readonly parts: readonly Uint8Array[]; readonly bytes: number; readonly revision: number; readonly files: number }>;
  /** Uploads an export's header and files, then restores the Screen with its IDs. A lost answer is asked about by opId. */
  importScreen(archive: Uint8Array, opId?: string): Promise<ImportOutcome>;
  readContent(hash: string): Promise<Uint8Array>;
  /** An object's picture for its current content (rendered if needed), optionally cropped to pieces. */
  poster(screenId: ScreenId, itemId: string, pieces?: readonly string[], contentVersion?: string): Promise<PosterAnswer>;
  /** An overview of the Screen, or of rect in world units, composed from stored pictures. */
  montage(screenId: ScreenId, o?: { readonly rect?: Rect; readonly maxSize?: number; readonly labels?: boolean }): Promise<MontageAnswer>;
  readContext(screenId: ScreenId, lane?: string, app?: boolean): Promise<{ view: (ViewContext & { sessionId: string }) | null; open: boolean; others: readonly OtherParticipant[] }>;
  /** The Screens open in canvases, most recently active first. */
  views(): Promise<readonly { screenId: ScreenId; at: number; app: boolean }[]>;
  viewCommand(screenId: ScreenId, command: ViewCommand): Promise<ViewCommandOutcome | "no-view">;
  /** An agent's status and reservation (set_status). lane: which agent on this connection, when several share it. */
  presence(screenId: ScreenId, patch: PresencePatch, lane?: string): Promise<{ placement: Rect | null }>;
  /** One part of an object being written: shown on canvases as a draft, never saved. itemId null: a new object. */
  draft(screenId: ScreenId, itemId: ItemId | null, text: string, lane?: string, generation?: string): Promise<{ rev: number; bytes: number }>;
  /** One-shot operation for agents: submit and wait for the outcome. request: the caller's own input, compared by the
   *  receipt instead of op (see the protocol's `op` message). lane as in presence. */
  run(screenId: ScreenId, op: Operation, opId?: string, request?: unknown, lane?: string, draftGeneration?: string): Promise<Outcome>;
  /** Outcome of an operation by ID: committed, failed or unknown. Never resubmits. */
  status(opId: string, identity?: { readonly screenId: ScreenId; readonly request: unknown }): Promise<Outcome>;
  /** Latest committed document, read without subscribing. */
  read(screenId: ScreenId): Promise<ScreenDoc>;
  openScreen(screenId: ScreenId): Promise<ScreenClient>;
  /** Every broadcast for the Screens this connection has open, in arrival order. */
  onEvent(cb: (e: ServiceEvent) => void): () => void;
  /** True while the socket is connected and welcomed. */
  readonly connected: boolean;
  /** Dev service only (see packages/service/src/dev.ts). */
  inspect(devSecret: string): Promise<ServiceInspection>;
  fault(devSecret: string, fault: Fault): Promise<void>;
  close(): void;
}

/** name: an agent host's client name, shown on the canvas. */
export interface ConnectOptions { readonly origin: string; readonly token: string; readonly role: "canvas" | "agent"; readonly sessionId?: string; readonly instanceId?: string; readonly name?: string; readonly surface?: "app" }

export const newId = (): string => crypto.randomUUID();

export type RequestBody = ClientMessage extends infer M ? (M extends { reqId: string } ? Omit<M, "reqId"> : never) : never;

/** The service protocol, independent of how messages reach the local service. */
export interface ServiceTransport {
  readonly kind: "websocket" | "app";
  readonly sessionId: string;
  readonly connected: boolean;
  request<T>(message: RequestBody): Promise<T>;
  post(message: ClientMessage): void;
  sendChunk(hash: string, size: number, offset: number, bytes: Uint8Array): Promise<{ held: number }>;
  onEvent(cb: (message: ServerMessage) => void): () => void;
  onConnection(cb: (connected: boolean) => void): () => void;
  close(): void;
}

/** Connects, runs the versioned handshake, and reconnects with backoff when the socket drops. */
export async function connectWebSocketTransport(o: ConnectOptions): Promise<ServiceTransport> {
  const wsUrl = o.origin.replace(/^http/, "ws") + "/ws";
  let ws!: WebSocket;
  let sessionId = o.sessionId ?? "";
  let closed = false, connected = false, everWelcomed = false;
  const waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(m: ServerMessage) => void>();
  const connListeners = new Set<(up: boolean) => void>();

  const open = () => new Promise<void>((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
    let welcomed = false;
    const timer = setTimeout(() => { reject(new Error("Screens handshake timed out")); sock.close(); }, 3000);
    sock.onerror = () => { /* close supplies the connection failure */ };
    sock.onopen = () => sock.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION, token: o.token, role: o.role, sessionId: sessionId || undefined, ...(o.name ? { name: o.name } : {}), ...(o.surface ? { surface: o.surface } : {}) } satisfies ClientMessage));
    sock.onmessage = (ev) => {
      let m: ServerMessage;
      try { m = JSON.parse(String(ev.data)) as ServerMessage; if (!m || typeof m !== "object") throw new Error(); }
      catch { clearTimeout(timer); reject(new Error("Invalid Screens handshake")); sock.close(); return; }
      if (m.t === "welcome") {
        if (m.protocol !== PROTOCOL_VERSION || (!everWelcomed && o.instanceId !== undefined && m.instanceId !== o.instanceId)) {
          clearTimeout(timer); reject(new Error("Screens service identity or protocol mismatch")); sock.close(); return;
        }
        clearTimeout(timer); welcomed = true; everWelcomed = true; connected = true; sessionId = m.sessionId; ws = sock; resolve(); for (const l of connListeners) l(true); return; }
      if (!welcomed) { clearTimeout(timer); reject(new Error("Invalid Screens handshake")); sock.close(); return; }
      if (m.t === "result") { const w = waiting.get(m.reqId); if (w) { waiting.delete(m.reqId); if (m.ok) w.resolve(m.value); else w.reject(Object.assign(new Error(m.error.message), { code: m.error.code })); } return; }
      for (const l of listeners) l(m);
    };
    sock.onclose = () => {
      clearTimeout(timer);
      for (const w of waiting.values()) w.reject(new Error("connection lost"));
      waiting.clear();
      if (!welcomed) { reject(new Error("could not connect to the Screens service")); return; }
      connected = false;
      for (const l of connListeners) l(false);
      if (!closed) reconnect(500);
    };
  });
  const reconnect = (delay: number) => setTimeout(() => { if (!closed) open().catch(() => reconnect(Math.min(delay * 2, 8000))); }, delay);
  await openingRequest("websocket.connect", open);

  const request = <T>(m: RequestBody): Promise<T> => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error("not connected")); return; }
    const reqId = newId();
    waiting.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
    ws.send(JSON.stringify({ ...m, reqId }));
  });
  const post = (m: ClientMessage) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
  const sendChunk = (hash: string, size: number, offset: number, bytes: Uint8Array): Promise<{ held: number }> => new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) { reject(new Error("not connected")); return; }
    const reqId = newId();
    waiting.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
    ws.send(encodeChunk({ reqId, hash, size, offset }, bytes) as Uint8Array<ArrayBuffer>);
  });
  return {
    kind: "websocket",
    get sessionId() { return sessionId; },
    get connected() { return connected; },
    request: <T>(message: RequestBody) => openingRequest(`websocket.${message.t}`, () => request<T>(message)), post, sendChunk,
    onEvent: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    onConnection: (cb) => { connListeners.add(cb); return () => connListeners.delete(cb); },
    close: () => { closed = true; ws.close(); },
  };
}

/** Browser clients use WebSocket by default; other hosts may supply an already-connected transport. */
export async function connectLocalService(o: ConnectOptions): Promise<Service> {
  return connectService(await connectWebSocketTransport(o));
}

export function connectService(transport: ServiceTransport): Service {
  let closed = false;
  const request = <T>(m: RequestBody) => transport.request<T>(m);
  const post = (m: ClientMessage) => transport.post(m);
  const sendChunk = (hash: string, size: number, offset: number, bytes: Uint8Array) => transport.sendChunk(hash, size, offset, bytes);
  const listeners = new Set<(m: ServerMessage) => void>();
  const connListeners = new Set<(up: boolean) => void>();
  const offEvent = transport.onEvent((m) => { for (const l of listeners) l(m); });
  const offConnection = transport.onConnection((up) => { for (const l of connListeners) l(up); });
  const dropped = (e: unknown) => e instanceof Error && (e.message === "connection lost" || e.message === "not connected");
  const whenConnected = (ms: number) => new Promise<void>((resolve, reject) => {
    if (transport.connected) { resolve(); return; }
    const t = setTimeout(() => { connListeners.delete(on); reject(new Error("could not reconnect to the Screens service")); }, ms);
    const on = (up: boolean) => { if (up) { clearTimeout(t); connListeners.delete(on); resolve(); } };
    connListeners.add(on);
  });
  /** Retries `fn` across dropped connections. Every step it takes must be safe to repeat. */
  const resilient = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (;;) {
      try { return await fn(); }
      catch (e) { if (closed || !dropped(e)) throw e; await whenConnected(30_000); }
    }
  };
  const upload = async (bytes: Uint8Array): Promise<string> => sendFile(bytes, await sha256hex(bytes));
  /** Uploads bytes whose hash the caller has computed. */
  const sendFile = async (bytes: Uint8Array, hash: string): Promise<string> => {
    const size = bytes.length;
    // The service's `held` is the only progress record: after a drop, ask again and send the rest.
    await resilient(async () => {
      let { held } = await request<{ held: number }>({ t: "upload", hash, size });
      while (held < size) ({ held } = await sendChunk(hash, size, held, bytes.subarray(held, held + CHUNK_BYTES)));
    });
    return hash;
  };

  const service: Service = {
    get sessionId() { return transport.sessionId; },
    listScreens: (f = {}) => request({ t: "list", ...f }),
    createScreen: (title, folderId, layout) => request({ t: "create", title, ...(folderId ? { folderId } : {}), ...(layout && layout !== "canvas" ? { layout } : {}) }),
    openLibrary: () => openLibraryClient(),
    runLibrary: (op, opId = newId()) => request<Outcome>({ t: "libraryOp", opId, op }),
    readLibrary: async () => (await request<LibraryOpenResult>({ t: "openLibrary" })).catalog,
    searchMedia: (query, o = {}) => request({ t: "searchMedia", query, ...o }),
    upload,
    exportScreen: async (screenId) => {
      const doc = (await request<OpenResult>({ t: "open", screenId })).doc;
      // One file at a time, so at most one base64 copy is in flight beside the decoded bytes.
      const files: { hash: string; mediaType: string; bytes: Uint8Array }[] = [];
      for (const f of archiveFiles(doc)) files.push({ ...f, bytes: base64ToBytes(await request<string>({ t: "readContent", hash: f.hash })) });
      const parts = encodeArchive(doc, files);
      return { parts, bytes: parts.reduce((n, p) => n + p.length, 0), revision: doc.revision, files: files.length };
    },
    importScreen: async (archive, opId = newId()) => {
      const split = splitArchive(archive);
      if ("error" in split) return { status: "failed", error: { code: split.error, message: split.message } };
      let head: string;
      try {
        // Every file is checked against the export's own list before any byte is sent, so a damaged export stores nothing.
        for (const { file, bytes } of split.files)
          if (await sha256hex(bytes) !== file.hash) return { status: "failed", error: { code: "corrupt", message: `file ${file.hash.slice(0, 12)} in the export does not match its hash; nothing was imported` } };
        for (const { file, bytes } of split.files) await sendFile(bytes, file.hash);
        head = await upload(split.head);
      } catch (e) {
        const err = e as Error & { code?: string };
        return { status: "failed", error: { code: err.code === "corrupt" || err.code === "limit" ? err.code : "upload", message: `${err.message}; nothing was imported` } };
      }
      // The service owns replay: the same opId and header returns the receipt, a different header under that opId is refused.
      return resilient(() => request<ImportOutcome>({ t: "importScreen", opId, head }));
    },
    readContent: async (hash) => base64ToBytes(await request<string>({ t: "readContent", hash })),
    montage: (screenId, o = {}) => request<MontageAnswer>({ t: "montage", screenId, ...o }),
    poster: (screenId, itemId, pieces, contentVersion) => request<PosterAnswer>({ t: "poster", screenId, itemId, ...(pieces?.length ? { pieces } : {}), ...(contentVersion ? { contentVersion } : {}) }),
    readContext: (screenId, lane, app) => request({ t: "readContext", screenId, ...(lane ? { lane } : {}), ...(app ? { app } : {}) }),
    views: () => request({ t: "views" }),
    viewCommand: (screenId, command) => request({ t: "viewCommand", screenId, command }),
    presence: (screenId, patch, lane) => request({ t: "presence", screenId, patch, ...(lane ? { lane } : {}) }),
    draft: (screenId, itemId, text, lane, generation) => request({ t: "draft", screenId, itemId, text, ...(lane ? { lane } : {}), ...(generation ? { generation } : {}) }),
    status: (opId, identity) => request<Outcome>({ t: "status", opId, ...(identity ? { identity } : {}) }),
    run: (screenId, op, opId = newId(), req, lane, draftGeneration) => request<Outcome>({ t: "op", screenId, opId, op, ...(req === undefined ? {} : { request: req }), ...(lane ? { lane } : {}), ...(draftGeneration ? { draftGeneration } : {}) }),
    read: async (screenId) => (await request<OpenResult>({ t: "open", screenId })).doc,
    openScreen: (screenId) => openScreenClient(screenId),
    onEvent: (cb) => { listeners.add(cb as (m: ServerMessage) => void); return () => listeners.delete(cb as (m: ServerMessage) => void); },
    get connected() { return transport.connected; },
    inspect: (devSecret) => request({ t: "inspect", devSecret }),
    fault: (devSecret, fault) => request({ t: "fault", devSecret, fault }),
    close: () => { closed = true; offEvent(); offConnection(); transport.close(); },
  };

  async function openScreenClient(screenId: ScreenId): Promise<ScreenClient> {
    let state: ScreenState = { connection: "connecting", committed: null, pending: new Map(), remote: new Map(), history: { canUndo: false, canRedo: false }, frameAccess: null, roster: [], rosterSkew: 0, drafts: new Map() };
    const subs = new Set<() => void>();
    const viewSubs = new Set<(c: ViewCommand) => void>();
    const settle = new Map<string, (o: Outcome) => void>();
    const recovering = new Set<string>();
    let left = false;
    let seq = 0;
    const set = (patch: Partial<ScreenState>) => { state = { ...state, ...patch }; for (const s of subs) s(); };
    const withPending = (fn: (m: Map<string, PendingEntry>) => void) => { const m = new Map(state.pending); fn(m); return m; };
    const resolveOutcome = (opId: string, outcome: Outcome) => {
      const done = settle.get(opId);
      if (outcome.status === "committed" || outcome.status === "failed") { settle.delete(opId); done?.(outcome); }
    };

    const refresh = async () => {
      const r = await request<OpenResult>({ t: "open", screenId });
      if (left) return;
      set({ connection: "ready", committed: (state.committed?.revision ?? -1) > r.doc.revision ? state.committed : r.doc, frameAccess: { origin: r.frameOrigin, capability: r.frameCapability }, history: { canUndo: r.canUndo, canRedo: r.canRedo } });
    };
    // A lost request can still be running. Its revision will announce success, but a later failure has no revision:
    // keep asking while accepted, and never replay it. Retire a commit only after its document is visible.
    const recover = async (opId: string) => {
      if (recovering.has(opId)) return;
      recovering.add(opId);
      try {
        while (!left && !closed && transport.connected && state.pending.has(opId)) {
          const o = await request<Outcome>({ t: "status", opId });
          if (left || !state.pending.has(opId)) return;
          if (o.status === "committed" && (state.committed?.revision ?? -1) < o.revision) await refresh();
          if (left || !state.pending.has(opId)) return;
          set({ pending: withPending((m) => { const e = m.get(opId); if (!e) return; if (o.status === "committed") m.delete(opId); else m.set(opId, { ...e, outcome: o }); }) });
          resolveOutcome(opId, o);
          if (o.status !== "accepted") return;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch { /* A reconnect (or Retry) resumes the status check. */ }
      finally { recovering.delete(opId); }
    };
    const load = async () => {
      await refresh();
      for (const e of state.pending.values()) if (e.outcome.status === "unknown" || e.outcome.status === "accepted") void recover(e.opId);
    };
    const onServer = (m: ServerMessage) => {
      if (!("screenId" in m) || m.screenId !== screenId) return;
      if (m.t === "revision") {
        const committedRevision = state.committed?.revision ?? -1;
        if (m.doc.revision <= committedRevision) return;
        set({ committed: m.doc, pending: m.opId && state.pending.has(m.opId) ? withPending((p) => p.delete(m.opId!)) : state.pending });
        if (m.opId) resolveOutcome(m.opId, { status: "committed", revision: m.doc.revision });
      } else if (m.t === "history") set({ history: { canUndo: m.canUndo, canRedo: m.canRedo } });
      else if (m.t === "transient") {
        // Coalesced: several people dragging send up to 30 previews a second each; the canvas renders at most one update per frame.
        remoteQueue.set(m.sessionId, m.rects);
        remoteTimer ??= setTimeout(() => {
          remoteTimer = null; const r = new Map(state.remote);
          for (const [k, v] of remoteQueue) { if (v) r.set(k, v); else r.delete(k); }
          remoteQueue.clear(); set({ remote: r });
        }, 16);
      }
      else if (m.t === "roster") set({ roster: m.participants, rosterSkew: Date.now() - m.now });
      else if (m.t === "draft") {
        const d = new Map(state.drafts), was = d.get(m.participant);
        if (m.text === null) d.delete(m.participant);
        else if (!m.append) d.set(m.participant, { itemId: m.itemId, rev: m.rev, text: m.text });
        // Parts arrive in order on one socket; a gap (none expected) keeps the last whole text until the next full one.
        else if (was && was.rev === m.rev - 1) d.set(m.participant, { itemId: m.itemId, rev: m.rev, text: was.text + m.text });
        else return;
        set({ drafts: d });
      }
      else if (m.t === "viewCommand") for (const v of viewSubs) v(m.command);
    };
    const remoteQueue = new Map<string, Readonly<Record<ItemId, Placement>> | null>();
    let remoteTimer: ReturnType<typeof setTimeout> | null = null;
    const onConn = (up: boolean) => {
      if (up) { load().catch(() => {}); return; }
      remoteQueue.clear();
      set({ connection: "reconnecting", remote: new Map(), roster: [], drafts: new Map(), pending: withPending((m) => { for (const [k, e] of m) if (e.outcome.status === "sending" || e.outcome.status === "accepted") m.set(k, { ...e, outcome: { status: "unknown" } }); }) });
    };
    listeners.add(onServer); connListeners.add(onConn);
    await load();

    /** Uploads the op's files, then sends it under the same opId. The entry reads "uploading" until then. */
    const submitWith = (opId: string, op: Operation, files: ReadonlyMap<string, Uint8Array> | undefined): OperationHandle => {
      if (!files || files.size === 0) return send(opId, op, { t: "op", reqId: "", screenId, opId, op });
      const p = new Promise<Outcome>((resolve) => settle.set(opId, resolve));
      const at = ++seq;
      set({ pending: withPending((m) => m.set(opId, { opId, op, seq: at, outcome: { status: "uploading" }, files })) });
      (async () => { for (const bytes of files.values()) await upload(bytes); })().then(
        () => { if (state.pending.has(opId)) send(opId, op, { t: "op", reqId: "", screenId, opId, op }, at, files); },
        (e: Error) => {
          const o: Outcome = { status: "failed", error: { code: "upload", message: `the files could not be uploaded: ${e.message}` } };
          set({ pending: withPending((m) => { const x = m.get(opId); if (x) m.set(opId, { ...x, outcome: o }); }) });
          resolveOutcome(opId, o);
        });
      return { id: opId, settled: () => p };
    };

    const send = (opId: string, entryOp: PendingEntry["op"], msg: Extract<ClientMessage, { reqId: string }>, keepSeq?: number, files?: ReadonlyMap<string, Uint8Array>): OperationHandle => {
      const p = settle.has(opId) ? new Promise<Outcome>((resolve) => { const prev = settle.get(opId)!; settle.set(opId, (o) => { prev(o); resolve(o); }); })
        : new Promise<Outcome>((resolve) => settle.set(opId, resolve));
      set({ pending: withPending((m) => m.set(opId, { opId, op: entryOp, seq: keepSeq ?? ++seq, outcome: { status: "sending" }, ...(files ? { files } : {}) })) });
      const { reqId: _, ...body } = msg;
      request<Outcome>(body).then((o) => {
        if (o.status === "failed") set({ pending: withPending((m) => { const e = m.get(opId); if (e) m.set(opId, { ...e, outcome: o }); }) });
        else if (o.status === "committed" && state.pending.has(opId)) {
          // The tool response can overtake its revision event. Keep the preview until the document catches up.
          if ((state.committed?.revision ?? -1) < o.revision) return;
          set({ pending: withPending((m) => m.delete(opId)) });
        }
        resolveOutcome(opId, o);
      }, () => set({ pending: withPending((m) => { const e = m.get(opId); if (e) m.set(opId, { ...e, outcome: { status: "unknown" } }); }) }));
      return { id: opId, settled: () => p };
    };

    return {
      screenId, transportKind: transport.kind, readContent: service.readContent, poster: (itemId, contentVersion) => service.poster(screenId, itemId, undefined, contentVersion),
      get: () => state,
      subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); },
      submit: (op, files) => submitWith(newId(), op, files),
      retry: (opId) => {
        const e = state.pending.get(opId); if (!e) return;
        if (e.outcome.status === "unknown" || e.outcome.status === "accepted") { void recover(opId); return; }
        // The new entry goes in before the failed one leaves, so its files are never unclaimed in between.
        if (e.outcome.status === "failed" && e.op.type !== "undo" && e.op.type !== "redo") { submitWith(newId(), e.op as Operation, e.files); set({ pending: withPending((m) => m.delete(opId)) }); }
      },
      dismiss: (opId) => set({ pending: withPending((m) => m.delete(opId)) }),
      undo: () => { const opId = newId(); return send(opId, { type: "undo" }, { t: "history", reqId: "", screenId, direction: "undo", opId }); },
      redo: () => { const opId = newId(); return send(opId, { type: "redo" }, { t: "history", reqId: "", screenId, direction: "redo", opId }); },
      transient: (gestureId, rects) => post({ t: "transient", screenId, gestureId, rects }),
      publishContext: (context) => post({ t: "context", screenId, context }),
      onViewCommand: (cb) => { viewSubs.add(cb); return () => viewSubs.delete(cb); },
      answerViewCommand: (id, outcome) => post({ t: "viewCommandAnswer", id, outcome }),
      // The shared connection stays open for the library, so leaving a Screen says so: get_view no longer finds it open.
      close: () => { left = true; post({ t: "leave", screenId }); listeners.delete(onServer); connListeners.delete(onConn); subs.clear(); if (remoteTimer) clearTimeout(remoteTimer); },
    };
  }

  async function openLibraryClient(): Promise<LibraryClient> {
    let state: LibraryState = { connection: "connecting", catalog: null, pending: new Map(), history: { canUndo: false, canRedo: false } };
    const subs = new Set<() => void>();
    const settle = new Map<string, (o: Outcome) => void>();
    const recovering = new Set<string>();
    let left = false;
    const set = (patch: Partial<LibraryState>) => { state = { ...state, ...patch }; for (const s of subs) s(); };
    const withPending = (fn: (m: Map<string, LibraryPendingEntry>) => void) => { const m = new Map(state.pending); fn(m); return m; };
    const done = (opId: string, o: Outcome) => { if (o.status === "committed" || o.status === "failed") { const f = settle.get(opId); settle.delete(opId); f?.(o); } };
    const refresh = async () => {
      const r = await request<LibraryOpenResult>({ t: "openLibrary" });
      if (left) return;
      set({ connection: "ready", catalog: (state.catalog?.version ?? -1) > r.catalog.version ? state.catalog : r.catalog, history: { canUndo: r.canUndo, canRedo: r.canRedo } });
    };
    const recover = async (opId: string) => {
      if (recovering.has(opId)) return;
      recovering.add(opId);
      try {
        while (!left && !closed && transport.connected && state.pending.has(opId)) {
          const o = await request<Outcome>({ t: "status", opId });
          if (left || !state.pending.has(opId)) return;
          if (o.status === "committed" && (state.catalog?.version ?? -1) < o.revision) await refresh();
          if (left || !state.pending.has(opId)) return;
          set({ pending: withPending((m) => { const e = m.get(opId); if (!e) return; if (o.status === "committed") m.delete(opId); else m.set(opId, { ...e, outcome: o }); }) });
          done(opId, o);
          if (o.status !== "accepted") return;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch { /* A reconnect resumes the status check. */ }
      finally { recovering.delete(opId); }
    };
    const load = async () => {
      await refresh();
      for (const e of state.pending.values()) if (e.outcome.status === "unknown" || e.outcome.status === "accepted") void recover(e.opId);
    };
    const onServer = (m: ServerMessage) => {
      if (m.t === "libraryHistory") { set({ history: { canUndo: m.canUndo, canRedo: m.canRedo } }); return; }
      if (m.t !== "catalog" || !state.catalog) return;
      if (m.version <= state.catalog.version) return;
      // A gap means a missed change set: reload rather than guess.
      if (m.version !== state.catalog.version + 1) { load().catch(() => {}); return; }
      set({ catalog: { ...applyChanges(state.catalog, m.changes), version: m.version }, pending: m.opId && state.pending.has(m.opId) ? withPending((p) => p.delete(m.opId!)) : state.pending });
      if (m.opId) done(m.opId, { status: "committed", revision: m.version });
    };
    const onConn = (up: boolean) => {
      if (up) { load().catch(() => {}); return; }
      set({ connection: "reconnecting", pending: withPending((m) => { for (const [k, e] of m) if (e.outcome.status === "sending" || e.outcome.status === "accepted") m.set(k, { ...e, outcome: { status: "unknown" } }); }) });
    };
    listeners.add(onServer); connListeners.add(onConn);
    await load();

    const send = (opId: string, op: LibraryPendingEntry["op"], msg: RequestBody): OperationHandle => {
      const p = new Promise<Outcome>((resolve) => settle.set(opId, resolve));
      set({ pending: withPending((m) => m.set(opId, { opId, op, outcome: { status: "sending" } })) });
      request<Outcome>(msg).then((o) => {
        // A committed outcome with no change set (nothing changed in view) still retires the entry.
        if (o.status === "failed") set({ pending: withPending((m) => { const e = m.get(opId); if (e) m.set(opId, { ...e, outcome: o }); }) });
        else if (o.status === "committed" && state.pending.has(opId)) set({ pending: withPending((m) => m.delete(opId)) });
        done(opId, o);
      }, () => set({ pending: withPending((m) => { const e = m.get(opId); if (e) m.set(opId, { ...e, outcome: { status: "unknown" } }); }) }));
      return { id: opId, settled: () => p };
    };

    return {
      get: () => state,
      subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); },
      submit: (op) => { const opId = newId(); return send(opId, op, { t: "libraryOp", opId, op }); },
      purge: (targets) => { const opId = newId(); return send(opId, { type: "purge" }, { t: "purge", opId, targets }); },
      dismiss: (opId) => set({ pending: withPending((m) => m.delete(opId)) }),
      undo: () => { const opId = newId(); return send(opId, { type: "undo" }, { t: "libraryHistory", direction: "undo", opId }); },
      redo: () => { const opId = newId(); return send(opId, { type: "redo" }, { t: "libraryHistory", direction: "redo", opId }); },
      close: () => { left = true; listeners.delete(onServer); connListeners.delete(onConn); subs.clear(); },
    };
  }

  return service;
}

export function errorText(e: OperationError | { code: string; message: string }): string { return e.message; }

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
