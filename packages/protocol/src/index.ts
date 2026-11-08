// Wire messages between the local service and its clients (canvas, MCP adapter, CLI).
// Only @screens/service and @screens/client import this package.

import type { AssetManifest, CatalogChange, ObjectDelta, FolderId, GuardedInverse, ItemId, Layout, LibraryCatalog, LibraryOperation, LibraryRef, MediaEntry, MediaSort, Operation, OperationError, OperationId, Placement, Point, Rect, ScreenDoc, ScreenId, SessionId, SnapshotWarning, ThreadId } from "@screens/core";

export const PROTOCOL_VERSION = 1;

/** What the service found when it test-loaded one snapshot content. Kept in the receipt, so a replay reports the same. */
export interface SnapshotCheck {
  readonly itemId: ItemId;
  readonly contentVersion: string;
  readonly poster: { readonly hash: string; readonly width: number; readonly height: number } | null;
  readonly warnings: readonly SnapshotWarning[];
}

export type Outcome =
  | { readonly status: "accepted" }
  /** note: another participant is working on an item this op changed, e.g. "Ada is working on Checkout". Presence only. */
  | { readonly status: "committed"; readonly revision: number; readonly checks?: readonly SnapshotCheck[]; readonly objects?: readonly ObjectDelta[]; readonly note?: string }
  | { readonly status: "failed"; readonly error: OperationError | { readonly code: "storage" | "corrupt"; readonly message: string }
      | { readonly code: "not-loaded"; readonly message: string; readonly checks: readonly SnapshotCheck[] }
      /** The op names content the store does not have: upload it first. */
      | { readonly code: "missing-content"; readonly message: string; readonly hashes: readonly string[] }
      /** Client side: the op's files could not be uploaded, so it was never sent. */
      | { readonly code: "upload"; readonly message: string } }
  | { readonly status: "unknown" };

/** The one identity of a snapshot bundle: the frame cache, the validator and the canvas all key on it.
 *  The service refuses an operation whose contentVersion is not this value. Runs in Node and the browser. */
