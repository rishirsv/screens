// The library shell: sidebar, the grid views (All, a folder, Media, Archive), the focused media view, and the Screen view
// with its minimized sidebar and Media drawer. One LibraryClient serves every view, so switching views reads no document.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PAGE_SIZE, libraryView, parseQuery, searchMedia, sidebarCounts, suggestTokens, type LibraryCatalog, type LibraryOperation, type LibraryRef, type MediaEntry, type PagedLayout, type MediaSort, type ScreenSort, type Tile } from "@screens/core";
import type { LibraryClient, ScreenClient, Service } from "@screens/client";
import type { DroppedImage } from "../../engine/index.ts";
import type { CanvasRuntime } from "../runtime.ts";
import { ScreenCanvas } from "../ScreenCanvas.tsx";
import { Icon } from "../icons.tsx";
import { opening } from "../opening.ts";
import { Grid, Thumb, type GridHandle, type GridSel } from "./Grid.tsx";
import { MediaFocus } from "./MediaFocus.tsx";
import { dropTarget, type DragPayload } from "./drag.ts";
import { navigate, routeKey, useRoute, type Route } from "./nav.ts";
import { clientId, filesOf, uploadImages } from "./upload.ts";

type ViewRoute = Extract<Route, { kind: "all" | "folder" | "media" | "presentations" | "documents" | "archive" }>;
/** The sidebar collections of Screens by layout: their route, layout, names and icon. */
const LAYOUT_ROWS = [
  { route: "presentations", layout: "slides", title: "Presentations", one: "Presentation", icon: "presentation" },
  { route: "documents", layout: "a4", title: "Documents", one: "Document", icon: "document" },
] as const satisfies readonly { route: Route["kind"]; layout: PagedLayout; title: string; one: string; icon: string }[];
const layoutRow = (kind: Route["kind"]) => LAYOUT_ROWS.find((r) => r.route === kind);
/** A page's shape as a grid tile aspect (height over width). */
const pageAspect = (l: PagedLayout) => PAGE_SIZE[l].height / PAGE_SIZE[l].width;
interface ViewMemory { sel: GridSel; scroll: number; search: string }
interface Toast { id: number; text: string; undo: boolean; error?: boolean }
interface Menu { x: number; y: number; items: readonly MenuItem[] }
type MenuItem = { label: string; ariaLabel?: string; kbd?: string; danger?: boolean; checked?: boolean; run: () => void } | { sep: true } | { heading: string };

/** Per-view state for this tab: selection, scroll and search come back when you return (LR-26). */
const memory = new Map<string, ViewMemory>();
const emptySel: GridSel = { selection: new Set(), anchor: null, focus: 0 };
const store = {
  get(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const coarse = matchMedia("(pointer: coarse)").matches;
const ago = (t: number | null) => {
  if (!t) return "Never opened";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "Opened just now" : m < 60 ? `Opened ${m}m ago` : m < 1440 ? `Opened ${Math.round(m / 60)}h ago` : `Opened ${Math.round(m / 1440)}d ago`;
};

export function LibraryApp({ svc, onRuntime }: { svc: Service; onRuntime?: (rt: CanvasRuntime) => void }) {
  const [lib, setLib] = useState<LibraryClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let c: LibraryClient | null = null, gone = false;
    opening?.mark("library.open.start");
    svc.openLibrary().then((x) => { if (gone) x.close(); else { c = x; setLib(x); opening?.libraryReady(); } }, (e: Error) => { if (!gone) setError(e.message); });
    return () => { gone = true; c?.close(); };
  }, [svc]);
  if (error) return <div className="screens-center"><div className="empty-state"><h2>{error}</h2></div></div>;
  if (!lib) return <div className="screens-center"><span className="spinner" /></div>;
  return <Shell svc={svc} lib={lib} onRuntime={onRuntime} />;
}

