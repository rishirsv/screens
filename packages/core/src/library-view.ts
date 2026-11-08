// Reading the library: sidebar views, sorting, media search and "Used in". Pure; the service, MCP and the canvas
// all call these, so they agree on what is archived, what matches and in what order.

import type { ItemId, PagedLayout, ScreenId } from "./model.ts";
import { PAGED_LAYOUTS } from "./pages.ts";
import { isScreenArchived, type FolderEntry, type FolderId, type LibraryCatalog, type MediaEntry, type MediaId, type ScreenEntry } from "./library.ts";

export type ScreenSort = "last-opened" | "created" | "name";
export type MediaSort = "added" | "name";
/** layout: the live Presentations (slides) or Documents (a4). */
export type Scope = { readonly kind: "all" } | { readonly kind: "folder"; readonly id: FolderId } | { readonly kind: "layout"; readonly layout: PagedLayout } | { readonly kind: "media" } | { readonly kind: "archive" };

export type Tile =
  | { readonly kind: "folder"; readonly id: FolderId; readonly name: string; readonly count: number; readonly covers: readonly string[] }
  | { readonly kind: "screen"; readonly damaged?: boolean; readonly id: ScreenId; readonly title: string; readonly cover: string | null; readonly coverObject?: { readonly itemId: ItemId; readonly contentVersion: string; readonly width: number; readonly height: number }; readonly layout?: PagedLayout; readonly itemCount: number; readonly openedAt: number | null; readonly folderId: FolderId | null }
  | { readonly kind: "media"; readonly id: MediaId; readonly title: string; readonly assetHash: string; readonly width: number; readonly height: number; readonly tags: readonly string[] };

export interface SidebarCounts { readonly all: number; readonly media: number; readonly archive: number; readonly folders: Readonly<Record<FolderId, number>>; readonly layouts: Readonly<Record<PagedLayout, number>> }

// ── Query ──

/** Text tokens must all match (AND). Filters are exact after lower-casing; every tag must be present. */
export interface MediaQuery { readonly text: readonly string[]; readonly app?: string; readonly platform?: string; readonly screenType?: string; readonly tags: readonly string[] }

const FILTERS: Record<string, "app" | "platform" | "screenType" | "tag"> = { app: "app", platform: "platform", type: "screenType", screen: "screenType", tag: "tag" };

/** `fitness app:Pulse platform:iOS type:"rest timer" tag:onboarding`. Unknown keys stay text. */
export function parseQuery(input: string): MediaQuery {
  const text: string[] = [], tags: string[] = [];
  const q: { app?: string; platform?: string; screenType?: string } = {};
  for (const m of input.matchAll(/(?:(\w+):)?(?:"([^"]*)"|(\S+))/g)) {
    const key = m[1]?.toLowerCase(), value = (m[2] ?? m[3] ?? "").trim().toLowerCase();
    if (!value) continue;
    const f = key ? FILTERS[key] : undefined;
    if (f === "tag") tags.push(value);
    else if (f) q[f] = value;
    else text.push(...(key ? `${key}:${value}` : value).split(/\s+/));
  }
  return { text, tags, ...q };
}

// Each entry's searchable text, built once per immutable entry.
const hay = new WeakMap<MediaEntry, { title: string; strong: string; weak: string }>();
function haystack(m: MediaEntry) {
  let h = hay.get(m);
  if (!h) {
    h = { title: m.title.toLowerCase(), strong: [m.meta.app, m.meta.screenType, ...m.meta.tags].join(" ").toLowerCase(), weak: [m.meta.description, m.meta.source, m.meta.platform].join(" ").toLowerCase() };
    hay.set(m, h);
  }
  return h;
}

