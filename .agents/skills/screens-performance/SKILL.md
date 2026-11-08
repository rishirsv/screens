---
name: screens-performance
description: Measure, compare and improve Screens performance using the bundled measurement scripts. Use only when the user asks to measure, benchmark, profile, fix a slowdown or hill-climb a metric, or when a change explicitly targets performance. Never run benchmarks as a routine check.
---

# Screens performance

Performance is a product feature, so every claim needs a measurement. Run benchmarks **only on request**. Benchmarks are not part of tests, verification or CI. Reading this skill is always fine, but running a benchmark takes an explicit ask.

Keep baselines in `.perf/baselines/` and runs in `.perf/runs/<run-id>/`. Both are gitignored. These artifacts can contain local paths and process details. Share only the measurements and evidence needed for the result.

## Tracked metrics

Choose a metric, workload, and host before measuring. Set a budget only from measured results and an explicit decision.

| ID | Metric | Unit | Workload | Harness |
|---|---|---|---|---|
| `frame-ready` | Host iframe mount until the child reports `ready` | ms, median of ≥5 | payloads 0, 1, 5, 20 MB | `verify-screens/scripts/frame-probe.mjs` |
| `gesture-latency` | Synthetic pointermove on the stage until the next animation frame, during an item drag | ms, p50/p95/p99 | 1, 16, 50, 200, 500 items | `scripts/canvas-bench.mjs` (`/bench`) |
| `camera-frame-time` | rAF intervals during a scripted pan and zoom, plus a count of frames over 50 ms | ms, p50/p95/p99 | 1, 16, 50, 200, 500 items | `scripts/canvas-bench.mjs` |
| `live-frames` | Settled ready counts per repetition and maximum across the run, checked against the imported cap (16 fine, 6 coarse, plus 1 while forced) | count | same | `scripts/canvas-bench.mjs` |
| `commit-latency` | Pointer-up of a drag until the committed revision retires the pending entry | ms, p50/p95 | same | `scripts/canvas-bench.mjs` |
| `memory` | JS heap per repetition (canvas document’s `performance.memory`, decimal MB; not total frame/process memory) | MB | same | `scripts/canvas-bench.mjs` |
| `work-time-per-frame` | Headless: renderer main-thread `RunTask` wall time per camera rAF interval. In-app: sampled OS whole-app CPU lower bound / completed camera frames. Both exclude GPU device work | ms, five rep means/ranges; headless also frame percentiles | same; separate 5-rep instrumented pass | `scripts/canvas-bench.mjs --profile` |
| `idle-cpu` | OS cumulative CPU time delta of the recorded browser process tree; 100% is one logical core | % | exactly 16 JS-animated frames, five still/moving windows | `scripts/canvas-bench.mjs --idle --content js-animated` |

`frame-ready`, `gesture-latency`, `camera-frame-time` and `commit-latency` are the primary metrics, because a person feels them. `live-frames` is an invariant. `memory` and `idle-cpu` are secondary.

Workload dimensions that move these results:
- item count
- snapshot payload size
- the content mix (static, CSS-animated, JS-animated, media, scrollable, failing, heavy)
- device pixel ratio
- the host

Record collection order and page lifetime with each baseline. Keep them the same when comparing heap samples.

**Never compare across hosts.** Headless Chrome, headed system Chrome, the in-app browser and the Claude Browser pane are separate baselines. Even identical viewport dimensions do not make their DPR or browser versions comparable.

## Measure (any request)