function Shell({ svc, lib, onRuntime }: { svc: Service; lib: LibraryClient; onRuntime?: (rt: CanvasRuntime) => void }) {
  const state = useSyncExternalStore(lib.subscribe, lib.get);
  const cat = state.catalog!;
  const route = useRoute();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [sidebarInScreen, setSidebarInScreen] = useState(false);
  const toastId = useRef(0);

  const toast = (text: string, undo = false, error = false) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, text, undo, error }]);
    if (!error) setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };
  /** Runs a library operation; the toast appears once it commits. */
  const run = (op: LibraryOperation, done?: string, undo = true) => {
    lib.submit(op).settled().then((o) => {
      if (o.status === "committed") { if (done) toast(done, undo); }
      else if (o.status === "failed") toast(`Couldn't save: ${o.error.message}`, false, true);
    });
  };
  useEffect(() => { const clear = () => setToasts((t) => t.filter((x) => !x.undo)); addEventListener("screens-purged", clear); return () => removeEventListener("screens-purged", clear); }, []);
  const addToScreen = (screenId: string, images: readonly DroppedImage[]) => {
    const ops = images.map((img) => {
      const k = Math.min(1, 800 / Math.max(img.width, img.height));
      return { type: "addItem", item: { kind: "reference-image", id: clientId(), title: img.title.slice(0, 120) || "Image", assetHash: img.hash, mediaType: img.mediaType, width: Math.round(img.width * k), height: Math.round(img.height * k) } } as const;
    });
    svc.run(screenId, ops.length === 1 ? ops[0]! : { type: "batch", ops }).then((o) => toast(o.status === "committed" ? `Added ${images.length} to ${cat.screens[screenId]?.facts.title ?? "Screen"}` : "Couldn't add", false, o.status !== "committed"));
  };
  const imagesOf = (ids: readonly string[]): DroppedImage[] => ids.flatMap((id) => { const m = lib.get().catalog!.media[id]; return m ? [{ hash: m.assetHash, mediaType: m.mediaType, width: m.width, height: m.height, title: m.title }] : []; });

  // ⌘Z and ⇧⌘Z in library views undo library changes. In a Screen, the canvas owns them.
  useEffect(() => {
    if (route.kind === "screen") return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.("input, textarea")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); (e.shiftKey ? lib.redo() : lib.undo()).settled().then((o) => { if (o.status === "failed") toast(`Can't ${e.shiftKey ? "redo" : "undo"}: ${o.error.message}`, false, true); }); }
    };
    addEventListener("keydown", key); return () => removeEventListener("keydown", key);
  }, [route.kind, lib]);

  const ctx: Ctx = { svc, lib, cat, run, toast, addToScreen, imagesOf, setMenu };
  const sidebar = <Sidebar ctx={ctx} route={route} floating={route.kind === "screen"} onClose={() => setSidebarInScreen(false)} />;

  return (
    <div className="screens-app" data-route={route.kind} onPointerDown={() => menu && setMenu(null)}>
      {route.kind === "screen"
        ? <>
            <ScreenPage key={route.id} ctx={ctx} screenId={route.id} onRuntime={onRuntime}
              leading={<button className="icon-button" aria-label="Sidebar" aria-expanded={sidebarInScreen} onClick={() => setSidebarInScreen(!sidebarInScreen)}><Icon name="sidebar" /></button>} />
            {sidebarInScreen && sidebar}
          </>
        : <>{sidebar}<LibraryView key={routeKey(route)} ctx={ctx} route={route as ViewRoute} /></>}
      <div className="screens-toast-stack" aria-live="polite">
        {state.connection === "reconnecting" && <div className="toast" role="status"><span className="spinner" />Reconnecting…</div>}
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? " error" : ""}`} role={t.error ? "alert" : "status"}>
            {t.text}
            {t.undo && <button className="button small" onClick={() => { lib.undo().settled().then((o) => { if (o.status === "failed") toast(`Couldn't undo: ${o.error.message}`, false, true); }); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>Undo</button>}
            <button className="icon-button small" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}><Icon name="x" /></button>
          </div>
        ))}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

interface Ctx {
  svc: Service; lib: LibraryClient; cat: LibraryCatalog;
  run: (op: LibraryOperation, done?: string, undo?: boolean) => void;
  toast: (text: string, undo?: boolean, error?: boolean) => void;
  addToScreen: (screenId: string, images: readonly DroppedImage[]) => void;
  imagesOf: (ids: readonly string[]) => DroppedImage[];
  setMenu: (m: Menu | null) => void;
}

const refsOf = (cat: LibraryCatalog, ids: readonly string[]): LibraryRef[] =>
  ids.map((id) => ({ kind: cat.folders[id] ? "folder" : cat.media[id] ? "media" : "screen", id }) as LibraryRef);
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// ── Sidebar ──

