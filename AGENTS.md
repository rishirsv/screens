# Screens

Screens is a local canvas where a person and an agent create, arrange, and comment on HTML designs. It runs in Codex as an MCP App and in Claude Code through a local browser view.

## Code

- All mutations go through the service's domain operations. Clients never write storage or duplicate domain rules.
- `packages/core` and `packages/canvas/src/engine` are pure. They do no I/O and depend on no host or DOM.
- A Screen owns its content. Snapshot bundles are self-contained and have no network access.
- Snapshot frames use `sandbox="allow-scripts"`, never `allow-same-origin`. MCP App frames use `srcdoc` with assets inlined.
- Show a change as saved only after the service commits it.
- Use the tokens and components in `packages/ui` for UI changes.
- Keep dev and release code and libraries separate. The checkout's `.mcp.json` uses `.screens-dev`. Plugins run a pinned release package.
- Host behavior comes from `--host claude` or `--host codex`, never client-name detection.
- Do not add public tunnels or hosted fallbacks.

## Commands

Use Node.js 24 or later.

```sh
npm ci
SCREENS_HOME=.screens-dev npm start
npm run typecheck
npm run release:build
npm run release:verify
npm run release:plugins
```

`npm run release -- --version X.Y.Z` builds, packs, and stages a local release. Add `--install` to install it in both hosts. Add `--publish` only when publication is requested.

## Verification

Use the `verify-screens` skill after changes to the service, canvas, frames, MCP tools, or CLI. Run the affected feature blocks and `screens-cli check`. Run the full suite only for changes that cross several features or a concrete regression risk.

```sh
npm run screens-cli -- up
npm run screens-cli -- run .agents/skills/verify-screens/features/move-select.md --id drag-snap
npm run screens-cli -- check
npm run screens-cli -- down
```

Follow any browser-launch preflight required by the host environment. Measure performance only on request with the `screens-performance` skill. Keep run artifacts in the ignored `.verify/` and `.perf/` folders.

CI runs typecheck, tests, release build, and the packed-package check. Browser and host verification stay local.

## Repository

Keep public instructions in README.md and agent procedures in `.agents/skills`. Do not add internal docs or plans. `.claude/skills` and each `CLAUDE.md` are symlinks to the matching agent instructions.

This project does not accept outside contributions or pull requests.