1. Write the claim before running it: metric, workload, host, and what counts as better.
2. Launch the harness from the metric's row and drive it with at least 5 reps.
   - **Fixed workload:** normal items are 390×844 with an 80-unit gap in `ceil(sqrt(N))` columns. Each rep fits all, resets to 100% zoom and settles. Camera motion is 60 pan frames (12/6 px), then 15 Cmd-zoom-out and 15 Cmd-zoom-in frames (+8/−8 wheel delta on the current controller; the measured `b08ba59` controller used −8/+8 for the same zoom-out/in sequence) about the centre. The drag starts at fit-all and moves the last item 60×30 screen px in 20 synthetic moves, commits, and undoes. It then focuses that item and exercises its child. At fit-all the scheduler may evict live frames, so the drag is a different view from the camera phase. The interaction target is stamped before the first repetition; content-version stability is enforced after each one.
   - **frame-ready:** run `frame-probe.mjs serve` with the run directory at `.perf/runs/<run-id>`, run its doctor, then open `?sizes=0,1000000,5000000,20000000&reps=5&label=<run-id>` in the host.
   - **Canvas metrics:** start a production service on a disposable home: `SCREENS_HOME=$PWD/.perf/home node packages/service/src/cli.ts serve &`. Do not set `SCREENS_DEV`, and never measure a screens-cli session: it runs `--dev` with the test hook compiled in.
   - **Headless Chrome:** run `SCREENS_HOME=$PWD/.perf/home node .agents/skills/screens-performance/scripts/canvas-bench.mjs --out .perf/runs/<run-id> --items 1,16,50,200,500 --reps 5 --doctor`. Follow any browser-launch preflight required by the host environment. Default content is the full seven-type Cartesian matrix. `--content` accepts a comma-separated subset. The runner refuses a dev service registry; `--doctor` also checks the hook is absent, visibility and long-animation-frame support before measuring. A 30-rAF watchdog runs before every case; a stalled rAF rejects the run within 3 seconds.
   - **Work per frame:** repeat with `--profile` in another run directory. This records the same complete workflow, including drag/undo/focus/child interaction, with five ready-settled repetitions. Only the marked 90-frame camera phases are reduced to work time; keeping the whole workflow preserves live-frame history between repetitions. `trace.json` stays in `.perf`; `work-time.json` contains the reduced evidence. `bench-evidence.mjs` reads the trace incrementally, attributes canvas and descendant frame processes, and counts only outer `RunTask` events (never also nested `ThreadControllerImpl::RunTask`). Record trace SHA-256 alongside the reduced baseline. Prove sensitivity with the 16- and 500-item trace distributions before setting a budget. A trace result includes profiling overhead; it is not substituted for an untraced latency result.
   - **Visible in-app browser:** start the runner with `--host in-app-browser`. It prints a loopback URL and collects each completed case. Open that exact URL in the app’s visible native Browser pane with `cua_repl`, and keep it selected throughout. Record native AX/URL and screenshot evidence before/after, actual viewport/DPR, page visibility and watchdog results. In this app version, automation-provider tabs are parked offscreen even when `visibility.set(true)` returns false; they are not the native visible pane. Navigate the native address bar instead. The provider CDP trace did not contain native-pane timing marks, so it is rejected, not used as native work evidence.
   - **In-app work per frame:** repeat the complete matrix with `--host in-app-browser --profile --work-cpu --cpu-pid <app-root-pid>`. The local collector samples OS `ps` cumulative CPU counters every 100 ms and at the boundaries of each 90-frame camera phase. It retains each PID's observed high water through renderer exits. It saves `work-cpu-trace.json` and reduced `work-time.json`, with five windows per case, changed counters, process identities, CPU seconds, elapsed time, sample gaps and CPU ms per completed camera frame. Missing roots, incomplete windows and nonpositive deltas reject the trace. This is a **sampled lower bound**: CPU after a process's final observation and processes that live entirely between samples can be missed. Run `node .agents/skills/screens-performance/scripts/bench-evidence.mjs --cpu-doctor --out .perf/runs/<run-id>/cpu-doctor.json` before accepting this accounting; phase-boundary-only sampling rejected renderer exits, and macOS `ps -S` rollup failed the doctor, so neither is used here. Scope is the whole Codex application tree (including UI and other app activity), excluding the sampler subtree. Centisecond counters, sampling and boundary requests add measurement overhead. It is not renderer-only work or GPU device time. Keep the app visible and retain LoAF alongside it. Prove 16/500 sensitivity within this scope; never compare it to headless renderer wall time. Terminate only the recorded collector PID after completion to write `results.json`. If rAF stalls or the pane hides, save the failure and report **blocked**; never use a hidden run.
   - **OS CPU:** run `--idle --content js-animated --items 16 --reps 5` separately. Compact 240×160 fixtures ensure exactly 16 frames are live, ready and animated throughout each still/moving window; an unexpected live count fails. The runner samples OS `ps` cumulative CPU time at each phase boundary, including browser, renderer and GPU descendants. It saves elapsed time, CPU seconds, process IDs and commands, plus five-window medians/ranges. A process exit invalidates the window. For the in-app host, pass `--host in-app-browser --cpu-pid <app-root-pid>` and label its scope as the whole application tree (other app activity is included). Never call an rAF counter CPU usage.
   - **Headed system browser frame-ready:** start/doctor the frame probe as above, then run the Chrome runner through the GUI preflight with `--frame-ready --probe-dir .perf/runs/<probe-id> --headed --out .perf/runs/<run-id> --reps 5`. This measures all four payloads and checks every isolation result and completed mount count.
   - **Claude Browser pane (only if requested):** open `<canvasOrigin>/bench?items=1,16,50,200,500&reps=5` and read `window.__benchResults`. Keep it visible and use the same stalled-rAF rejection. Keep its results separate from other hosts.