function Sidebar({ ctx, route, floating, onClose }: { ctx: Ctx; route: Route; floating: boolean; onClose: () => void }) {
  const { cat, run } = ctx;
  const counts = useMemo(() => sidebarCounts(cat), [cat]);
  const folders = useMemo(() => Object.values(cat.folders).filter((f) => f.archivedAt === null).sort((a, b) => a.name.localeCompare(b.name)), [cat]);
  const here = (r: Route) => routeKey(r) === routeKey(route) ? "page" : undefined;
  const [search, setSearch] = useState(() => memory.get(routeKey(route))?.search ?? "");
  useEffect(() => setSearch(memory.get(routeKey(route))?.search ?? ""), [routeKey(route)]);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { const clear = () => setSearch(""); addEventListener("screens-clear-search", clear); return () => removeEventListener("screens-clear-search", clear); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "f" && route.kind !== "screen") { e.preventDefault(); searchRef.current?.focus(); } };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  }, [route.kind]);
  const suggestions = route.kind === "media" ? suggestTokens(cat, search.split(/\s+/).at(-1) ?? "") : [];
  const setQuery = (q: string) => { setSearch(q); dispatchEvent(new CustomEvent("screens-search", { detail: q })); };

  const moveTo = (folderId: string | null, name: string) => dropTarget({
    accepts: (p) => (p.kind === "screen" ? (folderId ? `Move to ${name}` : "Take out of folder") : null),
    drop: (p) => run({ type: "moveScreens", screenIds: p.ids, folderId }, `Moved ${count(p.ids.length, "Screen")} to ${name}`),
    spring: folderId ? () => navigate({ kind: "folder", id: folderId }) : undefined,
  });

  return (
    <nav className={`sidebar screens-sidebar${floating ? " floating" : ""}`} aria-label="Library">
      <div className="screens-sidebar-head">
        {!floating && <button className="button small screens-library-nav" aria-label="Library navigation" aria-haspopup="menu" onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          ctx.setMenu({ x: r.left, y: r.bottom + 4, items: [
            { label: "All", run: () => navigate({ kind: "all" }) },
            ...LAYOUT_ROWS.map((row) => ({ label: row.title, run: () => navigate({ kind: row.route }) })),
            { label: "Media", run: () => navigate({ kind: "media" }) },
            { label: "Archive", run: () => navigate({ kind: "archive" }) },
            ...(folders.length ? [{ sep: true } as MenuItem, { heading: "Folders" } as MenuItem, ...folders.map((f) => ({ label: f.name, ariaLabel: `Folder ${f.name}`, run: () => navigate({ kind: "folder", id: f.id }) }))] : []),
          ] });
        }}><Icon name="sidebar" />Library<Icon name="chevron-down" /></button>}
        {route.kind !== "screen"
          ? <label className="search screens-search"><Icon name="search" /><input ref={searchRef} placeholder="Search" aria-label="Search" value={search}
              onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); (e.target as HTMLElement).blur(); } }} /><kbd>⌘F</kbd></label>
          : <><span className="screens-sidebar-title">Library</span><button className="icon-button small" aria-label="Close sidebar" onClick={onClose}><Icon name="x" /></button></>}
      </div>
      {suggestions.length > 0 && search && (
        <div className="screens-suggest" role="listbox" aria-label="Suggestions">
          {suggestions.map((s) => <button key={s} role="option" className="screens-token" onClick={() => setQuery([...search.split(/\s+/).slice(0, -1), s].join(" ") + " ")}>{s}</button>)}
        </div>
      )}
      <a className="nav-row" href="/" aria-label="All" aria-current={here({ kind: "all" })} ref={moveTo(null, "All")}><Icon name="grid" />All<span className="count">{counts.all || ""}</span></a>
      <div className="sidebar-group">
        <div className="sidebar-group-title">Folders</div>
        {folders.map((f) => (
          <a key={f.id} className="nav-row" href={`/f/${f.id}`} aria-label={`Folder ${f.name}`} aria-current={here({ kind: "folder", id: f.id })} ref={moveTo(f.id, f.name)}>
            <Icon name="folder" /><span className="screens-ellipsis">{f.name}</span><span className="count">{counts.folders[f.id] || ""}</span>
          </a>
        ))}
      </div>
      <div className="sidebar-group">
        {LAYOUT_ROWS.map((r) => (
          <a key={r.route} className="nav-row" href={`/${r.route}`} aria-label={r.title} aria-current={here({ kind: r.route })}><Icon name={r.icon} />{r.title}<span className="count">{counts.layouts[r.layout] || ""}</span></a>
        ))}
        <a className="nav-row" href="/media" aria-label="Media" aria-current={here({ kind: "media" })}><Icon name="image" />Media<span className="count">{counts.media || ""}</span></a>
        <a className="nav-row" href="/archive" aria-label="Archive" aria-current={here({ kind: "archive" })}
          ref={dropTarget({ accepts: () => "Archive", drop: (p) => run({ type: "archive", targets: refsOf(ctx.lib.get().catalog!, p.ids) }, `Archived ${p.ids.length}`) })}>
          <Icon name="archive" />Archive<span className="count">{counts.archive || ""}</span>
        </a>
      </div>
    </nav>
  );
}

// ── Grid views ──

