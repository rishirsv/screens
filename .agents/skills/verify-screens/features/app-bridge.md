# MCP App bridge

A stand-in host relays MCP Apps messages to the real adapter while the canvas runs in an embedded view with no service or frame-origin access.

## Sub-features

- `bridge-live`: the view is the adapter's `ui://` resource, opened by `open_screen` as Codex's global entrypoint on the Screen it names, and `get_view` without a Screen ID finds it, even while a browser tab on another Screen, or on the same Screen, is newer. `open_screen` with no Screen moves an open view back to the library. Going back to the library means `get_view` no longer finds that Screen open. A draft streamed in quick parts shows progress before it commits. Library links navigate inside the view, and a page with no stored poster gets its cover through the relay. Agent updates arrive live, anchored comments and text edits commit through the relay without opening the index, a person’s drag stays pending through the service commit, the agent reads the selection after a reconnect, teardown releases the view, a dropped image uploads in chunks, snapshot assets load, a doctype page renders in standards mode, a focused page with blocked native scrolling hands wheel input back to the canvas, and isolation blocks network access.

## How to get to it (user POV)

- Open the canvas in an MCP Apps host, open a Screen and work with an agent.

## Driving it with screens-cli

```screens id=bridge-live
probe bridge
expect last.annotations=true last.focusedWheel=true last.standardsMode=true last.browserTabIgnored=true last.libraryInput=true last.draftProgress=true last.leftScreen=true last.libraryLinks=true last.onDemandCover=true last.resource=true last.opened=true last.viewScreen=true last.live=true last.pending=true last.selection=true last.reconnect=true last.teardown=true last.sandbox=allow-scripts last.fetch=blocked last.assets=true last.localRequests=0 last.uploadChunks>1
```

## Gotchas

- The CLI uses a stand-in host for automated relay checks. In Codex, open Screens from the sidebar or as a chat tab.
