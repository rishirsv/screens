// Where each participant is on the canvas, derived from the roster and the displayed items. Pure: the runtime uses it for
// Follow, the presence layer for drawing. Nothing here is stored.

import type { Participant } from "@screens/client";
import type { ItemId, Rect } from "@screens/core";
import type { DisplayItem } from "../engine/index.ts";

export const PRESENCE_IDLE_FADE_MS = 30_000;
const COLORS = 7;

/** What a participant is on: the item its call changes, else the slot it reserved for a new object, else the item its status names. */
export interface Anchor { readonly key: string; readonly rect: Rect; readonly kind: "item" | "incoming"; readonly itemId: ItemId | null }

export function anchorOf(p: Participant, items: ReadonlyMap<ItemId, DisplayItem>): Anchor | null {
  // A reservation shows until its item is on the canvas.
  const incoming = p.incoming && !(p.incoming.itemId && items.has(p.incoming.itemId)) ? p.incoming : null;
  const slot = incoming ? { key: `in:${p.id}`, rect: incoming.rect, kind: "incoming" as const, itemId: null } : null;
  const item = (id: ItemId | undefined | null) => (id && items.has(id) ? { key: `item:${id}`, rect: items.get(id)!.rect, kind: "item" as const, itemId: id } : null);
  if (p.call) return (p.call.verb === "add" ? slot : null) ?? item(p.call.targets.find((t) => items.has(t))) ?? slot ?? item(p.status?.target?.itemId);
  return slot ?? item(p.status?.target?.itemId);
}

/** Idle: no call in flight and nothing for PRESENCE_IDLE_FADE_MS. skew converts the service clock to this one. */
export const isIdle = (p: Participant, skew: number, now: number) => !p.call && now - (p.activeAt + skew) > PRESENCE_IDLE_FADE_MS;

export const colorOf = (p: Participant) => `var(--presence-${(p.color % COLORS) + 1})`;

const VERBS: Record<NonNullable<Participant["call"]>["verb"], string> = {
  add: "Adding", update: "Updating", arrange: "Arranging", retitle: "Renaming", reorder: "Restacking", remove: "Removing", comment: "Commenting", draw: "Drawing", rename: "Renaming the Screen",
};
/** One line for what a participant is doing: its status, else its call, else nothing. */
export const activityOf = (p: Participant): string | null => p.status?.text || (p.call ? VERBS[p.call.verb] : null);