function LibraryView({ ctx, route }: { ctx: Ctx; route: ViewRoute }) {
  const { cat, lib, svc, run, toast } = ctx;
  const key = routeKey(route);
  const mem = memory.get(key) ?? { sel: emptySel, scroll: 0, search: "" };
  const [sel, setSelState] = useState<GridSel>(mem.sel);
  const [search, setSearch] = useState(mem.search);
  const media = route.kind === "media";
  const [sort, setSort] = useState<ScreenSort | MediaSort>(() => (store.get(`screens.sort.${media ? "media" : "screens"}`) as ScreenSort | MediaSort | null) ?? (media ? "added" : "last-opened"));
  const densityKey = `screens.density.${route.kind}`;
  const [density, setDensity] = useState(() => Number(store.get(densityKey)) || (media ? 120 : 176));
  const [purgeRequest, setPurgeRequest] = useState<readonly string[] | "all" | null>(null);
  const [folderDraft, setFolderDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ index: number } | null>(null);
  const [inspector, setInspector] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const grid = useRef<GridHandle>(null);
  const scroll = useRef(mem.scroll);
  const fileInput = useRef<HTMLInputElement>(null);
  const setSel = (s: GridSel) => setSelState(s);

  useEffect(() => { const f = (e: Event) => setSearch((e as CustomEvent<string>).detail); addEventListener("screens-search", f); return () => removeEventListener("screens-search", f); }, []);
  useEffect(() => () => { memory.set(key, { sel: selRef.current, scroll: scroll.current, search: searchRef.current }); }, []);
  const selRef = useRef(sel); selRef.current = sel;
  const searchRef = useRef(search); searchRef.current = search;
  useEffect(() => { store.set(densityKey, String(density)); }, [density]);

  const folder = route.kind === "folder" ? cat.folders[route.id] : null;
  const row = layoutRow(route.kind);
  const scope = route.kind === "folder" ? { kind: "folder" as const, id: route.id } : row ? { kind: "layout" as const, layout: row.layout } : { kind: route.kind as "all" | "media" | "archive" };
  const tiles = useMemo(() => libraryView(cat, { scope, sort, text: search }), [cat, sort, search, key]);
  // The focused view browses the same results the grid shows, in the same order.
  const mediaList = useMemo(() => (media ? tiles.flatMap((t) => (cat.media[t.id] ? [cat.media[t.id]!] : [])) : []), [tiles, media]);

  // Media an agent adds while this view is open arrives with a brief "New" badge.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = Object.keys(cat.media);
    if (seen.current) {
      const added = ids.filter((id) => !seen.current!.has(id) && cat.media[id]!.addedBy.kind === "agent");
      if (added.length) { setFresh(new Set(added)); setTimeout(() => setFresh(new Set()), 4000); }
    }
    seen.current = new Set(ids);
  }, [cat]);

  if (route.kind === "folder" && !folder) return <main className="screens-main"><div className="screens-center"><div className="empty-state"><h2>This folder is gone</h2><a className="button" href="/">All</a></div></div></main>;
  const title = row ? row.title : route.kind === "all" ? "All" : route.kind === "media" ? "Media" : route.kind === "archive" ? "Archive" : folder!.name;
  const ids = tiles.map((t) => t.id);
  const chosen = ids.filter((id) => sel.selection.has(id));
  const archiving = route.kind !== "archive";

  const open = (t: Tile, i: number) => {
    if (t.kind === "folder") { if (route.kind !== "archive") navigate({ kind: "folder", id: t.id }); }
    else if (t.kind === "screen") navigate({ kind: "screen", id: t.id });
    else setFocus({ index: mediaList.findIndex((m) => m.id === t.id) });
    void i;
  };
  const archive = (sel: readonly string[]) => { if (sel.length) run({ type: "archive", targets: refsOf(cat, sel) }, `Archived ${sel.length}`); setSel({ ...selRef.current, selection: new Set() }); };
  const restore = (sel: readonly string[]) => { if (sel.length) run({ type: "restore", targets: refsOf(cat, sel) }, `Restored ${sel.length}`); setSel({ ...selRef.current, selection: new Set() }); };
  const purge = (targets: readonly string[] | "all") => setPurgeRequest(targets);
  const performPurge = (targets: readonly string[] | "all") => {
    setPurgeRequest(null);
    lib.purge(targets === "all" ? "all" : refsOf(cat, targets)).settled().then((o) => {
      if (o.status === "committed") dispatchEvent(new Event("screens-purged"));
      toast(o.status === "committed" ? "Deleted permanently" : `Couldn't delete: ${o.status === "failed" ? o.error.message : ""}`, false, o.status !== "committed");
    });
    setSel({ ...selRef.current, selection: new Set() });
  };
  const rename = async (t: Tile, value: string) => {
    setRenaming(null);
    const v = value.trim(); if (!v || v === (t.kind === "folder" ? t.name : t.title)) { setRenameDraft(null); return; }
    try {
      const o = t.kind === "screen" ? await svc.run(t.id, { type: "renameScreen", title: v })
        : await lib.submit(t.kind === "folder" ? { type: "renameFolder", folderId: t.id, name: v } : { type: "updateMedia", mediaId: t.id, patch: { title: v } }).settled();
      if (o.status === "failed") { toast(`Couldn't rename: ${o.error.message}`, false, true); setRenameDraft(v); setRenaming(t.id); }
      else setRenameDraft(null);
    } catch (e) { toast(`Couldn't rename: ${e instanceof Error ? e.message : e}`, false, true); setRenameDraft(v); setRenaming(t.id); }
  };
  const newFolder = async (name: string) => {
    const value = name.trim(); setFolderDraft(value);
    setCreating(false); if (!value) return;
    const id = clientId();
    try {
      const o = await lib.submit({ type: "createFolder", folder: { id, name: value } }).settled();
      if (o.status === "committed") { setSearch(""); dispatchEvent(new Event("screens-clear-search")); const i = libraryView(lib.get().catalog!, { scope, sort, text: "" }).findIndex((t) => t.id === id); setSel({ selection: new Set([id]), anchor: i, focus: i }); }
      else if (o.status === "failed") { toast(`Couldn't create folder: ${o.error.message}`, false, true); setCreating(true); }
    } catch (e) { toast(`Couldn't create folder: ${e instanceof Error ? e.message : e}`, false, true); setCreating(true); }
  };
  const newScreen = async () => {
    try { const s = await svc.createScreen("Untitled", route.kind === "folder" ? route.id : undefined, row?.layout); navigate({ kind: "screen", id: s.id }); }
    catch (e) { toast(`Couldn't create Screen: ${e instanceof Error ? e.message : e}`, false, true); }
  };
  const addMedia = async (files: readonly File[]) => {
    const imgs = await uploadImages(svc, files);
    if (!imgs.length) { toast("Only PNG, JPEG, WebP and GIF images can be added", false, true); return; }
    run({ type: "batch", ops: imgs.map((img) => ({ type: "addMedia", media: { id: clientId(), assetHash: img.hash, title: img.title } })) }, `Added ${count(imgs.length, "image")}`);
  };

  // Paste and Finder drops add images to Media (LR-22).
  useEffect(() => {
    if (!media) return;
    const paste = (e: ClipboardEvent) => { if ((e.target as HTMLElement).closest?.("input, textarea")) return; const f = filesOf(e.clipboardData); if (f.length) { e.preventDefault(); void addMedia(f); } };
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); };
    const drop = (e: DragEvent) => { const f = filesOf(e.dataTransfer); if (f.length) { e.preventDefault(); void addMedia(f); } };
    addEventListener("paste", paste); addEventListener("dragover", over); addEventListener("drop", drop);
    return () => { removeEventListener("paste", paste); removeEventListener("dragover", over); removeEventListener("drop", drop); };
  }, [media]);

  const menuFor = (i: number, x: number, y: number) => {
    const t = tiles[i]!, s = selRef.current.selection.has(t.id) ? [...selRef.current.selection] : [t.id];
    const items: MenuItem[] = [];
    if (route.kind === "archive") {
      items.push({ label: "Restore", run: () => restore(s) }, { sep: true }, { label: `Delete permanently${s.length > 1 ? ` (${s.length})` : ""}`, danger: true, kbd: "⌘⌫", run: () => purge(s) });
    } else {
      items.push({ label: "Open", kbd: "Space", run: () => open(t, i) });
      if (s.length === 1) items.push({ label: "Rename", kbd: "↵", run: () => setRenaming(t.id) });
      if (t.kind === "screen") {
        const others = Object.values(cat.folders).filter((f) => f.archivedAt === null).sort((a, b) => a.name.localeCompare(b.name));
        items.push({ sep: true }, { heading: "Move to" });
        if (t.folderId) items.push({ label: "No folder", run: () => run({ type: "moveScreens", screenIds: s, folderId: null }, `Took ${count(s.length, "Screen")} out of the folder`) });
        for (const f of others) if (f.id !== t.folderId) items.push({ label: f.name, run: () => run({ type: "moveScreens", screenIds: s, folderId: f.id }, `Moved ${count(s.length, "Screen")} to ${f.name}`) });
      }
      if (t.kind === "media") {
        items.push({ label: "Edit details", kbd: "I", run: () => { open(t, i); setInspector(true); } }, { sep: true }, { heading: "Add to Screen" });
        const recent = Object.values(cat.screens).filter((x) => x.archivedAt === null).sort((a, b) => (b.lastOpenedAt ?? b.facts.updatedAt) - (a.lastOpenedAt ?? a.facts.updatedAt)).slice(0, 5);
        for (const r of recent) items.push({ label: r.facts.title, run: () => ctx.addToScreen(r.id, ctx.imagesOf(s)) });
      }
      items.push({ sep: true }, { label: `Archive${s.length > 1 ? ` ${s.length}` : ""}`, danger: true, kbd: "⌫", run: () => archive(s) });
    }
    ctx.setMenu({ x, y, items });
  };

  const payload = (sel: readonly string[]): DragPayload | null => {
    if (route.kind === "archive") return null;
    const kinds = new Set(sel.map((id) => (cat.folders[id] ? "folder" : cat.media[id] ? "media" : "screen")));
    const kind = kinds.size === 1 ? ([...kinds][0] as DragPayload["kind"]) : "screen";
    return { kind, ids: sel, from: "grid", ...(kind === "media" ? { images: ctx.imagesOf(sel) } : {}) };
  };

  const onKey = (e: React.KeyboardEvent, i: number): boolean => {
    const mod = e.metaKey || e.ctrlKey, t = tiles[i];
    const s = [...selRef.current.selection];
    if ((e.key === "Backspace" || e.key === "Delete") && s.length) {
      if (route.kind === "archive") { if (mod) purge(s); } else archive(s);
      return true;
    }
    if (mod && (e.key === "=" || e.key === "+")) { setDensity((d) => Math.min(media ? 280 : 320, d + 24)); return true; }
    if (mod && e.key === "-") { setDensity((d) => Math.max(media ? 64 : 120, d - 24)); return true; }
    if (!t) return false;
    if (e.key === "Enter" && route.kind !== "archive") { setRenaming(t.id); return true; }
    // Space, Cmd+O and Cmd+Down open, as in Finder.
    if (e.key === " " || (mod && (e.key === "o" || e.key === "ArrowDown"))) { open(t, i); return true; }
    return false;
  };

  const render = (t: Tile, c: { selected: boolean; focused: boolean }) => (
    <TileView t={t} ctx={ctx} archived={route.kind === "archive"} renaming={renaming === t.id} renameDraft={renameDraft} onRenameCancel={() => { setRenaming(null); setRenameDraft(null); }} fresh={fresh.has(t.id)} onRename={(v) => rename(t, v)} selected={c.selected} />
  );

  return (
    <main className="screens-main"
      onWheel={(e) => { if (e.ctrlKey) { e.preventDefault(); setDensity((d) => Math.max(media ? 64 : 120, Math.min(media ? 280 : 320, d - e.deltaY))); } }}>
      {purgeRequest !== null && <DeleteConfirmation onCancel={() => setPurgeRequest(null)} onConfirm={() => performPurge(purgeRequest)} />}
      <header className="screens-view-head screens-library-head">
        <div className="screens-row screens-selbar">
          {chosen.length > 0 && !renaming && <>
            <span className="screens-muted">{chosen.length} selected</span>
            {archiving ? <button className="button small" onClick={() => archive(chosen)}>Archive</button>
              : <><button className="button small" onClick={() => restore(chosen)}>Restore</button><button className="button small screens-danger" onClick={() => purge(chosen)}>Delete</button></>}
          </>}
          {[...state(lib).pending.values()].some((p) => p.outcome.status !== "failed") && <span className="screens-saving" role="status"><span className="spinner" /> Saving</span>}
        </div>
        <h1>{title}</h1>
        <div className="screens-row screens-head-actions">
          {coarse && <button className="button small" aria-pressed={selectMode} onClick={() => setSelectMode(!selectMode)}>{selectMode ? "Done" : "Select"}</button>}
          {route.kind !== "archive" && (
            <button className="button small screens-sort" aria-label="Sort" aria-haspopup="menu" onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const choices = media ? [["added", "Date added"], ["name", "Name"]] : [["last-opened", "Last opened"], ["created", "Created"], ["name", "Name"]];
              ctx.setMenu({ x: rect.left, y: rect.bottom + 4, items: choices.map(([value, label]) => ({ label: label!, checked: value === sort, run: () => { setSort(value as ScreenSort | MediaSort); store.set(`screens.sort.${media ? "media" : "screens"}`, value!); } })) });
            }}>{sort === "last-opened" ? "Last opened" : sort === "added" ? "Date added" : sort === "created" ? "Created" : "Name"}<Icon name="chevron-down" /></button>
          )}
          {route.kind === "all" && (creating ? <RenameInput initial={folderDraft} placeholder="Folder name" onCancel={() => { setCreating(false); setFolderDraft(""); }} onDone={(value) => void newFolder(value)} /> : <button className="button small" onClick={() => { setFolderDraft(""); setCreating(true); }}>New folder</button>)}
          {(route.kind === "all" || route.kind === "folder" || row) && <button className="button small primary" onClick={() => void newScreen()}>{row ? `New ${row.one.toLowerCase()}` : "New screen"}</button>}
          {media && <>
            <button className="button small primary" onClick={() => fileInput.current?.click()}>Add</button>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={(e) => { void addMedia([...(e.target.files ?? [])]); e.target.value = ""; }} />
          </>}
          {route.kind === "archive" && tiles.length > 0 && <button className="button small screens-danger" onClick={() => purge("all")}>Delete all</button>}
        </div>
      </header>
      <Grid ref={grid} items={tiles} idOf={(t) => t.id} labelOf={(t) => (t.kind === "folder" ? t.name : t.title)} render={render} label_={title}
        tile={density} aspect={media ? 1 : row ? pageAspect(row.layout) : 0.75} label={media ? 0 : 40} gap={media ? 4 : 16}
        className={media ? "media" : ""} sel={sel} onSel={setSel} onOpen={(i) => open(tiles[i]!, i)} onMenu={menuFor} payload={payload}
        selectMode={selectMode} initialScroll={mem.scroll} onScroll={(t) => { scroll.current = t; }} onKey={onKey}
        empty={<div className="screens-center"><div className="empty-state">
          <Icon name={media ? "image" : route.kind === "archive" ? "archive" : "layout"} />
          <h2>{search ? "No matches" : media ? "No media yet" : row ? `No ${row.title} yet` : route.kind === "archive" ? "Archive is empty" : route.kind === "folder" ? "No Screens in this folder" : "No Screens yet"}</h2>
          {media && !search && <p>Paste or drop images here</p>}
        </div></div>} />
      {focus && media && (
        <MediaFocus items={mediaList} index={Math.max(0, focus.index)} catalog={cat} lib={lib} inspector={inspector} onInspector={setInspector}
          onIndex={(i) => { setFocus({ index: i }); const id = mediaList[i]!.id; const k = ids.indexOf(id); setSel({ selection: new Set([id]), anchor: k, focus: k }); grid.current?.scrollToIndex(k); }}
          onAddToScreen={(m, screenId) => {
            if (screenId) ctx.addToScreen(screenId, ctx.imagesOf([m.id]));
            else svc.createScreen("Untitled").then(s => ctx.addToScreen(s.id, ctx.imagesOf([m.id])), (e: Error) => ctx.toast(e.message, false, true));
          }}
          onClose={(i) => {
            const id = mediaList[i]?.id; const k = id ? ids.indexOf(id) : -1;
            setFocus(null);
            if (k >= 0) { setSel({ selection: new Set([id!]), anchor: k, focus: k }); grid.current?.scrollToIndex(k); }
            requestAnimationFrame(() => grid.current?.focus());
          }} />
      )}
    </main>
  );
}
const state = (lib: LibraryClient) => lib.get();