/** Linear scan over immutable entries. Relevance (title 3, app/type/tags 2, others 1) when there is text, else `sort`. */
export function searchMedia(cat: LibraryCatalog, q: MediaQuery, o: { readonly sort?: MediaSort; readonly archived?: boolean; readonly offset?: number; readonly limit?: number } = {}): { readonly total: number; readonly items: readonly MediaEntry[] } {
  const scored: { m: MediaEntry; score: number }[] = [];
  for (const m of Object.values(cat.media)) {
    if ((m.archivedAt !== null) !== (o.archived ?? false)) continue;
    if (q.app && m.meta.app.toLowerCase() !== q.app) continue;
    if (q.platform && m.meta.platform.toLowerCase() !== q.platform) continue;
    if (q.screenType && m.meta.screenType.toLowerCase() !== q.screenType) continue;
    if (q.tags.some((t) => !m.meta.tags.includes(t))) continue;
    let score = 0, all = true;
    if (q.text.length) {
      const h = haystack(m);
      for (const t of q.text) {
        const s = (h.title.includes(t) ? 3 : 0) + (h.strong.includes(t) ? 2 : 0) + (h.weak.includes(t) ? 1 : 0);
        if (!s) { all = false; break; }
        score += s;
      }
    }
    if (all) scored.push({ m, score });
  }
  const bySort = o.sort === "name" ? (a: MediaEntry, b: MediaEntry) => a.title.localeCompare(b.title) || cmpId(a.id, b.id) : (a: MediaEntry, b: MediaEntry) => b.addedAt - a.addedAt || cmpId(a.id, b.id);
  scored.sort((a, b) => b.score - a.score || bySort(a.m, b.m));
  const offset = o.offset ?? 0, limit = o.limit ?? scored.length;
  return { total: scored.length, items: scored.slice(offset, offset + limit).map((s) => s.m) };
}

/** Distinct tags, apps, platforms and screen types starting with `prefix`, most used first. */
export function suggestTokens(cat: LibraryCatalog, prefix: string, limit = 6): readonly string[] {
  const p = prefix.toLowerCase(); if (!p) return [];
  const counts = new Map<string, number>();
  const add = (k: string, v: string) => { const lv = v.toLowerCase(); if (lv && lv.startsWith(p)) { const tok = `${k}:${/\s/.test(lv) ? `"${lv}"` : lv}`; counts.set(tok, (counts.get(tok) ?? 0) + 1); } };
  for (const m of Object.values(cat.media)) {
    if (m.archivedAt !== null) continue;
    for (const t of m.meta.tags) add("tag", t);
    add("app", m.meta.app); add("platform", m.meta.platform); add("type", m.meta.screenType);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit).map(([t]) => t);
}

// ── Views ──

const screenTile = (s: ScreenEntry): Tile => ({ kind: "screen", damaged: s.damaged, id: s.id, title: s.facts.title, cover: s.facts.cover, ...(s.facts.coverObject ? { coverObject: s.facts.coverObject } : {}),
  ...(s.facts.layout ? { layout: s.facts.layout } : {}), itemCount: s.facts.itemCount, openedAt: s.lastOpenedAt, folderId: s.folderId });
const cmpId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function sortScreens(list: ScreenEntry[], sort: ScreenSort): ScreenEntry[] {
  const opened = (s: ScreenEntry) => s.lastOpenedAt ?? s.facts.createdAt;
  return list.sort(sort === "name" ? (a, b) => a.facts.title.localeCompare(b.facts.title) || cmpId(a.id, b.id)
    : sort === "created" ? (a, b) => b.facts.createdAt - a.facts.createdAt || cmpId(a.id, b.id)
    : (a, b) => opened(b) - opened(a) || cmpId(a.id, b.id));
}

export function screensIn(cat: LibraryCatalog, folderId: FolderId | null, sort: ScreenSort = "last-opened"): ScreenEntry[] {
  return sortScreens(Object.values(cat.screens).filter((s) => !isScreenArchived(cat, s.id) && (folderId === null || s.folderId === folderId)), sort);
}

/** Screens grouped by folder in one pass, in the order given. */
function byFolder(list: readonly ScreenEntry[]): Map<FolderId, ScreenEntry[]> {
  const out = new Map<FolderId, ScreenEntry[]>();
  for (const s of list) if (s.folderId !== null) { let g = out.get(s.folderId); if (!g) out.set(s.folderId, (g = [])); g.push(s); }
  return out;
}
const folderTile = (f: FolderEntry, inside: readonly ScreenEntry[]): Tile =>
  ({ kind: "folder", id: f.id, name: f.name, count: inside.length, covers: inside.flatMap((s) => (s.facts.cover ? [s.facts.cover] : [])).slice(0, 4) });

