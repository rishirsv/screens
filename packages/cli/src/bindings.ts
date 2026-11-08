// Exhaustive maps over the surfaces the CLI mirrors. When the canvas or the model grows, `npm run typecheck`
// fails here until someone decides how a person reaches the new thing and where its result is read.

import type { CanvasInput, Command, Effect } from "../../canvas/src/engine/index.ts";
import type { ScreenDoc } from "@screens/core";
import type { ServiceEvent } from "@screens/client";
import type { Layer } from "./script.ts";

/** Which person verb reaches each engine Command through the real UI. */
export const COMMAND_VERBS = {
  "zoom-in": "zoom", "zoom-out": "zoom", "zoom-100": "zoom", "fit-all": "fit", focus: "focus", "exit-focus": "exit-focus",
  "select-tool": "tool", delete: "delete", undo: "undo", redo: "redo", "pencil-color": "pencil", "pencil-size": "pencil",
  "invert-scroll": "invert-scroll", edit: "edit-title",
  // Comment card and panel controls are reached by clicking them: @T.row, ui:Resolve, ui:Reopen, ui:Close, @c (Delete), ui:Resolved.
  "open-thread": "click", "resolve-thread": "click", "delete-comment": "click", "comment-filter": "click", "comments-panel": "click", "edit-comment": "click",
  reorder: "key", nudge: "key", "resize-by": "key", "select-next": "key", "zoom-to-selection": "key", "copy-image": "click",
  // Roster row buttons: ui:Follow, ui:Locate, and the off-screen markers.
  follow: "click", locate: "click",
  // The Scroll, Grid and Present controls of a Presentation or Document.
  "pages-view": "click",
} as const satisfies Record<Command["kind"], string>;

/** Who produces each CanvasInput: person verbs, or the shell itself (with why). */
export const INPUT_SOURCES = {
  "pointer-down": ["click", "drag", "press", "draw"], "pointer-move": ["drag", "move", "draw"], "pointer-up": ["click", "drag", "release", "draw"],
  "pointer-cancel": "runtime: lost pointer capture", "double-click": ["click", "edit-title"], wheel: ["wheel"], "key-down": ["key", "type", "undo", "redo", "delete", "zoom", "cancel"],
  "key-up": ["key"], "window-blur": ["inside"], bridge: ["inside"], tick: "runtime: animation frame", "camera-settled": "runtime: settle timer",
  resize: "runtime: ResizeObserver (up --viewport)", "document-changed": "runtime: revision event", command: ["tool", "pencil", "zoom", "fit", "focus", "exit-focus", "invert-scroll", "rename-screen"],
  "title-commit": ["edit-title", "rename-screen"], "title-cancel": ["key"], "view-command": "runtime: agent show_items and focus_item", theme: ["theme"],
  "comment-submit": ["key"], "comment-composing": ["type"], "comment-cancel": ["key"],
  // Finder drops and paste, and dragging a Media drawer tile onto the canvas.
  "drop-images": ["drop", "paste", "drag"],
  "follow-target": "runtime: roster change while following",
} as const satisfies Record<CanvasInput["type"], readonly string[] | `runtime: ${string}`>;

/** Where each engine Effect's result can be asserted. */
export const EFFECT_LAYERS = {
  capture: "view", release: "view", submit: "pending", transient: "presence", undo: "history", redo: "history",
  "request-frame": "view", "settle-timer": "view", "blur-active": "dom", "publish-context": "context", "answer-view-command": "last",
  "copy-image": "dom",
} as const satisfies Record<Effect["type"], Layer>;

/** How the doc encoder shows each ScreenDoc field. */
export const DOC_FIELDS = {
  id: "skip", layout: "header", schemaVersion: "skip", title: "header", revision: "header", createdAt: "skip", updatedAt: "skip", items: "table", strokes: "table", threads: "table",
} as const satisfies Record<keyof ScreenDoc, "skip" | "header" | "table">;

/** How the event log counts each broadcast. */
export const EVENT_COUNTERS = {
  revision: "revisions", history: "history", transient: "transients", viewCommand: "viewCommands", roster: "rosters", draft: "drafts",
  catalog: "catalog", libraryHistory: "libraryHistory",
} as const satisfies Record<ServiceEvent["t"], string>;