function TileView({ t, ctx, archived, renaming, renameDraft, fresh, onRename, onRenameCancel, selected }: { t: Tile; ctx: Ctx; archived: boolean; renaming: boolean; renameDraft: string | null; fresh: boolean; onRename: (v: string) => void; onRenameCancel: () => void; selected: boolean }) {
  const name = t.kind === "folder" ? t.name : t.title;
  // Screens accept media; folders accept Screens.
  const target = archived ? undefined : t.kind === "screen"
    ? dropTarget({ accepts: (p) => (p.kind === "media" ? `Add to ${t.title}` : null), drop: (p) => ctx.addToScreen(t.id, p.images ?? []) })
    : t.kind === "folder" ? dropTarget({ accepts: (p) => (p.kind === "screen" ? `Move to ${t.name}` : null), drop: (p) => ctx.run({ type: "moveScreens", screenIds: p.ids, folderId: t.id }, `Moved ${count(p.ids.length, "Screen")} to ${t.name}`) })
    : undefined;
  return (
    <div className={`screens-tile kind-${t.kind}`} title={name} data-fresh={fresh ? "" : undefined} ref={target}>
      <div className="screens-tile-thumb">
        {t.kind === "folder" ? <div className="screens-quad">{[0, 1, 2, 3].map((k) => <Thumb key={k} hash={t.covers[k]} />)}</div>
          : t.kind === "screen" ? <Thumb hash={t.cover} page={t.layout} src={t.coverObject ? `/poster/${t.id}/${t.coverObject.itemId}/${t.coverObject.contentVersion}?s=${t.coverObject.width}x${t.coverObject.height}` : undefined} />
          : <Thumb hash={t.assetHash} alt={t.title} />}
        <span className="screens-check-dot" aria-hidden="true">{selected && <Icon name="check" />}</span>
        {fresh && <span className="screens-new">New</span>}
      </div>
      {t.kind !== "media" || archived ? (
        <div className={`screens-tile-label${renaming ? " renaming" : ""}`}>
          {renaming ? <RenameInput initial={renameDraft ?? name} onDone={onRename} onCancel={onRenameCancel} /> : <div className="screen-card-name">{name}</div>}
          <div className="screen-card-meta">{t.kind === "folder" ? count(t.count, "Screen") : t.kind === "screen" ? (t.damaged ? "Damaged" : archived ? "Screen" : ago(t.openedAt)) : "Media"}</div>
        </div>
      ) : renaming ? <div className="screens-tile-label"><RenameInput initial={renameDraft ?? name} onDone={onRename} onCancel={onRenameCancel} /></div> : null}
    </div>
  );
}