const matches = (title: string, text: string) => !text || title.toLowerCase().includes(text.toLowerCase());

/** The grid for one sidebar scope. All: live folders, then every live Screen. */
export function libraryView(cat: LibraryCatalog, o: { readonly scope: Scope; readonly sort: ScreenSort | MediaSort; readonly text?: string }): readonly Tile[] {
  const text = o.text?.trim() ?? "";
  const ssort: ScreenSort = o.sort === "added" ? "last-opened" : o.sort === "name" ? "name" : (o.sort as ScreenSort);
  switch (o.scope.kind) {
    case "media": {
      const r = searchMedia(cat, parseQuery(text), { sort: o.sort === "name" ? "name" : "added" });
      return r.items.map(mediaTile);
    }
    case "folder": return screensIn(cat, o.scope.id, ssort).filter((s) => matches(s.facts.title, text)).map(screenTile);
    case "layout": { const l = o.scope.layout; return screensIn(cat, null, ssort).filter((s) => s.facts.layout === l && matches(s.facts.title, text)).map(screenTile); }
    case "archive": {
      const groups = byFolder(Object.values(cat.screens));
      const folders = Object.values(cat.folders).filter((f) => f.archivedAt !== null && matches(f.name, text)).map((f) => folderTile(f, groups.get(f.id) ?? []));
      const screens = sortScreens(Object.values(cat.screens).filter((s) => s.archivedAt !== null && !(s.folderId && cat.folders[s.folderId]?.archivedAt) && matches(s.facts.title, text)), ssort).map(screenTile);
      const media = Object.values(cat.media).filter((m) => m.archivedAt !== null && matches(m.title, text)).sort((a, b) => b.archivedAt! - a.archivedAt! || cmpId(a.id, b.id)).map(mediaTile);
      return [...folders, ...screens, ...media];
    }
    default: {
      const live = screensIn(cat, null, ssort), groups = byFolder(live);
      const folders = Object.values(cat.folders).filter((f) => f.archivedAt === null && matches(f.name, text));
      folders.sort((a, b) => a.name.localeCompare(b.name) || cmpId(a.id, b.id));
      return [...folders.map((f) => folderTile(f, groups.get(f.id) ?? [])), ...live.filter((s) => matches(s.facts.title, text)).map(screenTile)];
    }
  }
}

const mediaTile = (m: MediaEntry): Tile => ({ kind: "media", id: m.id, title: m.title, assetHash: m.assetHash, width: m.width, height: m.height, tags: m.meta.tags });

export function sidebarCounts(cat: LibraryCatalog): SidebarCounts {
  const folders: Record<FolderId, number> = {};
  let all = 0, archive = 0;
  const layouts = Object.fromEntries(PAGED_LAYOUTS.map((l) => [l, 0])) as Record<PagedLayout, number>;
  for (const f of Object.values(cat.folders)) { if (f.archivedAt === null) folders[f.id] = 0; else archive++; }
  for (const s of Object.values(cat.screens)) {
    if (isScreenArchived(cat, s.id)) { if (s.archivedAt !== null && !(s.folderId && cat.folders[s.folderId]?.archivedAt)) archive++; continue; }
    all++;
    if (s.facts.layout) layouts[s.facts.layout]++;
    if (s.folderId !== null && folders[s.folderId] !== undefined) folders[s.folderId]++;
  }
  let media = 0;
  for (const m of Object.values(cat.media)) { if (m.archivedAt === null) media++; else archive++; }
  return { all, media, archive, folders, layouts };
}

/** Screens holding this media item's image, matched by hash. */
export function usedIn(cat: LibraryCatalog, mediaId: MediaId): readonly ScreenEntry[] {
  const m = cat.media[mediaId]; if (!m) return [];
  return Object.values(cat.screens).filter((s) => s.facts.imageHashes.includes(m.assetHash)).sort((a, b) => a.facts.title.localeCompare(b.facts.title));
}