export async function contentVersionOf(entry: string, manifest: AssetManifest): Promise<string> {
  const canonical = JSON.stringify([entry, Object.keys(manifest).sort().map((p) => [p, manifest[p]!.hash, manifest[p]!.mediaType])]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return Array.from(digest.subarray(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Built from the catalog, never from a document. */
export interface ScreenSummary {
  readonly damaged?: boolean;
  readonly id: ScreenId; readonly title: string; readonly revision: number; readonly createdAt: number; readonly updatedAt: number; readonly itemCount: number;
  readonly folderId: FolderId | null; readonly archived: boolean; readonly lastOpenedAt: number | null;
  readonly layout: Layout;
}
export interface LibraryOpenResult { readonly catalog: LibraryCatalog; readonly canUndo: boolean; readonly canRedo: boolean }
export interface MediaSearchResult { readonly total: number; readonly items: readonly MediaEntry[] }
/** activeThread: the comment thread the person has open. pages: on a Presentation or Document, which view the person
 *  has (scroll, grid or present) and the page at the top of it, or the slide presented. viewport stays in stored world
 *  units in every view. */
export interface ViewContext { readonly viewId: string; readonly focused: ItemId | null; readonly interacting: ItemId | null; readonly selection: readonly ItemId[]; readonly viewport: Rect; readonly busy: boolean; readonly activeThread: ThreadId | null;
  readonly pages?: { readonly view: PagesView; readonly page: number } | null }
export type PagesView = "scroll" | "grid" | "present";
export type ViewCommand =
  | { readonly id: string; readonly kind: "show"; readonly itemIds: readonly ItemId[]; readonly issuedAt: number }
  | { readonly id: string; readonly kind: "focus"; readonly itemId: ItemId; readonly issuedAt: number }
  | { readonly id: string; readonly kind: "exit-focus"; readonly issuedAt: number };
export type ViewCommandOutcome = "applied" | "deferred" | "dropped";

// ── Presence: who is on a Screen and what they are doing. Never part of a ScreenDoc, never stored, never in undo or export. ──

/** Random per participant, assigned by the service. Never accepted from a client, unlike a sessionId, so it is safe to broadcast. */
export type ParticipantId = string;
/** Where a participant works. An item today; `layer` is reserved for a layer inside an HTML snapshot and is not resolved yet. */
export interface PresenceTarget { readonly itemId: ItemId; readonly layer?: string }
export type CallVerb = "add" | "update" | "arrange" | "retitle" | "reorder" | "remove" | "comment" | "draw" | "rename";
/** One participant on one Screen. The local person is never listed: every canvas tab on this machine is that person. */
export interface Participant {
  readonly id: ParticipantId;
  readonly kind: "person" | "agent";
  readonly name: string;
  /** Presence color slot, 0-based: the lowest free on this Screen when the participant joined it. Never blue. */
  readonly color: number;
  /** What the participant says it is doing. Set by set_status; expires PRESENCE_STATUS_MS after the last activity unless a call is in flight. */
  readonly status: { readonly text: string; readonly target: PresenceTarget | null } | null;
  /** The operation in flight, derived by the service from the op itself. */
  readonly call: { readonly verb: CallVerb; readonly targets: readonly ItemId[] } | null;
  /** An object on its way: the slot reserved for it. "checking": its add is being test-loaded; itemId is the item it will become. */
  readonly incoming: { readonly rect: Rect; readonly phase: "announced" | "checking"; readonly itemId: ItemId | null } | null;
  /** An object being written in parts (add_snapshot or update_snapshot with more). itemId null: a new object, shown in the
   *  reservation. The text travels in `draft` messages; rev counts its parts. Never stored, never shown as saved. */
  readonly draft: { readonly itemId: ItemId | null; readonly rev: number; readonly bytes: number } | null;
  /** Service clock of the last call or patch on this Screen. */
  readonly activeAt: number;
}
/** What set_status sends. Omitted fields keep their value. status null clears the status and any reservation. */
export interface PresencePatch {
  readonly status?: { readonly text: string; readonly itemId: ItemId | null } | null;
  /** Reserve a slot for a new object of this size, placed by core's nextSlot. */
  readonly incoming?: { readonly width: number; readonly height: number } | null;
}
/** A status lasts this long after the participant's last activity. A reservation lasts PRESENCE_INCOMING_MS, because a model
 *  writing a long object sends nothing until its call arrives. Idle participants leave the roster after PRESENCE_IDLE_MS. */
export const PRESENCE_STATUS_MS = 30_000, PRESENCE_INCOMING_MS = 120_000, PRESENCE_IDLE_MS = 5 * 60_000;
/** The most draft text one participant holds on a Screen. A longer object commits without a live draft. */
export const DRAFT_MAX_CHARS = 2_000_000;
/** Another participant, as an agent reads it in get_view. */
export interface OtherParticipant { readonly name: string; readonly status: string | null; readonly itemId: ItemId | null }

/** A binary WebSocket frame is always one upload chunk: [u16 BE header length][header JSON][bytes].
 *  The service answers it with a text `result` of the same reqId whose value is { held }. */
export interface ChunkHeader { readonly reqId: string; readonly hash: string; readonly size: number; readonly offset: number }
/** The most a client sends in one chunk. The service refuses a frame over twice this. */
export const CHUNK_BYTES = 1 << 20;
export function encodeChunk(h: ChunkHeader, bytes: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(h));
  const out = new Uint8Array(2 + head.length + bytes.length);
  new DataView(out.buffer).setUint16(0, head.length);
  out.set(head, 2); out.set(bytes, 2 + head.length);
  return out;
}
export function decodeChunk(frame: Uint8Array): { readonly header: ChunkHeader; readonly bytes: Uint8Array } | null {
  if (frame.length < 2) return null;
  const n = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint16(0);
  if (frame.length < 2 + n) return null;
  try {
    const h = JSON.parse(new TextDecoder().decode(frame.subarray(2, 2 + n))) as ChunkHeader;
    if (typeof h.reqId !== "string" || typeof h.hash !== "string" || !Number.isInteger(h.size) || !Number.isInteger(h.offset)) return null;
    return { header: h, bytes: frame.subarray(2 + n) };
  } catch { return null; }
}

/** What importScreen answers. A receipt keeps it, so a replay of the opId returns the same. */
export type ImportOutcome =
  | { readonly status: "committed"; readonly screenId: ScreenId; readonly title: string; readonly revision: number }
  | { readonly status: "failed"; readonly error:
      | { readonly code: "exists"; readonly message: string; readonly identical: boolean }
      | { readonly code: "format" | "invalid" | "limit" | "missing-content" | "storage" | "corrupt" | "upload"; readonly message: string } }
  | { readonly status: "unknown" };

/** Requests carry reqId; the service answers each with exactly one `result` of the same reqId. */
export type ClientMessage =
  /** name: the agent host's client name (MCP clientInfo), shown on the canvas. */
  /** surface "app": a canvas relayed from an MCP App view (Codex), not a browser tab. */
  | { readonly t: "hello"; readonly protocol: number; readonly token: string; readonly role: "canvas" | "agent"; readonly sessionId?: SessionId; readonly name?: string; readonly surface?: "app" }
  | { readonly t: "open"; readonly reqId: string; readonly screenId: ScreenId }
  /** request: the caller's own input, when the op is derived from state that can change before a retry (a comment point in
   *  item pixels becomes fractions of the item's current size). The receipt then compares request, not op.
   *  lane: which of this connection's agents sent it, when several share one connection (subagents). Absent: the connection's own. */
  | { readonly t: "op"; readonly reqId: string; readonly screenId: ScreenId; readonly opId: OperationId; readonly op: Operation; readonly request?: unknown; readonly lane?: string; readonly draftGeneration?: string }
  | { readonly t: "status"; readonly reqId: string; readonly opId: OperationId; readonly identity?: { readonly screenId: ScreenId; readonly request: unknown } }
  | { readonly t: "history"; readonly reqId: string; readonly screenId: ScreenId; readonly direction: "undo" | "redo"; readonly opId: OperationId }
  /** Screens from the catalog. Archived ones only with archived=true. query matches titles. */
  | { readonly t: "list"; readonly reqId: string; readonly folderId?: FolderId | null; readonly archived?: boolean; readonly query?: string }
  | { readonly t: "create"; readonly reqId: string; readonly title: string; readonly folderId?: FolderId; readonly layout?: Layout }
  /** Subscribes this connection to catalog changes and returns the catalog. */
  | { readonly t: "openLibrary"; readonly reqId: string }
  | { readonly t: "libraryOp"; readonly reqId: string; readonly opId: OperationId; readonly op: LibraryOperation }
  | { readonly t: "libraryHistory"; readonly reqId: string; readonly direction: "undo" | "redo"; readonly opId: OperationId }
  /** Permanent delete of archived things. Refused unless the connection is a person's canvas. Not undoable. */
  | { readonly t: "purge"; readonly reqId: string; readonly opId: OperationId; readonly targets: readonly LibraryRef[] | "all" }
  | { readonly t: "searchMedia"; readonly reqId: string; readonly query: string; readonly sort?: MediaSort; readonly archived?: boolean; readonly offset?: number; readonly limit?: number }
  /** Start or resume an upload. Answer: { held }, the bytes of (hash, size) the service holds. held === size: nothing to send. */
  | { readonly t: "upload"; readonly reqId: string; readonly hash: string; readonly size: number }
  /** Restore an exported Screen whose header and files are uploaded. `head` is the header's hash. Answer: ImportOutcome. */
  | { readonly t: "importScreen"; readonly reqId: string; readonly opId: OperationId; readonly head: string }
  | { readonly t: "readContent"; readonly reqId: string; readonly hash: string }
  /** The current picture of an object, rendered when missing. pieces crops it to their union. Answer: PosterAnswer. */
  | { readonly t: "poster"; readonly reqId: string; readonly screenId: ScreenId; readonly itemId: ItemId; readonly pieces?: readonly string[]; readonly contentVersion?: string }
  /** One overview image of a Screen from its stored pictures, with a legend. Answer: MontageAnswer. */
  | { readonly t: "montage"; readonly reqId: string; readonly screenId: ScreenId; readonly rect?: Rect; readonly maxSize?: number; readonly labels?: boolean }
  | { readonly t: "transient"; readonly screenId: ScreenId; readonly gestureId: string; readonly rects: Readonly<Record<ItemId, Placement>> | null }
  | { readonly t: "context"; readonly screenId: ScreenId; readonly context: ViewContext }
  /** The canvas stopped showing this Screen; its view context goes. */
  | { readonly t: "leave"; readonly screenId: ScreenId }
  /** lane: the asking agent, left out of `others`. */
  /** app: read only MCP App views of the Screen (Codex), not a browser tab on it. */
  | { readonly t: "readContext"; readonly reqId: string; readonly screenId: ScreenId; readonly lane?: string; readonly app?: boolean }
  /** The Screens open in canvases, most recently active first. Answer: { screenId, at, app }[]; app marks an MCP App view. */
  | { readonly t: "views"; readonly reqId: string }
  | { readonly t: "viewCommand"; readonly reqId: string; readonly screenId: ScreenId; readonly command: ViewCommand }
  | { readonly t: "viewCommandAnswer"; readonly id: string; readonly outcome: ViewCommandOutcome }
  /** An agent's status or reservation. Answer: { placement: Rect | null }, the reserved slot. lane as in `op`. */
  | { readonly t: "presence"; readonly reqId: string; readonly screenId: ScreenId; readonly lane?: string; readonly patch: PresencePatch }
  /** One part of an object being written: appended to the participant's draft for itemId (null: a new object). Answer: { rev, bytes }. */
  | { readonly t: "draft"; readonly reqId: string; readonly screenId: ScreenId; readonly lane?: string; readonly itemId: ItemId | null; readonly text: string; readonly generation?: string }
  /** Dev only: refused unless the service runs with --dev and the secret matches its dev.secret file. */
  | { readonly t: "inspect"; readonly reqId: string; readonly devSecret: string }
  | { readonly t: "fault"; readonly reqId: string; readonly devSecret: string; readonly fault: Fault };

/** Dev-only fault injection. A fault delays or fails the real commit path; it never supplies a document or a receipt. */
export type Fault =
  | { readonly kind: "delay-commit"; readonly ms: number; readonly count: number }
  | { readonly kind: "fail-commit"; readonly code: "storage" | "conflict"; readonly count: number }
  | { readonly kind: "drop-result"; readonly count: number }
  | { readonly kind: "crash"; readonly at: "before-write" | "after-write" | "after-content-flush" | "after-temp-write" | "after-temp-flush" | "after-rename" }
  | { readonly kind: "disk-full"; readonly at: "content" | "poster" | "document" }
  | { readonly kind: "corrupt-document"; readonly screenId: ScreenId; readonly mode: "json" | "schema" | "threads" }
  | { readonly kind: "disconnect"; readonly sessionId: SessionId | null }
  /** The next `count` snapshot checks behave exactly as if Chrome failed to launch. */
  | { readonly kind: "no-browser"; readonly count: number }
  /** Close the uploading socket after it accepts `after` more chunks, `count` times. */
  | { readonly kind: "drop-upload"; readonly after: number; readonly count: number }
  /** Answer the `after`-th chunk from now with an error, so the client's upload rejects with the file partly held. */
  | { readonly kind: "fail-upload"; readonly after: number }
  /** Flip one byte in each of the next `count` chunks before staging sees them. */
  | { readonly kind: "corrupt-upload"; readonly count: number }
  /** Run the real expiry sweep as if every upload had sat idle past the limit. */
  | { readonly kind: "expire-uploads" }
  /** Run the presence sweep as if every participant had been idle past every limit. */
  | { readonly kind: "expire-presence" }
  | { readonly kind: "clear" };

/** What `inspect` returns. Never includes tokens, secrets or frame capabilities. */
export interface ServiceInspection {
  readonly instanceId: string;
  readonly dev: true;
  readonly uptimeMs: number;
  readonly commitStage: string | null;
  readonly conns: readonly { readonly sessionId: SessionId; readonly role: "canvas" | "agent"; readonly screens: readonly ScreenId[] }[];
  /** Operation IDs of undo and redo entries, newest last. */
  readonly stacks: readonly { readonly sessionId: SessionId; readonly screenId: ScreenId; readonly undo: readonly OperationId[]; readonly redo: readonly OperationId[] }[];
  readonly receipts: { readonly size: number; readonly last: readonly { readonly opId: OperationId; readonly status: Outcome["status"] }[] };
  readonly contexts: readonly { readonly screenId: ScreenId; readonly sessionId: SessionId; readonly selection: readonly ItemId[]; readonly focused: ItemId | null; readonly busy: boolean }[];
  readonly pendingViewCommands: number;
  /** docReads counts Screen documents parsed since startup: listing and searching the library must not add to it. */
  readonly library: { readonly docReads: number; readonly catalogVersion: number; readonly subscribers: number };
  /** Uploads in progress (hash shortened to 12), and chunk bytes received since start, resends included. */
  readonly uploads: { readonly entries: readonly { readonly hash: string; readonly size: number; readonly held: number; readonly idleMs: number }[]; readonly offered: number };
  readonly faults: readonly Fault[];
}

export type ServerMessage =
  | { readonly t: "welcome"; readonly instanceId: string; readonly sessionId: SessionId; readonly protocol: number }
  | { readonly t: "result"; readonly reqId: string; readonly ok: true; readonly value: unknown }
  | { readonly t: "result"; readonly reqId: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
  /** Sent after every commit, never before. Carries the whole document in v1. */
  | { readonly t: "revision"; readonly screenId: ScreenId; readonly doc: ScreenDoc; readonly opId: OperationId | null; readonly sessionId: SessionId | null }
  | { readonly t: "history"; readonly screenId: ScreenId; readonly canUndo: boolean; readonly canRedo: boolean }
  | { readonly t: "transient"; readonly screenId: ScreenId; readonly sessionId: SessionId; readonly rects: Readonly<Record<ItemId, Placement>> | null }
  | { readonly t: "viewCommand"; readonly screenId: ScreenId; readonly command: ViewCommand }
  /** Every participant on the Screen, coalesced to at most one message per 100 ms. now: the service clock. Canvases only. */
  | { readonly t: "roster"; readonly screenId: ScreenId; readonly now: number; readonly participants: readonly Participant[] }
  /** A participant's draft text. append: add to what the canvas holds at rev - 1; otherwise the whole text. null text ends it. Canvases only. */
  | { readonly t: "draft"; readonly screenId: ScreenId; readonly participant: ParticipantId; readonly itemId: ItemId | null; readonly rev: number; readonly text: string | null; readonly append: boolean }
  /** To library subscribers after every catalog commit, never before. */
  | { readonly t: "catalog"; readonly version: number; readonly changes: readonly CatalogChange[]; readonly opId: OperationId | null; readonly sessionId: SessionId | null }
  | { readonly t: "libraryHistory"; readonly canUndo: boolean; readonly canRedo: boolean };

/** An object's picture for its current content. hash is null when it cannot be rendered (warnings say why). */
export interface PosterAnswer {
  readonly itemId: ItemId; readonly contentVersion: string; readonly hash: string | null; readonly width: number; readonly height: number;
  /** The cropped region in CSS pixels of the object, when pieces were asked for. */
  readonly rect: Rect | null;
  readonly warnings: readonly SnapshotWarning[];
}

/** A Screen overview. image is base64 JPEG, null when nothing intersects the region or Chrome is unavailable (warnings say
 *  which). world is the region the image covers: image px = (world px - world.x) * scale. items are front to back, each
 *  with its visible rect in image pixels. Never stored: a montage is not content. */
export interface MontageAnswer {
  readonly image: string | null; readonly width: number; readonly height: number; readonly scale: number; readonly world: Rect;
  readonly items: readonly { readonly id: ItemId; readonly title: string; readonly kind: string; readonly rect: Rect; readonly partial?: true }[];
  readonly strokes: number;
  readonly warnings: readonly string[];
}

/** What `open` returns. */
export interface OpenResult { readonly doc: ScreenDoc; readonly frameOrigin: string; readonly frameCapability: string; readonly canUndo: boolean; readonly canRedo: boolean }
/** What an undo/redo entry holds inside the service. Never sent to clients. */
export interface HistoryEntry { readonly opId: OperationId; readonly inverse: GuardedInverse }

export * from "./archive.ts";

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw) as { t?: unknown };
    return m && typeof m === "object" && typeof m.t === "string" ? (m as ClientMessage) : null;
  } catch { return null; }
}