function DeleteConfirmation({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="screens-delete-dialog" aria-labelledby="delete-title" onCancel={(e) => { e.preventDefault(); onCancel(); }}>
    <h2 id="delete-title">Delete permanently?</h2><p>This cannot be undone.</p>
    <div className="screens-row"><button autoFocus className="button" onClick={onCancel}>Cancel</button><button className="button screens-danger" onClick={onConfirm}>Delete permanently</button></div>
  </dialog>;
}

function RenameInput({ initial, placeholder, onDone, onCancel }: { initial: string; placeholder?: string; onDone: (v: string) => void; onCancel?: () => void }) {
  const ref = useRef<HTMLInputElement>(null), done = useRef(false);
  useEffect(() => { ref.current?.select(); }, []);
  const finish = (v: string) => { if (!done.current) { done.current = true; onDone(v); } };
  return <input ref={ref} className="screens-title-input" defaultValue={initial} placeholder={placeholder} maxLength={120} aria-label={placeholder ?? "Name"} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") finish(ref.current!.value); if (e.key === "Escape") { if (onCancel) { done.current = true; onCancel(); } else finish(initial); } }} onBlur={() => finish(ref.current!.value)} />;
}

function ContextMenu({ menu, onClose }: { menu: Menu; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  useEffect(() => {
    const el = ref.current!; const r = el.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(menu.x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(menu.y, innerHeight - r.height - 8)) });
    (el.querySelector("button") as HTMLElement | null)?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    addEventListener("keydown", esc, true); return () => removeEventListener("keydown", esc, true);
  }, [menu]);
  return (
    <div ref={ref} className="menu screens-menu" role="menu" data-state="open" style={{ left: pos.x, top: pos.y }} onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        const bs = [...ref.current!.querySelectorAll("button")], k = bs.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown") { e.preventDefault(); bs[(k + 1) % bs.length]?.focus(); }
        if (e.key === "ArrowUp") { e.preventDefault(); bs[(k - 1 + bs.length) % bs.length]?.focus(); }
      }}>
      {menu.items.map((it, i) => "sep" in it ? <div key={i} className="menu-separator" /> : "heading" in it ? <div key={i} className="screens-menu-heading">{it.heading}</div>
        : <button key={i} role="menuitem" aria-label={it.ariaLabel} className={`menu-item${it.danger ? " danger" : ""}`} onClick={() => { onClose(); it.run(); }}>{it.checked !== undefined && <span className="screens-menu-check">{it.checked && <Icon name="check" />}</span>}{it.label}{it.kbd && <kbd>{it.kbd}</kbd>}</button>)}
    </div>
  );
}

