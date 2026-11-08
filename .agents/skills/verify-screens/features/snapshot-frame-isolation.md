# Snapshot frame isolation

A snapshot's HTML runs in a sandboxed `srcdoc` frame with an opaque origin. In the browser it sits inside a host page on the separate frame origin, which sends a network-blocking CSP. The Codex MCP App uses a single sandboxed `srcdoc` frame with the same policy in a meta tag. The snapshot's scripts, modules, styles, fonts and images run from inlined `data:` URLs. The snapshot cannot read storage, cookies, the canvas or other frames, cannot start workers, and cannot make any request. The canvas treats a frame as ready only when the child reports in for the current mount generation.

## Sub-features

- `iso-origin`: the child runs with origin `null`.
- `iso-modules`: import-map modules resolve to `data:` URLs, for static and dynamic `import()`.
- `iso-assets`: inlined images, fonts and CSS load. Images up to at least 20 MB were tested.
- `iso-network`: `fetch`, `http` images and WebSockets fail, both to the service and externally.
- `iso-storage`: `localStorage`, cookies, `parent.document` and `top.document` are all blocked.
- `iso-worker`: a `data:` worker never runs under `worker-src 'none'`.
- `iso-messages`: snapshot scripts forge readiness, stale generations, other-item sizes, canvas commands, domain operations and MCP RPCs to parent and top in both browser and MCP App paths. No committed, pending, view or other-frame state changes.
- `iso-ready`: the canvas accepts `ready` only from its own host window, for the current generation.

## How to get to it (user POV)

- A person opens a Screen and a snapshot frame goes live.

## Driving it with screens-cli

```screens id=iso-real
add_object title=Probe files=fixture:escape-probe x=0 y=0 height=400 as=@P
click @P
inside @P text #done
inside @P text
expect last~="origin: null" last~="control: loaded" last~="localStorage: blocked" last~="parent: blocked" last~="top: blocked" last~="fetchLocal: blocked" last~="fetchExternal: blocked" last~="socket: blocked" last~="worker: blocked"
```

```screens id=iso-assets
add_object title=Big files=fixture:big-image x=0 y=0 height=400 as=@G
expect frames.@G.load=ready
shot @G as=big-image
```

```screens id=iso-messages
add_object title="Message victim" files=fixture:plain x=450 y=0 width=400 height=300 as=@V
add_object title="Message attacker" files=fixture:message-probe x=0 y=0 width=400 height=300 as=@A
mark messages doc storage
probe frame-messages
expect last.browser.cases=8 last.app.cases=8 last.browser.unchanged=true last.app.unchanged=true last.browser.sandbox=allow-scripts last.app.sandbox=allow-scripts
expect doc=mark:messages storage=mark:messages pending.size=0
```

## Driving it with frame-probe

Use this when testing what a host allows, without the service.

- **Mount.** Run `frame-probe.mjs serve --run-dir "$R" &`, then `doctor`. Open `<canvasOrigin>/?sizes=0,1000000&reps=1&label=verify` from `$R/run.json`.
- **Read.** The newest `$R/result-*.json` has `errorCount: 0` and `completedMounts: 2`. Every run's `checks` show `origin` as `"null"`, `staticModule` and `dynamicModule` as `true`, and `storage`, `worker`, `fetchFrameOrigin` and `fetchExternal` as `"blocked"`. Sizes above 0 also show `image: true`.

## Gotchas

- `new Worker(...)` does not throw under CSP; the block arrives as an error event. The probe waits for the worker to post a message.
- `blob:` URLs made by the host page do not load in the opaque child.
- In the Browser pane, any opaque-origin frame loaded with `src` makes no request at all. Only `srcdoc` works.
- Proven in the Claude desktop Browser pane (Chrome 152) and through screens-cli in headless Chrome 156. Linux headless Chromium is untested.
- The message proof types payloads into the snapshot and presses Enter; the snapshot script posts them. Companion stale/error reports make acceptance observable even when a forged `ready` would leave an already-ready frame unchanged. A delayed-commit fault keeps an illicit operation observable as pending. Normal frame interaction reports remain supported.
- `inside` reads the child through Playwright's frame tree. That is a privileged test channel; isolation is proven by the probe's own checks, which run inside the child.