3. Check the completed run:
   - `errorCount` is 0. Every repetition starts from the same camera and waits up to 10 s until the live set is stable and every live frame reports ready; `work.readiness` records live, ready, whether it settled and the wait per repetition. A repetition that never settles, or has fewer live frames than the first, counts as an error. The interaction target gets layer IDs through the service before timing, so opening the Layers panel cannot change the fixture on the first focus. Every completed repetition asserts all content versions are unchanged; `fixtureContentStable` must be true (harness v4).
   - completed work matches what was requested.
   - the host is the one intended.
   - the requested embedded browser was visible for the whole run. Record native pane AX/screenshot evidence as well as page visibility and watchdog results; a parked provider tab is insufficient.
   - nothing else heavy is running.
   - the medians and ranges are reported, not the best run.
4. Compare against the baseline artifact. For `frame-ready`:

   ```bash
   node .agents/skills/screens-performance/scripts/perf-compare.mjs .perf/baselines/<baseline>.json .perf/runs/<run-id>/result-*.json
   ```

   Each verdict is one of `faster`, `slower`, `no measurable difference` or `inconclusive`. An inconclusive or wrong-host result is not a pass. Say which it is. For canvas metrics, report per-content, per-count medians and min–max ranges of repetition percentiles, not just pooled percentiles. Frame >50 ms counts remain totals across all five reps. Check 450 camera frames, 100 drag moves, five committed drags, focuses and acknowledged child interactions per untraced case. A profile case must complete the same work counts; its instrumented latency values are diagnostic and do not replace the untraced baseline. The child exercise is scripted through the existing highlight/rect bridge: it clicks a button, checks the count, scrolls the scrollable fixture (v4 accepts a subpixel difference from the requested 100 px; native DPR 1.2 measured 99.99999237060547), and asserts media decode, running CSS animation or the expected broken image. It also traverses the production pointer bridge. It is not a trusted-input hit-test benchmark; verify that path separately with screens-cli. Static fixtures have this dormant exercise script; heavy has 1,200 continuously relaid-out cards; media uses a bundled two-frame GIF. Long-animation-frame entries are supplementary, thresholded at 50 ms and therefore do not measure sub-threshold headroom. Use the separate host-specific work trace for that. Frame time and gesture latency sit at the 60 Hz frame interval, so they can show a regression but not an improvement.
5. Report: the baseline number, the new number, the delta, and the artifact path.

## Opening latency (development)

Use the existing repository interface; never install a benchmark plugin or register a temporary MCP adapter. Run from the experiment worktree. The runner owns its disposable service and closes it after an automated run.

```bash
SCREENS_HOME=$PWD/.perf/opening/home node .agents/skills/screens-performance/scripts/opening-bench.mjs --headless --fixtures .agents/skills/screens-performance/fixtures/opening-v1 --out .perf/runs/opening-browser --run opening-browser
SCREENS_HOME=$PWD/.perf/opening/home node .agents/skills/screens-performance/scripts/opening-bench.mjs --headless --app-relay --fixtures .agents/skills/screens-performance/fixtures/opening-v1 --out .perf/runs/opening-app-control --run opening-app-control
```

The browser control renders the real `LibraryApp`. The app-relay control uses the existing repository adapter and its real resource inside the CLI development host; its private test subprocess is closed afterward. It installs/registers nothing. Both navigate Library → Screen through production routing. They are **development controls**, not native Codex app-tab or in-app-browser measurements. Never compare hosts. Native-host work requires authorization for that host; a control never supplies a native-host baseline.