// ── Screen view ──

function ScreenPage({ ctx, screenId, onRuntime, leading }: { ctx: Ctx; screenId: string; onRuntime?: (rt: CanvasRuntime) => void; leading: ReactNode }) {
  const { svc } = ctx;
  const [client, setClient] = useState<ScreenClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const rt = useRef<CanvasRuntime | null>(null);
  useEffect(() => {
    // A Screen left before its open resolves is closed when it arrives, so it never updates an unmounted view.
    let c: ScreenClient | null = null, gone = false;
    const start = opening?.now();
    opening?.mark("document.open.start", { screenId });
    svc.openScreen(screenId).then((x) => {
      opening?.duration("document.open", start, { screenId, revision: x.get().committed?.revision ?? -1 });
      if (gone) x.close(); else { c = x; setClient(x); }
    }, (e: Error) => { opening?.mark("document.open.failed", { screenId, message: e.message }); if (!gone) setError(e.message); });
    return () => { gone = true; c?.close(); };
  }, [svc, screenId]);

  const drop = (images: readonly DroppedImage[], client: { x: number; y: number } | null) => {
    const r = rt.current; if (!r || !images.length) return;
    if (r.view.focus.mode !== "none") {
      r.dispatch({ type: "command", command: { kind: "exit-focus" } });
      ctx.addToScreen(screenId, images);
      return;
    }
    const box = r.stage?.getBoundingClientRect();
    r.dispatch({ type: "drop-images", at: client && box ? { x: client.x - box.left, y: client.y - box.top } : null, images });
  };
  // Finder drops and pastes onto the canvas are the canvas runtime's own (ScreenCanvas); the drawer is ours.
  if (error) return <div className="screens-center"><div className="empty-state"><h2>{error}</h2><a className="button" href="/">Library</a></div></div>;
  if (!client) return <div className="screens-center"><span className="spinner" /></div>;
  return (
    <>
      <ScreenCanvas client={client} viewId={svc.sessionId} leading={leading}
        trailing={<button className="icon-button" aria-label="Media" aria-pressed={drawer} title="Media" onClick={() => setDrawer(!drawer)}><Icon name="image" /></button>}
        onRuntime={(r) => {
          rt.current = r; opening?.runtime(r); onRuntime?.(r);
          if (r.stage) dropTarget({ accepts: (p) => (p.kind === "media" ? `Add ${p.ids.length > 1 ? count(p.ids.length, "image") : "image"}` : null), drop: (p, at) => drop(p.images ?? [], at) })(r.stage);
        }} />
      {drawer && <MediaDrawer ctx={ctx} onInsert={(ids) => drop(ctx.imagesOf(ids), null)} onClose={() => setDrawer(false)} />}
    </>
  );
}

