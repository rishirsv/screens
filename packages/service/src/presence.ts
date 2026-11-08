// Presence: who is on each Screen and what they are doing. The only writer of roster state. Nothing here is stored,
// undone or exported; a service restart forgets all of it.

import crypto from "node:crypto";
import { nextSlot, type Author, type ItemId, type Operation, type Rect, type ScreenDoc } from "@screens/core";
import { DRAFT_MAX_CHARS, PRESENCE_IDLE_MS, PRESENCE_INCOMING_MS, PRESENCE_STATUS_MS, type CallVerb, type ServerMessage, type OtherParticipant, type Outcome, type Participant, type PresencePatch } from "@screens/protocol";

/** Seven presence colors (tokens --presence-1..7). An eighth participant on a Screen reuses one. */
const COLORS = 7;
const BROADCAST_MS = 100;
const SWEEP_MS = 1000;

/** One connection, as presence sees it. The service passes its own connection objects; presence only uses them as keys. */
export type ConnKey = object;

interface Draft { readonly itemId: ItemId | null; readonly text: string; readonly rev: number; readonly generation?: string }
interface OnScreen {
  color: number;
  status: { text: string; target: { itemId: ItemId } | null } | null;
  /** Ops in flight, by opId, oldest first: an agent can run several tool calls at once. */
  calls: Map<string, { verb: CallVerb; targets: readonly ItemId[] }>;
  /** A settled call may end only the draft it began saving, never text received while it was pending. */
  savingDrafts: Map<string, Draft | null>;
  incoming: { rect: Rect; phase: "announced" | "checking"; itemId: ItemId | null; opId: string | null } | null;
  /** The object being written in parts. Lives as long as a reservation would: PRESENCE_INCOMING_MS after the last part. */
  draft: Draft | null;
  activeAt: number;
  incomingAt: number;
}
interface Lane { id: string; name: string; screens: Map<string, OnScreen> }
interface ConnPresence { base: string; ordinal: number; lanes: Map<string, Lane> }

export interface PresenceDeps {
  now(): number;
  doc(screenId: string): ScreenDoc | null;
  /** Sends to every canvas connection that has the Screen open. Agents never receive presence. */
  toCanvases(screenId: string, m: ServerMessage): void;
}

export interface Presence {
  /** An agent connection said hello. clientName comes from the MCP host. Canvas connections are the local person and never join. */
  hello(conn: ConnKey, clientName: string | undefined): void;
  /** Socket closed: every lane of the connection leaves every Screen at once. */
  leave(conn: ConnKey): void;
  /** set_status. Returns the reserved slot, if any. */
  patch(conn: ConnKey, screenId: string, lane: string | undefined, p: PresencePatch): { placement: Rect | null };
  /** Inside the Screen's commit queue: an agent's add without x/y lands in its reservation as the reservation is now. */
  place(conn: ConnKey, screenId: string, lane: string | undefined, opId: string, op: Operation): Operation;
  /** An agent op arrived. Returns a note when another participant is on an item the op changes. */
  opStarted(conn: ConnKey, screenId: string, lane: string | undefined, opId: string, op: Operation, draftGeneration?: string): string | null;
  /** The op settled. A committed add consumes the reservation it filled; a refused one returns it to "announced". */
  opSettled(conn: ConnKey, screenId: string, lane: string | undefined, opId: string, outcome: Outcome): void;
  /** After every commit on the Screen: a reservation a committed item now overlaps moves to the next free slot. */
  revised(screenId: string): void;
  /** One part of an object being written. Throws a coded "limit" error past DRAFT_MAX_CHARS, and the object then commits without a draft. */
  draft(conn: ConnKey, screenId: string, lane: string | undefined, itemId: ItemId | null, text: string, generation?: string): { rev: number; bytes: number };
  /** A canvas opened the Screen: it gets the roster and every draft in full. */
  opened(screenId: string): void;
  /** Items the person is dragging or resizing on a Screen, from their live preview. null ends it. */
  personMoving(conn: ConnKey, screenId: string, itemIds: readonly ItemId[] | null): void;
  /** Comment and stroke author for an agent op. */
  author(conn: ConnKey, lane: string | undefined): Author;
  /** Everyone on the Screen except the asking agent, for get_view. Its siblings on the same connection are included. */
  others(screenId: string, conn: ConnKey, lane: string | undefined): readonly OtherParticipant[];
  /** Dev: sweep as if every limit had passed. */
  expireAll(): void;
}

