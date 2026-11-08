---
name: verify-screens
description: Drive Screens the way a person and an agent do, and capture proof that a change works. Use after any change to the service, canvas, frames, MCP tools or screens-cli, and whenever you need evidence instead of a reading of the source. Runs on screens-cli (every MCP tool, real browser input, every state layer), plus host checks in the Claude desktop Browser pane.
---

# Verify Screens

Prove behavior by driving the real surfaces with `screens-cli`. Agent steps call the real stdio MCP adapter, person steps are real browser input in headless Chrome, and `expect` reads each state from its owner. Do not write unit tests that mirror the implementation.

Read [features/README.md](features/README.md) first. Each feature file holds the runnable blocks for its sub-features.

## Launch and doctor

```bash
screens-cli up        # disposable session in .verify/sessions/default: dev service, MCP adapter, headless Chrome
screens-cli doctor
```

Run `screens-cli` through `npm run screens-cli --` when it is not on your PATH. On macOS, follow any browser-launch preflight required by the host environment. Exit 3 means the browser is blocked. On Linux, set `SCREENS_BROWSER=chromium` after `npx playwright-core install --with-deps chromium`.

The daemon keeps the code it started with. After changing the service, canvas or CLI, run `screens-cli down` and then `up`.

## Drive

Run the blocks for what you changed, then an ad-hoc script for the change itself:

```bash
screens-cli run .agents/skills/verify-screens/features/move-select.md --id drag-snap
screens-cli run - <<'SCRIPT'
add_object title=A files=fixture:plain height=300 as=@A
drag @A.title by 100,0
expect doc.@A.x=100 pending.size=0 storage.rev=doc.rev
SCRIPT
```

Before handing off a change, run the affected blocks and `screens-cli check`. Run the full suite for changes that cross several features: `screens-cli -q run --fresh --jobs 4 .agents/skills/verify-screens/features/`.

- Assert committed state (`doc`, `storage`), not only what the canvas shows.
- Use `fault` for any claim about pending, failure, lost results, crashes or reconnects. Storage faults include `disk-full content|poster|document`, `corrupt-document @S json|schema|threads`, and `crash after-content-flush|after-temp-write|after-temp-flush|after-rename`. See [Storage and lifecycle](features/storage-lifecycle.md).
- Use `mark NAME [LAYER…]` and `expect PATH=mark:NAME` to compare complete stored documents or asset identities with a checkpoint, including while the service is down.
- Every MCP result is scanned for private storage paths and an unrelated-file canary. `begin NAME TOOL … [client=NAME]` and `join NAME` drive concurrent calls; `agent open NAME` opens a second real adapter.
- On a failure, open the evidence file it names. Do not rerun with dumps.
- `engine replay` proves the reducer only. It never counts as end-to-end proof.

## Host checks (Browser pane)

Headless Chrome is not the Claude desktop Browser pane. For host facts, such as which frames the pane loads, open the session's canvas origin (printed by `up`) in the pane and read state with `window.__screensTest.probe(["view","frames"])`. The pane cannot click into scaled iframes, and it stalls rAF while the app is in the background. `scripts/frame-probe.mjs` tests what a host allows with no service (see [snapshot-frame-isolation](features/snapshot-frame-isolation.md)).

## Evidence and cleanup

Evidence lands in `.verify/sessions/<name>/evidence/`. Each failed step gets a JSON dump of every layer and a screenshot, and `shot`, `dump` and `trace` write their files there too. Record the feature ID, the host, the committed revision and what changed.

`screens-cli down` stops the session by recorded PID and keeps the evidence. `run --fresh` stops its own sessions.

## Proof standards

- Use the real path: real input, the real adapter, the real service. An agent edit must appear on an open canvas without a reload.
- Check side effects: the committed revision, the document after `service restart`, and the refusal codes from `probe security`.
- A check that tests the wrong signal is a harness bug. Fix the check, rerun, and record the correction.
- Report an unreachable path with the command you tried and the missing precondition.

## Helpers

| Script | Invocation |
|---|---|
| `screens-cli` | `help` lists every command. See [packages/cli/AGENTS.md](../../../packages/cli/AGENTS.md) |
| `scripts/frame-probe.mjs` | `serve`, `doctor` or `stop`, each with `--run-dir DIR` |

The CSP in `frame-probe.mjs` must match `HOST_CSP` in `packages/frames/src/index.ts`.