function MediaDrawer({ ctx, onClose, onInsert }: { ctx: Ctx; onClose: () => void; onInsert: (ids: readonly string[]) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<GridSel>(emptySel);
  const items = useMemo(() => searchMedia(ctx.cat, parseQuery(q), { sort: "added" }).items, [ctx.cat, q]);
  return (
    <aside className="panel screens-drawer" aria-label="Media drawer">
      <div className="panel-head"><span>Media</span><span className="spacer" /><button className="icon-button small" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
      <label className="search screens-drawer-search"><Icon name="search" /><input placeholder="Search media" aria-label="Search media" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></label>
      {/* The same virtualized grid as the library, so every match is reachable without mounting them all. */}
      <Grid items={items} idOf={(m) => m.id} labelOf={(m) => m.title} label_="Media" className="media screens-drawer-grid"
        tile={88} aspect={1} label={24} gap={8} pad={8} sel={sel} onSel={setSel}
        payload={(ids) => ({ kind: "media", ids, from: "drawer", images: ctx.imagesOf(ids) })}
        onOpen={(i) => onInsert([items[i]!.id])}
        render={(m) => <div className="screens-tile" title={m.title}><div className="screens-tile-thumb"><Thumb hash={m.assetHash} alt={m.title} /></div><div className="screens-drawer-label">{m.title}</div></div>}
        empty={<div className="screens-muted screens-drawer-empty">{q ? "No matches" : "No media yet"}</div>} />
      <div className="screens-drawer-actions"><button className="button small primary" disabled={!sel.selection.size} onClick={() => onInsert([...sel.selection])}>Add to Screen</button></div>
    </aside>
  );
}

export type { MediaEntry };
