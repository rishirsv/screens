# packages/cli

`screens-cli` drives Screens for verification. It is dev only: nothing imports it, and it never ships.

```text
main.ts      argv → one-line script, or up/down/ls/check/run; prints results
script.ts    tokenizer, VERBS (the only command list), parser, feature-block extraction
session.ts   .verify/sessions/<name>/, spawning the daemon, up/down
daemon.ts    hosts one Driver on loopback with a token; one request at a time
driver.ts    the executor: dev service, MCP adapter, observer, browser views, handles, evidence
agent.ts     MCP stdio client; knows no tool by name
person.ts    real Playwright and CDP input, with a hit check before every press
state.ts     handles, paths, expressions, encoders, deltas (pure)
bindings.ts  exhaustive maps over engine commands, inputs, effects, document fields, events
check.ts     contracts, boundaries (no test hook in production bundles), coverage of feature blocks
```

- **Agent commands come from MCP `tools/list`.** Never list or special-case a tool here. If a result prints badly, fix the generic encoder in `state.ts`.
- **Person commands are real input.** Never dispatch into the runtime, force a click, remove a shield or change zoom to make a step pass. A missing capability is a product gap: report it.
- **Keep `bindings.ts` and the hook's `VIEW_PROBE` exhaustive.** When typecheck fails there, bind the new surface to a verb or layer, and add a `screens` block that uses it.
- **Mutations go through MCP or the page, never storage.** Each layer is read from its owner: the service, the page's test hook, or `inspectLibrary`.
- **Output stays one line per step**: deltas, handles and evidence paths, never full IDs or pretty JSON.
- **Prove a change** with `screens-cli down && screens-cli up` (the daemon keeps old code), then the affected feature blocks and `screens-cli check`. Run the full suite for changes that cross several features.
