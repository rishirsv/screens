# Screens verification map

This folder is the maintained source for verifying Screens' user-facing behavior. Each feature file holds executable `screens` blocks that `screens-cli run` executes. Read this index before driving anything, then run the matching feature.

## Running

```bash
screens-cli run .agents/skills/verify-screens/features/move-select.md --id drag-snap   # one block, in the current session
screens-cli run --fresh --jobs 4 .agents/skills/verify-screens/features/              # everything, in fresh sessions
screens-cli check                                                                      # contracts, boundaries and coverage
```

Each block starts on a fresh Screen bound to `@S`, in view `v1`.

## Proof and skip reporting

- Assert committed state (`doc`, `storage`), not only what the canvas shows.
- On a failure, open the evidence it names before rerunning.
- Report an unreachable path with the command tried and the missing precondition.

## Feature entry contract

Each feature file has an H1 and one paragraph, then four H2 sections in this order:

1. `Sub-features`: one bullet per sub-feature ID.
2. `How to get to it (user POV)`
3. `Driving it with screens-cli`: one ```` ```screens id=<sub-feature-id> ```` block per sub-feature, ending in `expect` or `wait` lines that state the pass criteria. Prose here explains only what a block cannot show.
4. `Gotchas`

## Features

- [MCP App bridge](./app-bridge.md): host-relayed canvas operations, pending commits, view selection and frame isolation.
- [Agent objects](./agent-snapshots.md): the agent adds, updates and reads objects and images; replays are idempotent; edits appear live.
- [Layers](./layers.md): piece edits by agents (`edit_object`, `read_object`, crops), the Layers inspector in focus mode, merged person and agent edits, and the load check for objects with scripts.
- [Snapshot validation](./snapshot-validation.md): test load before commit, posters on the canvas and in tool results, warnings, refusals.
- [Move and select](./move-select.md): select, marquee, drag with snapping, delete, rename.
- [Resize and reorder](./resize-reorder.md): resize handles with snapping, guides, aspect and live presence, group resize, front, back and one-step reorder, all-or-nothing batches, and clearing source links when an image is deleted.
- [Camera and focus](./camera-focus.md): pan, zoom, fit, focus and return, and agent view commands.
- [Pencil](./pencil.md): draw, anchor to a frame, follow the frame, tap, delete.
- [Comments](./comments.md): threads on snapshots or the canvas, anchors through move and resize, reply, resolve, delete, cascade with undo, and live agent edits.
- [Undo and redo](./undo.md): service undo that never overwrites another writer's change.
- [Storage and lifecycle](./storage-lifecycle.md): disk full, damaged documents, atomic crash steps, concurrent writers, event counts, shared fonts, bundle paths, service discovery, identity, idle exit, port fallback, graceful shutdown and scanning every MCP result.
- [Restart and security](./restart-security.md): persistence, reconnect, crash, lost results, token, Host, Origin and frame capability.
- [Snapshot frame isolation](./snapshot-frame-isolation.md): sandboxed `srcdoc` child, CSP, no network. Covers the real path and frame-probe.
- [Files](./files.md): resumable, checksummed uploads; export and import with the same IDs; refusals.
- [Image drop and paste](./image-drop.md): images dropped or pasted onto the canvas become reference images.
- [Keyboard](./keyboard.md): keyboard paths for every canvas action, Cmd and trackpad-pinch zoom direction, and opening a Screen from the library keyboard.
- [Presentations and Documents](./pages.md): Screens whose items are ordered pages: agent tools with index, scroll, grid reorder, Present, library rows, page-size posters.
- [Library](./library.md): folders, archive and restore, Media with search and metadata, Last Opened, dropping media onto a canvas, and the library page.
- [Presence](./presence.md): agents' cursors, labels, roster, placeholders for objects on their way, subagent lanes, notes, Follow and off-screen markers, live drafts, and expiry.
- [screens-cli sessions](./cli-sessions.md): handles, Screens and views, presence, traces, state and evidence.

## Not built yet

Add a feature file here when each one lands. Nothing is listed now.

## Uncovered

`screens-cli check` fails when a tool, verb, command or layer is reached by no block. List a deliberate gap here as `` - `name`: reason ``.
