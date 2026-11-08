# screens-cli sessions

screens-cli itself: sessions that persist across calls, several Screens and views in one session, presence between two people, traces that replay in Node, state reads, and evidence. Each session owns an isolated library, a dev service, the MCP adapter and a browser. Stopping a session retains its library and evidence for inspection.

## Sub-features

- `cli-handles`: `as=` binds handles; `use` switches the current Screen in every view; mutations get journaled `opId`s.
- `cli-presence`: a second person's drag shows as presence in the first view before it commits.
- `cli-trace`: a recorded gesture replays in Node with the same final view.
- `cli-state`: doctor, tools, every state layer and evidence files.

## How to get to it (user POV)

- A developer or agent runs `screens-cli` (see packages/cli/AGENTS.md).

## Driving it with screens-cli

```screens id=cli-handles
create_screen title=Second as=@T
add_object title=X files=fixture:plain height=300 as=@X
expect op.last.status=committed
use @S
expect doc.items.size=0
use @T
expect doc.@X.title=X
```

```screens id=cli-presence
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
view open v2 --context
press @A.title --view v2
move by 60,0 --view v2
wait presence.size=1
release --view v2
wait presence.size=0 doc.@A.x=60
view close v2
```

```screens id=cli-trace
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
trace start
drag @A.title by 3,0
drag @A.title by 40,10 --shift
key Escape
trace stop as=cli-trace
engine replay trace-cli-trace.json
```

```screens id=cli-state
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
doctor
tools
view ls
settle
get
get service.conns
expect service.dev=true events.revisions>0 console.errors=0
dump all as=state
theme dark
invert-scroll on
expect view.theme=dark view.invertScroll=true
theme light
invert-scroll off
```

## Gotchas

- Console counters reset on a main-page navigation, like a browser console with Preserve log off. An expected connection refusal during an earlier restart does not become a later Screen's error.

- The daemon runs the code it started with. After changing packages/cli, the service or the canvas, run `screens-cli down` and `up` again.
- `view open --context` is a second person (own browser context, own undo stack). Without it, a new tab in the same context.
- Headless Chrome is not the Claude desktop Browser pane. Host facts stay in snapshot-frame-isolation's frame-probe section.