Each case records one first open in the view and six warm reopens. Report them separately; the single first-open observation is diagnostic, not a cold p95. Warm reopens retain browser/service caches. Library covers may warm generated posters before timing, so the on-demand case is not a cold poster-render benchmark. Default cases are stored posters at 16/500 items, plus shared 1 MB CSS bundles and on-demand posters at 16. `--items` and `--content` select cases; `animated` is a separate holdout. Frozen `.screens` exports live in this skill’s `fixtures/opening-v1`; pass that same directory with `--fixtures` to each separate experiment worktree. Animated holdouts use `--content animated --items 9,16 --fixtures .agents/skills/screens-performance/fixtures/opening-holdout-v1`. Each `--out` must be fresh; failed and previous runs are retained. No Screen storage is written directly.

The runner saves an OS process snapshot before browser launch; inspect it for competing work and record any shared-machine qualification. Doctor/checklist checks include the actual served JS hash, service identity, exact fixture digest/matrix, seven exact repetition IDs/modes, absent test hook, zero browser errors, full current visible coverage, settled readiness, unchanged document/camera, live cap and a three-second rAF watchdog. It rejects hidden/stalled views and records sampling overhead. Initial auto-fit is observed, then geometry is frozen only after viewport reconciliation; timing starts at route activation, not after settlement.

Raw stages distinguish document opening, admission, poster load, app asset reads/inlining, srcdoc preparation, accepted ready messages and visible-surface paint opportunities. Readiness and the extra 400 ms stability check are separate metrics. Overlapping request spans cannot be summed into a total. A rAF paint opportunity does not establish the physical compositor presentation time.

Reduce a matched pair with `node .agents/skills/screens-performance/scripts/opening-summary.mjs --baseline .perf/runs/<before>/results.json --candidate .perf/runs/<after>/results.json --out .perf/<comparison>.json`. Use `--control` for a same-code repeat. The reducer rejects failed or stale runs, changed measurement sources, and mismatched targets. Keep detailed output and accepted baselines in `.perf/`. Follow any browser-launch preflight required by the host environment.

Freeze the runner/observer/fixture bytes before optimizations. Measure a same-code repeat to establish noise; keep every attempted mechanism in its own worktree and log it. A winner must improve beyond that noise with identical target coverage, final live set and content. Verify the winning path plus isolation and camera/focus through `screens-cli`; publish only the code PR, never a plugin release.

## Fix a slowdown (perf issue)

1. Capture a baseline as above. Then run the `how` skill on the hot path, and profile it separately from the timed runs.
2. Try fixes in this order and stop at the first one that meets the target:
   1. Don't do the work.
   2. Don't do it again.
   3. Do less of it.
   4. Do it later.
   5. Do it when nobody is looking.
   6. Do it concurrently.
   7. Do it more cheaply.
3. If a fix crosses a function boundary, run `architect` first. Make one change, measure, and keep it or revert it.
4. Cite the measurement and the artifact path in the PR.

## Hill-climb a metric

Use this when asked to improve one metric over many iterations.

1. Fix the metric, the direction that counts as better, and a stop rule that pairs a target with a minimum number of attempts. One example: "≥30% better and ≥10 iterations".
2. Freeze the harness after proving it can tell an easy workload from a hard one. Record the baseline and a green `verify-screens` run before changing anything.
3. Log every attempt to `.perf/hillclimb/<metric>/decision.tsv`, which is gitignored. Columns: `id, hypothesis, change, before, after, delta, verify, verdict, note`. Read the log before each attempt.
4. Loop on one hypothesis per iteration:
   - Name the mechanism, and order hypotheses by the fix list above.
   - Measure before and after.
   - Keep a change only when it moves past the noise and `verify-screens` stays green. Otherwise revert it completely.
   - Make one commit per kept change, staging only the files you changed.
5. Push past the first plateau before stopping. Never relax the stop rule. Correctness and simplicity outrank the number.
6. When the run ends, keep the accepted baseline in `.perf/baselines/` with its host, workload, revision, repetitions, and artifact hashes.

## Adding a metric's harness

When you add a metric (for example `idle-cpu` or work time per frame):
- Build its harness as a script with a doctor check.
- Make it print an error count and a count of the work it completed.
- Prove it can tell 16 items from 500 items.
- Keep the first baseline in `.perf/baselines/` with its measurement conditions.
