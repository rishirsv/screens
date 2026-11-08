// Client-side routes. One page load keeps one library connection across every view.

import { useSyncExternalStore } from "react";
import { opening } from "../opening.ts";

export type Route =
  | { readonly kind: "all" } | { readonly kind: "folder"; readonly id: string } | { readonly kind: "media" } | { readonly kind: "archive" }
  | { readonly kind: "presentations" } | { readonly kind: "documents" }
  | { readonly kind: "screen"; readonly id: string } | { readonly kind: "bench" };

export function parseRoute(path: string): Route {
  let m = path.match(/^\/s\/([\w-]+)$/); if (m) return { kind: "screen", id: m[1]! };
  m = path.match(/^\/f\/([\w-]+)$/); if (m) return { kind: "folder", id: m[1]! };
  if (path === "/media") return { kind: "media" };
  if (path === "/presentations") return { kind: "presentations" };
  if (path === "/documents") return { kind: "documents" };
  if (path === "/archive") return { kind: "archive" };
  if (path === "/bench") return { kind: "bench" };
  return { kind: "all" };
}

export function pathOf(r: Route): string {
  switch (r.kind) {
    case "screen": return `/s/${r.id}`;
    case "folder": return `/f/${r.id}`;
    case "media": return "/media";
    case "presentations": return "/presentations";
    case "documents": return "/documents";
    case "archive": return "/archive";
    case "bench": return "/bench";
    default: return "/";
  }
}

export const routeKey = (r: Route) => pathOf(r);

let current = window.__SCREENS_APP__ ? window.__SCREENS_APP_PATH__ ?? "/" : location.pathname;
const subs = new Set<() => void>();
const changed = () => { current = location.pathname; for (const s of subs) s(); };
addEventListener("popstate", changed);
// In an MCP App the host has no address bar: the tool that opened the view says which Screen to show.
if (window.__SCREENS_APP__) addEventListener("screens:open-screen", (e) => { const id = (e as CustomEvent<string | null>).detail; navigate(id ? `/s/${id}` : "/"); });

export function navigate(r: Route | string, replace = false): void {
  const p = typeof r === "string" ? r : pathOf(r);
  if (p === current) return;
  opening?.mark("route.navigate", { path: p });
  if (window.__SCREENS_APP__) { current = p; for (const s of subs) s(); return; }
  if (replace) history.replaceState(null, "", p); else history.pushState(null, "", p);
  changed();
}

export function useRoute(): Route {
  const path = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => current);
  return parseRoute(path);
}

/** Same-origin links to app routes navigate in place, so the library connection and per-view state survive. */
addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a || a.target) return;
  // An MCP App view is a srcdoc page with a null origin: its links resolve against the host, so read the written path.
  const href = a.getAttribute("href") ?? "";
  const p = window.__SCREENS_APP__ ? (href.startsWith("/") ? href.split(/[?#]/)[0]! : null) : a.origin === location.origin ? a.pathname : null;
  if (!p || !/^\/($|s\/|f\/|media$|presentations$|documents$|archive$)/.test(p)) return;
  e.preventDefault(); navigate(p);
});
