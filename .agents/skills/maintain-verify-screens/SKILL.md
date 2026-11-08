---
name: maintain-verify-screens
description: Periodic upkeep pass that keeps the verify-screens skill, its feature map and screens-cli true to the app. Reads each feature from source, runs every feature block live, and ships at most one change of proven corrections. Also the place to add a feature file when a new surface (service, canvas, MCP, CLI) lands. Use for "maintain verify-screens", "audit the verify skill", or after a change adds or reshapes a user-facing surface.
disable-model-invocation: true
---

# Maintain verify-screens

The feature map in `.agents/skills/verify-screens/features/` and the harness in `packages/cli` rot when the app changes. This pass keeps them honest. A feature is the unit of rigor: each feature file gets coverage from source and a live run of its `screens` blocks. You don't need to re-prove every sentence.

## Outcomes

Report exactly one:

- **clean**: every feature got source and live coverage, and nothing needed fixing. No branch, no PR.
- **changed**: one change ships proven corrections to the map, the skill or its scripts.
- **blocked**: coverage could not finish, or a proven fix could not ship safely. Say exactly what blocked it.

## Edit scope

Edit `.agents/skills/verify-screens/` (its `SKILL.md`, `features/` and `scripts/`) and `packages/cli/` (the harness). Never edit other product code during this pass. A product-side hook the harness needs is a product gap: report it, and never make the harness fake the behavior. Update the root AGENTS.md command examples only when a CLI change makes them wrong. When the app no longer does what the map describes, decide which case it is:

- **Doc drift.** The map is wrong. Fix the map.
- **Product regression.** The app is wrong. Report it to the user and leave it out of this change.

## Pass

0. **Locate the target.** It is `.agents/skills/verify-screens/`. `.claude/skills` is a symlink to `.agents/skills`, so there is one copy, and you edit it under `.agents/`.
1. **Index hygiene.** Read `features/README.md` and list its sibling files. Fix missing, extra, duplicate or dead entries.
   - Run `npm run typecheck` and `screens-cli check`. A typecheck failure in `packages/cli` means a canvas command, input, effect or document field landed: bind it in `bindings.ts` (or the hook's `VIEW_PROBE`) to a verb or layer, adding a person verb only when no existing verb reaches it. Every tool, verb, command or layer `check` names gets a block, or an `## Uncovered` entry with its reason. A new MCP tool needs no CLI change, only blocks.
   - Check the "Not built yet" list against the repository. When one of those surfaces now has runnable code, write its feature file using the contract in the README, with one block per sub-feature, and remove it from the list.
2. **Source wave.** Launch one read-only subagent per feature file, concurrently. Each one returns:
   - how the feature works, with source entry points
   - any likely drift, with citations
   - one live recipe

   Subagents never drive the app and never edit files.
   - For the frame path, also confirm that `hostCsp` in `frame-probe.mjs` matches `HOST_CSP` in `packages/frames/src/index.ts`.
3. **Reconcile.** Make sure every feature file has a summary.
   - Merge overlapping recipes.
   - Spot-check the drift that was cited.
   - Sweep recent commits (`git log --since` the last pass) for user-facing surfaces missing from the map. You need a concrete source path before calling one missing.
4. **Live pass.** Required even when the source looks clean. You, the coordinator, do all the driving.
   - Run `screens-cli -q run --fresh --jobs 4 .agents/skills/verify-screens/features/` (on macOS through the GUI preflight). Run it twice; a block that fails only once is flaky, and flakiness is a harness gap.
   - Evidence must survive cleanup. Check it at its path in `.verify/sessions/run-*/evidence/`.
   - Run the Browser pane host checks in verify-screens when the change touches frames or hosts.
   - `run --fresh` stops its own sessions. Stop any other session this pass started with `screens-cli down`.
   - A doctor failure caused by skill drift is drift. Fix it, restart what the fix invalidated, and retry once before calling the pass blocked.
   - A feature is `verified-unreachable` only when you name the prerequisite it needs and the route you tried.
5. **Triage.** Classify each problem:
   - A wrong or missing description is doc drift. Fix it.
   - Behavior that works but that the harness can't drive or reads wrongly is a harness gap. Fix `packages/cli` (or the script), restart the session (`down`, `up`), and rerun the block before shipping it.
   - Behavior that is actually broken is a product gap. Report it, and keep it out of this change.
6. **Ship or stop.**
   - **changed:** re-read every changed file, then ship one change. Use one PR when the user asks for a PR.
   - **clean or blocked:** report the outcome and the coverage honestly.

Keep run notes (features covered, unreachable prerequisites, confirmed drift, outcome) in `.verify/maintain/`. That folder is gitignored, so the notes never get committed.