const pretty = (s: string) => s.replace(/[-_]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 32) || "Agent";
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function createPresence(deps: PresenceDeps): Presence {
  const conns = new Map<ConnKey, ConnPresence>();
  const moving = new Map<string, Map<ConnKey, readonly ItemId[]>>(); // screenId → person conn → items
  const dirty = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  const lanesOn = (screenId: string) => [...conns.values()].flatMap((c) => [...c.lanes.values()].flatMap((l) => { const o = l.screens.get(screenId); return o ? [{ l, o }] : []; }));
  const participant = (l: Lane, o: OnScreen): Participant => ({
    id: l.id, kind: "agent", name: l.name, color: o.color, activeAt: o.activeAt,
    status: o.status ? { text: o.status.text, target: o.status.target } : null,
    call: [...o.calls.values()].at(-1) ?? null,
    incoming: o.incoming ? { rect: o.incoming.rect, phase: o.incoming.phase, itemId: o.incoming.itemId } : null,
    draft: o.draft ? { itemId: o.draft.itemId, rev: o.draft.rev, bytes: o.draft.text.length } : null,
  });
  /** Ends a draft on every canvas. */
  const endDraft = (screenId: string, l: Lane, o: OnScreen) => {
    if (!o.draft) return;
    deps.toCanvases(screenId, { t: "draft", screenId, participant: l.id, itemId: o.draft.itemId, rev: o.draft.rev + 1, text: null, append: false });
    o.draft = null;
  };
  const roster = (screenId: string) => lanesOn(screenId).map(({ l, o }) => participant(l, o));

  /** Coalesced: at most one roster per Screen per BROADCAST_MS. */
  const touch = (screenId: string) => {
    dirty.add(screenId);
    flushTimer ??= setTimeout(() => {
      flushTimer = null;
      const now = deps.now();
      for (const id of dirty) deps.toCanvases(id, { t: "roster", screenId: id, now, participants: roster(id) });
      dirty.clear();
    }, BROADCAST_MS);
    sweepTimer ??= setInterval(() => sweep(deps.now()), SWEEP_MS);
    sweepTimer.unref?.();
  };

  /** Expires statuses, reservations and idle participants. Stops itself when nobody is left. */
  const sweep = (now: number) => {
    for (const c of conns.values()) for (const l of c.lanes.values()) for (const [screenId, o] of l.screens) {
      if (o.calls.size) continue;
      let changed = false;
      if (o.status && now - o.activeAt >= PRESENCE_STATUS_MS) { o.status = null; changed = true; }
      if (o.incoming && o.incoming.phase === "announced" && now - o.incomingAt >= PRESENCE_INCOMING_MS) { o.incoming = null; changed = true; }
      if (o.draft && now - o.activeAt >= PRESENCE_INCOMING_MS) { endDraft(screenId, l, o); changed = true; }
      if (!o.status && !o.incoming && !o.draft && now - o.activeAt >= PRESENCE_IDLE_MS) { l.screens.delete(screenId); changed = true; }
      if (changed) touch(screenId);
    }
    if (![...conns.values()].some((c) => [...c.lanes.values()].some((l) => l.screens.size)) && sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  };

  const nameTaken = (name: string) => [...conns.values()].some((c) => [...c.lanes.values()].some((l) => l.name === name));
  const unique = (name: string) => { if (!nameTaken(name)) return name; for (let i = 2; ; i++) if (!nameTaken(`${name} ${i}`)) return `${name} ${i}`; };

  const laneOf = (conn: ConnKey, lane: string | undefined): Lane | null => {
    const c = conns.get(conn); if (!c) return null;
    const key = (lane ?? "").trim().slice(0, 40);
    let l = c.lanes.get(key);
    if (!l) {
      l = { id: crypto.randomBytes(9).toString("base64url"), name: key ? unique(key) : c.ordinal > 1 || nameTaken(c.base) ? `${c.base} ${c.ordinal}` : c.base, screens: new Map() };
      c.lanes.set(key, l);
    }
    return l;
  };
  /** Joins the Screen on first activity, with the lowest color free there. */
  const onScreen = (l: Lane, screenId: string, now: number): OnScreen => {
    let o = l.screens.get(screenId);
    if (!o) {
      const used = new Set(lanesOn(screenId).map((x) => x.o.color));
      let color = 0; while (used.has(color) && color < COLORS) color++;
      o = { color: color % COLORS, status: null, calls: new Map(), savingDrafts: new Map(), incoming: null, draft: null, activeAt: now, incomingAt: now };
      l.screens.set(screenId, o);
    }
    o.activeAt = now;
    return o;
  };

  const reserved = (screenId: string, except: OnScreen) => lanesOn(screenId).flatMap(({ o }) => (o !== except && o.incoming ? [o.incoming.rect] : []));

  return {
    hello(conn, clientName) {
      const base = pretty(clientName ?? "Agent");
      const ordinals = new Set([...conns.values()].filter((c) => c.base === base).map((c) => c.ordinal));
      let ordinal = 1; while (ordinals.has(ordinal)) ordinal++;
      conns.set(conn, { base, ordinal, lanes: new Map() });
    },
    leave(conn) {
      const c = conns.get(conn);
      if (c) { conns.delete(conn); for (const l of c.lanes.values()) for (const [id, o] of l.screens) { endDraft(id, l, o); touch(id); } }
      for (const [id, m] of moving) if (m.delete(conn)) touch(id);
    },
    patch(conn, screenId, lane, p) {
      const l = laneOf(conn, lane); if (!l) return { placement: null };
      const now = deps.now(), o = onScreen(l, screenId, now);
      if (p.status !== undefined) {
        const text = p.status ? clip(p.status.text.trim().replace(/\s+/g, " "), 80) : "";
        const doc = deps.doc(screenId);
        const itemId = p.status?.itemId && doc?.items[p.status.itemId] ? p.status.itemId : null;
        o.status = text || itemId ? { text, target: itemId ? { itemId } : null } : null;
        // Clearing the status gives up a reservation that is not already being saved, and any draft.
        if (!o.status && o.incoming?.phase === "announced") o.incoming = null;
        if (!o.status) endDraft(screenId, l, o);
      }
      if (p.incoming !== undefined) {
        if (p.incoming === null) { if (o.incoming?.phase === "announced") o.incoming = null; }
        else {
          const doc = deps.doc(screenId);
          const w = Math.min(Math.max(Math.round(p.incoming.width), 24), 8000), h = Math.min(Math.max(Math.round(p.incoming.height), 24), 8000);
          const at = doc ? nextSlot(doc, reserved(screenId, o)) : { x: 0, y: 0 };
          o.incoming = { rect: { x: at.x, y: at.y, w, h }, phase: "announced", itemId: null, opId: null };
          o.incomingAt = now;
        }
      }
      touch(screenId);
      return { placement: o.incoming?.rect ?? null };
    },
    opStarted(conn, screenId, lane, opId, op, draftGeneration) {
      const l = laneOf(conn, lane); if (!l) return null;
      const now = deps.now(), o = onScreen(l, screenId, now);
      const { verb, targets, added } = describe(op);
      if (!o.calls.has(opId)) o.savingDrafts.set(opId, draftGeneration === undefined || o.draft?.generation === draftGeneration ? o.draft : null);
      o.calls.set(opId, { verb, targets });
      // An add that names no position fills the reservation; place() resolves where it is at commit time.
      if (added && added.x === undefined && added.y === undefined && o.incoming?.phase === "announced")
        o.incoming = { ...o.incoming, phase: "checking", itemId: added.id, opId };
      o.incomingAt = now;
      touch(screenId);
      return noteFor(screenId, l, targets);
    },
    place(conn, screenId, lane, opId, op) {
      const o = laneOf(conn, lane)?.screens.get(screenId);
      if (op.type !== "addItem" || op.item.x !== undefined || op.item.y !== undefined || o?.incoming?.opId !== opId) return op;
      // A page is placed by order: core appends it where the reservation points, and refuses an x or y.
      if (deps.doc(screenId)?.layout) return op;
      return { ...op, item: { ...op.item, x: o.incoming.rect.x, y: o.incoming.rect.y } };
    },
    opSettled(conn, screenId, lane, opId, outcome) {
      const l = laneOf(conn, lane); if (!l) return;
      const o = l.screens.get(screenId); if (!o) return;
      o.activeAt = o.incomingAt = deps.now();
      // The commit that saves a draft's object ends it: an add for a new object, an update for an item's.
      const call = o.calls.get(opId);
      if (outcome.status === "committed" && o.draft && o.savingDrafts.get(opId) === o.draft && call
        && (o.draft.itemId === null ? call.verb === "add" : call.verb === "update" && call.targets.includes(o.draft.itemId))) endDraft(screenId, l, o);
      o.calls.delete(opId);
      o.savingDrafts.delete(opId);
      if (o.incoming?.opId === opId) {
        if (outcome.status !== "committed") o.incoming = { ...o.incoming, phase: "announced", itemId: null, opId: null };
        else if (o.draft?.itemId === null) {
          // The saved object's slot is consumed, but the next generation still needs a preview of its own.
          const doc = deps.doc(screenId), at = doc ? nextSlot(doc, reserved(screenId, o)) : { x: 0, y: 0 };
          const saving = [...o.calls].find(([id, call]) => call.verb === "add" && o.savingDrafts.get(id) === o.draft);
          o.incoming = { rect: { ...o.incoming.rect, x: at.x, y: at.y }, phase: saving ? "checking" : "announced", itemId: saving?.[1].targets[0] ?? null, opId: saving?.[0] ?? null };
        } else o.incoming = null;
      }
      touch(screenId);
    },
    revised(screenId) {
      const doc = deps.doc(screenId); if (!doc) return;
      const items = Object.values(doc.items);
      for (const { o } of lanesOn(screenId)) {
        // A reservation whose add is still being checked moves too: its position is read at commit. One already saved does not.
        const r = o.incoming && !(o.incoming.itemId && doc.items[o.incoming.itemId]) ? o.incoming.rect : null;
        if (!r || !items.some((it) => it.x < r.x + r.w && r.x < it.x + it.width && it.y < r.y + r.h && r.y < it.y + it.height)) continue;
        const at = nextSlot(doc, reserved(screenId, o));
        o.incoming = { ...o.incoming!, rect: { ...r, x: at.x, y: at.y } };
        touch(screenId);
      }
    },
    draft(conn, screenId, lane, itemId, text, generation) {
      const l = laneOf(conn, lane); if (!l) throw Object.assign(new Error("not an agent"), { code: "forbidden" });
      const now = deps.now(), o = onScreen(l, screenId, now);
      o.incomingAt = now;
      // A final can be uploading before opStarted runs. Explicit generation identity separates newer text even
      // in that window; legacy callers fall back to the captured-draft boundary once their operation arrives.
      if (o.draft && (o.draft.itemId !== itemId || o.draft.generation !== generation || [...o.savingDrafts.values()].includes(o.draft))) endDraft(screenId, l, o);
      const prior = o.draft?.text ?? "";
      if (prior.length + text.length > DRAFT_MAX_CHARS) throw Object.assign(new Error(`a draft holds at most ${DRAFT_MAX_CHARS} characters; send the rest as the final part`), { code: "limit" });
      o.draft = { itemId, text: prior + text, rev: (o.draft?.rev ?? 0) + 1, generation };
      // A new object written without set_status new still gets a spot to grow in.
      if (itemId === null && !o.incoming) {
        const doc = deps.doc(screenId), at = doc ? nextSlot(doc, reserved(screenId, o)) : { x: 0, y: 0 };
        o.incoming = { rect: { x: at.x, y: at.y, w: 390, h: 844 }, phase: "announced", itemId: null, opId: null };
      }
      deps.toCanvases(screenId, { t: "draft", screenId, participant: l.id, itemId, rev: o.draft.rev, text, append: o.draft.rev > 1 });
      touch(screenId);
      return { rev: o.draft.rev, bytes: o.draft.text.length };
    },
    opened(screenId) {
      for (const { l, o } of lanesOn(screenId)) if (o.draft) deps.toCanvases(screenId, { t: "draft", screenId, participant: l.id, itemId: o.draft.itemId, rev: o.draft.rev, text: o.draft.text, append: false });
      touch(screenId);
    },
    personMoving(conn, screenId, itemIds) {
      let m = moving.get(screenId);
      if (itemIds && itemIds.length) { if (!m) moving.set(screenId, m = new Map()); m.set(conn, itemIds); }
      else if (m) { m.delete(conn); if (!m.size) moving.delete(screenId); }
    },
    author(conn, lane) {
      const l = laneOf(conn, lane);
      return { kind: "agent", name: l?.name ?? "Agent" };
    },
    others(screenId, conn, lane) {
      const self = conns.get(conn)?.lanes.get((lane ?? "").trim().slice(0, 40));
      return lanesOn(screenId).filter(({ l }) => l !== self)
        .map(({ l, o }) => ({ name: l.name, status: o.status?.text || null, itemId: o.status?.target?.itemId ?? [...o.calls.values()].at(-1)?.targets[0] ?? null }));
    },
    expireAll() { sweep(deps.now() + PRESENCE_IDLE_MS + PRESENCE_INCOMING_MS); },
  };

  /** "Ada is working on Checkout": someone else targets, or the person is moving, an item this op changes. */
  function noteFor(screenId: string, self: Lane, targets: readonly ItemId[]): string | null {
    if (!targets.length) return null;
    const doc = deps.doc(screenId), title = (id: ItemId) => doc?.items[id]?.title ?? id;
    for (const m of moving.get(screenId)?.values() ?? []) { const hit = targets.find((t) => m.includes(t)); if (hit) return `The person is moving ${title(hit)}`; }
    for (const { l, o } of lanesOn(screenId)) {
      if (l === self) continue;
      const theirs = [o.status?.target?.itemId, ...[...o.calls.values()].flatMap((c) => c.targets)].filter((x): x is ItemId => !!x);
      const hit = targets.find((t) => theirs.includes(t));
      if (hit) return `${l.name} is working on ${title(hit)}`;
    }
    return null;
  }
}

/** What an op does, for the cursor and the note. `added`: the item an add creates, with its position. */
function describe(op: Operation): { verb: CallVerb; targets: ItemId[]; added: { id: ItemId; x: number | undefined; y: number | undefined } | null } {
  switch (op.type) {
    case "addItem": return { verb: "add", targets: [op.item.id], added: { id: op.item.id, x: op.item.x, y: op.item.y } };
    case "updateSnapshot": case "editObject": return { verb: "update", targets: [op.itemId], added: null };
    case "moveItems": return { verb: "arrange", targets: op.moves.map((m) => m.itemId), added: null };
    case "resizeItems": return { verb: "arrange", targets: op.sizes.map((m) => m.itemId), added: null };
    case "retitleItem": return { verb: "retitle", targets: [op.itemId], added: null };
    case "reorderItems": return { verb: "reorder", targets: [...op.itemIds], added: null };
    case "removeItems": return { verb: "remove", targets: [...op.itemIds], added: null };
    case "addThread": return { verb: "comment", targets: op.thread.anchor.kind === "item" ? [op.thread.anchor.itemId] : [], added: null };
    case "moveThread": return { verb: "comment", targets: op.anchor.kind === "item" ? [op.anchor.itemId] : [], added: null };
    case "addComment": case "editComment": case "resolveThread": case "removeComment": case "removeThread": return { verb: "comment", targets: [], added: null };
    case "addStroke": return { verb: "draw", targets: op.stroke.anchor.kind === "item" ? [op.stroke.anchor.itemId] : [], added: null };
    case "removeStroke": return { verb: "draw", targets: [], added: null };
    case "renameScreen": return { verb: "rename", targets: [], added: null };
    case "batch": {
      const parts = op.ops.map(describe);
      return { verb: parts[0]?.verb ?? "arrange", targets: [...new Set(parts.flatMap((p) => p.targets))], added: parts.find((p) => p.added)?.added ?? null };
    }
  }
}
