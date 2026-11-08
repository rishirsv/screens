# Presence

Agents are visible participants on the canvas. Each MCP connection, and each subagent that names itself on a shared connection, gets a cursor in its own color resting on the item it works on, a label with what it is doing, a face in the roster, and a dashed placeholder where a new object will land. None of it is a revision: it is never stored, undone or exported, and a placeholder turns into a saved frame only when the add commits.

## Sub-features

- `presence-status`: `set_status` on an item puts the agent's cursor and label on it and a face in the roster, with no revision. An empty `set_status` clears it.
- `presence-lanes`: subagents sharing one connection each pass a name, get their own cursor and color, and their later calls are attributed to them, comment authors included. `get_view` lists the others.
- `presence-placeholder`: `set_status new` reserves the next free slot and shows a placeholder. An add without x/y lands in it, a refused add keeps it, and a commit that covers it moves it.
- `presence-note`: an agent changing an item the person is dragging gets a one-line note in its result.
- `presence-follow`: an off-screen agent shows a marker at the edge, the marker locates it, and Follow keeps its work in view until the person presses Escape or scrolls.
- `presence-expiry`: statuses, reservations, drafts and idle agents expire, and the canvas drops their cursors, placeholders and draft frames.
- `presence-draft-new`: a new object sent in `more` parts grows as a draft inside its placeholder with no revision; immediately retrying the last part's opId changes nothing; the final part saves the joined object where the placeholder was and the draft ends.
- `presence-draft-lanes`: two subagents on one connection write new objects at once, each naming itself, and each saves only its own parts in its own reservation.
- `presence-draft-update`: an update sent in parts shows as a dashed draft over the saved frame, which stays as it was until the final part commits.
- `draft-final-overlap`: parts received while an earlier final save commits form the next draft and survive its completion.
- `draft-ordinary-overlap`: a complete nonmultipart save cannot consume a new draft that starts during its upload/check.
- `draft-final-restart`: replaying a multipart final after adapter and service restarts returns the committed receipt without a second revision.

## How to get to it (user POV)

- An agent works on an open Screen: its cursor appears on the item it changes. It calls `set_status` to say what it is doing, and `set_status new` before writing a new object.
- The faces at the top right list the agents. Click them for each agent's status in full; click an agent to follow it (again to stop), or the eye to hide its cursor.
- A colored marker at the edge of the canvas points at an agent working off-screen; click it to go there.
- An agent writing a long object sends it in parts: the person watches it grow inside the placeholder, marked Draft, until the final part saves it.

## Driving it with screens-cli

```screens id=presence-status
add_object title=Checkout files=fixture:plain x=0 y=0 height=400 as=@A
mark
set_status text="Refining the checkout" itemId=@A
wait presence.roster.size=1 presence.roster.Screens-Cli.target=@A dom.presence.cursors.Screens-Cli=@A
expect presence.roster.Screens-Cli.status="Refining the checkout" dom.presence.labels.Screens-Cli~="Refining the checkout" dom.presence.faces=1 doc.rev=+0 storage.rev=doc.rev
set_status
wait presence.roster.Screens-Cli.status=null presence.roster.Screens-Cli.target=null
expect doc.rev=+0
```

```screens id=presence-lanes
add_object title=Header files=fixture:plain x=0 y=0 height=400 as=@A
add_object title=Receipt files=fixture:plain x=500 y=0 height=400 as=@B
set_status name=Ada text="Tightening the header" itemId=@A
set_status name=Bo text="Trying a dark receipt" itemId=@B
wait presence.roster.size=3 dom.presence.cursors.Ada=@A dom.presence.cursors.Bo=@B
expect presence.roster.Screens-Cli.color=0 presence.roster.Ada.color=1 presence.roster.Bo.color=2 dom.presence.faces=3
add_comment itemId=@B x=20 y=20 text="Dark works"
expect last.current.thread.comments.0.author.name=Bo
get_view
expect last.others.size=2
```

```screens id=presence-placeholder
add_object title=Cart files=fixture:plain x=0 y=0 width=400 height=300 as=@A
mark
set_status name=Ada text="Designing the receipt" new=true width=390 height=500
expect last.x=480 last.y=0 last.width=390 last.height=500
wait dom.presence.placeholders.Ada=announced dom.presence.cursors.Ada=incoming
expect doc.rev=+0 doc.items.size=1
!add_object title=Stuck files=fixture:never-loads
wait presence.roster.Ada.incoming.phase=announced presence.roster.Ada.call=null
expect doc.items.size=1 dom.presence.placeholders.Ada=announced
add_object title=Blocker files=fixture:plain x=500 y=0 width=200 height=200 as=@K
wait presence.roster.Ada.incoming.x=780
add_object title=Receipt files=fixture:plain as=@R
expect doc.@R.x=780 doc.@R.y=0 doc.@R.width=390 doc.@R.height=500
wait presence.roster.Ada.incoming=null dom.presence.placeholders={}
```

```screens id=presence-note
add_object title=Cart files=fixture:plain x=0 y=0 height=300 as=@A
view open v2 --context
press @A.title --view v2
move by 40,0 --view v2
arrange_items items='[{"itemId":"@A","x":10,"y":0}]' --no-settle
expect last.note="The person is moving Cart"
release --view v2
wait doc.@A.x=40
view close v2
```

```screens id=presence-follow
add_object title=Here files=fixture:plain x=0 y=0 height=400 as=@A
add_object title=Far files=fixture:plain x=8000 y=0 height=400 as=@F
set_status name=Ada text="Refining here" itemId=@A
set_status name=Bo text="Polishing far away" itemId=@F
show_items itemIds='["@A"]'
wait view.animation=null dom.presence.cursors.Bo=@F
wait dom.presence.pips.Bo=right
click ui:"Show Bo, off screen"
wait view.animation=null dom.presence.pips.Ada=left
click ui:"Agents on this Screen"
click ui:"Follow Ada"
wait view.animation=null dom.presence.following=Ada
expect view.following!=null dom.presence.pips.Bo=right
set_status name=Ada text="Joining Bo" itemId=@F
wait presence.roster.Ada.target=@F
wait view.animation=null dom.presence.pips={}
key Escape
expect view.following=null dom.presence.following=null
```

```screens id=presence-expiry
add_object title=Cart files=fixture:plain x=0 y=0 height=300 as=@A
set_status name=Ada text="Refining the cart" itemId=@A
set_status name=Bo text="Designing the receipt" new=true
wait presence.roster.size=3 dom.presence.placeholders.Bo=announced
add_object title=Receipt more=true files='[{"path":"index.html","content":"<h1>Receipt</h1>"}]'
wait dom.presence.drafts.Bo=1
fault expire-presence
wait presence.roster.size=0 dom.presence.cursors={} dom.presence.placeholders={} dom.presence.drafts={} dom.presence.faces=0
```

```screens id=presence-draft-new
add_object title=Cart files=fixture:plain x=0 y=0 width=400 height=600 as=@A
mark
add_object title=Receipt more=true files='[{"path":"index.html","content":"<!doctype html><html><head><style>h1{color:#a357d7"}]'
wait presence.roster.Screens-Cli.draft.rev=1 presence.roster.Screens-Cli.incoming.x=480 dom.presence.placeholders.Screens-Cli=announced
add_object title=Receipt more=true opId=part-2 files='[{"path":"index.html","content":"}</style></head><body><h1>Receipt</h1><p>Order 1042</p>"}]'
add_object title=Receipt more=true opId=part-2 files='[{"path":"index.html","content":"}</style></head><body><h1>Receipt</h1><p>Order 1042</p>"}]'
expect last.repeated=true last.draft.parts=2
add_object title=Receipt more=true files='[{"path":"index.html","content":"<hr>"}]'
add_object title=Receipt more=true files='[{"path":"index.html","content":"<hr>"}]'
expect last.draft.parts=4
wait dom.presence.drafts.Screens-Cli=4 presence.roster.Screens-Cli.draft.held=presence.roster.Screens-Cli.draft.chars
expect doc.rev=+0 storage.rev=doc.rev doc.items.size=1
add_object title=Receipt opId=receipt-final files='[{"path":"index.html","content":"<p>Total 42</p></body></html>"}]' as=@R
expect doc.@R.x=480 doc.@R.y=0
wait presence.roster.Screens-Cli.draft=null dom.presence.drafts={} dom.presence.placeholders={}
read_object itemId=@R format=files
expect last.files.0.content~="Order 1042</p><hr" last.files.0.content~="Total 42</p></body></html>" last.files.0.content~="h1{color:#a357d7}"
mark
add_object title=Receipt opId=receipt-final files='[{"path":"index.html","content":"<p>Total 42</p></body></html>"}]'
expect last.status=committed last.itemId=@R doc.rev=+0 doc.items.size=2
```

```screens id=presence-draft-lanes
set_status name=Ada text="Designing the receipt" new=true width=390 height=500
set_status name=Bo text="Designing the invoice" new=true width=390 height=500
expect last.x=470
add_object title=Receipt name=Ada more=true files='[{"path":"index.html","content":"<h1>Receipt"}]'
add_object title=Invoice name=Bo more=true files='[{"path":"index.html","content":"<h1>Invoice"}]'
add_object title=Receipt name=Ada more=true files='[{"path":"index.html","content":"</h1><p>Ada"}]'
wait dom.presence.drafts.Ada=2 dom.presence.drafts.Bo=1
add_object title=Invoice name=Bo files='[{"path":"index.html","content":"</h1><p>Bo</p>"}]' as=@B
add_object title=Receipt name=Ada files='[{"path":"index.html","content":"</p>"}]' as=@A
expect doc.@A.x=0 doc.@B.x=470
read_object itemId=@A format=files
expect last.files.0.content~="Receipt</h1>" last.files.0.content~="Ada</p>"
read_object itemId=@B format=files
expect last.files.0.content~="Invoice</h1>" last.files.0.content~="Bo</p>"
wait dom.presence.drafts={} dom.presence.placeholders={}
```

```screens id=presence-draft-update
add_object title=Cart files=fixture:plain x=0 y=0 width=400 height=600 as=@A
mark
set_status name=Ada text="Trying a dark cart" itemId=@A
update_object itemId=@A expectedRevision=1 more=true files='[{"path":"index.html","content":"<body style=\"background:#111;color:#eee\"><h1>Cart"}]'
wait presence.roster.Ada.draft.itemId=@A dom.presence.placeholders.Ada=drafting dom.presence.drafts.Ada=1
expect doc.rev=+0 frames.@A.gen=+0
update_object itemId=@A expectedRevision=1 files='[{"path":"index.html","content":"</h1><p>Dark</p></body>"}]'
expect doc.rev=+1
wait presence.roster.Ada.draft=null dom.presence.drafts={} dom.presence.placeholders={}
read_object itemId=@A format=files
expect last.files.0.content~="Cart</h1>" last.files.0.content~="Dark</p></body>"
```

```screens id=draft-final-overlap
add_object title=Old more=true opId=draft-old files='[{"path":"index.html","content":"<h1>Old"}]'
fault delay-commit 1500
begin saving add_object title=Old opId=final-old files='[{"path":"index.html","content":"</h1>"}]'
add_object title=New more=true opId=draft-new files='[{"path":"index.html","content":"<h1>New"}]' --no-settle
expect last.draft.parts=1
wait service.commitStage=before-write
join saving
wait presence.roster.Screens-Cli.draft.rev=1 presence.roster.Screens-Cli.draft.chars=7 presence.roster.Screens-Cli.draft.held=7 presence.roster.Screens-Cli.incoming.phase=announced dom.presence.drafts.Screens-Cli=1
add_object title=New more=true opId=draft-new-next files='[{"path":"index.html","content":"<p>Retained</p>"}]'
expect last.draft.parts=2
add_object title=New opId=final-new files='[{"path":"index.html","content":"</h1>"}]' as=@N
read_object itemId=@N format=files
expect last.files.0.content has New last.files.0.content has Retained last.files.0.content !has Old doc.items.size=2 doc.rev=2 storage.rev=2
service restart
read_object itemId=@N format=files
expect last.files.0.content has New storage.damaged=0
```

```screens id=draft-final-restart
add_object title=Saved more=true files='[{"path":"index.html","content":"<h1>Kept"}]'
add_object title=Saved opId=draft-restart-final files='[{"path":"index.html","content":"</h1>"}]' as=@A
agent restart
add_object title=Saved opId=draft-restart-final files='[{"path":"index.html","content":"</h1>"}]'
expect last.status=committed last.itemId=@A doc.rev=1
service restart
add_object title=Saved opId=draft-restart-final files='[{"path":"index.html","content":"</h1>"}]'
expect last.status=committed doc.rev=1 storage.rev=1
!add_object title=Changed opId=draft-restart-final files='[{"path":"index.html","content":"</h1>"}]'
expect last.error.code=invalid doc.rev=1
read_object itemId=@A format=files
expect last.files.0.content has Kept
update_object itemId=@A expectedRevision=1 more=true files='[{"path":"index.html","content":"<h1>Updated"}]'
update_object itemId=@A expectedRevision=1 opId=draft-update-final files='[{"path":"index.html","content":"</h1>"}]'
agent restart
update_object itemId=@A expectedRevision=1 opId=draft-update-final files='[{"path":"index.html","content":"</h1>"}]'
expect last.status=committed doc.rev=2
service restart
update_object itemId=@A expectedRevision=1 opId=draft-update-final files='[{"path":"index.html","content":"</h1>"}]'
expect last.status=committed doc.rev=2 storage.rev=2
read_object itemId=@A format=files
expect last.files.0.content has Updated
add_object title=Assets more=true files='[{"path":"index.html","content":"<h1>Assets</h1>"}]'
add_object title=Assets opId=asset-only-final files='[{"path":"app.css","content":"h1{color:blue}"}]' as=@C
agent restart
add_object title=Assets opId=asset-only-final files='[{"path":"app.css","content":"h1{color:blue}"}]'
expect last.status=committed last.itemId=@C doc.rev=3
service restart
add_object title=Assets opId=asset-only-final files='[{"path":"app.css","content":"h1{color:blue}"}]'
expect last.status=committed doc.rev=3 storage.rev=3
read_object itemId=@C format=files
expect last.files.0.content has Assets last.files.1.path=app.css
```

```screens id=draft-ordinary-overlap
fault delay-commit 1500
begin saving add_object title=Ordinary files=fixture:plain opId=ordinary-overlap
add_object title=Next more=true files='[{"path":"index.html","content":"<h1>Next"}]' --no-settle
expect last.draft.parts=1
join saving
wait presence.roster.Screens-Cli.draft.rev=1 presence.roster.Screens-Cli.draft.chars=8 presence.roster.Screens-Cli.draft.held=8 presence.roster.Screens-Cli.incoming.phase=announced dom.presence.drafts.Screens-Cli=1
add_object title=Next opId=next-overlap files='[{"path":"index.html","content":"</h1>"}]' as=@N
read_object itemId=@N format=files
expect last.files.0.content has Next doc.items.size=2 doc.rev=2 storage.rev=2
```

## Gotchas

- The roster reaches the canvas at most every 100 ms. `wait` for a roster or cursor change before asserting on the camera or the DOM it drives.
- The CLI's MCP adapter is one connection, named from its client name: `Screens Cli`. Lanes (`name=`) stand in for subagents. Roster and DOM keys replace spaces with `-`.
- An agent step waits for every canvas to settle. While a person holds a drag, pass `--no-settle`.
- `fault expire-presence` sweeps as if every limit had passed, so statuses, reservations and idle agents all go at once. The 30 s status, 120 s reservation and 5 min idle limits are `PRESENCE_*` in packages/protocol.
- A saved object gets a `data-pid` on every element, so compare saved text around tags, not exact markup.
- A draft runs no script: its frame is `sandbox=""` under the snapshot CSP. No layer can read inside it, so the proof is the screenshot of a part that sets the background with a script and keeps its own. The draft frame reports which part it shows (`dom.presence.drafts`).
- The local person is never drawn on their own canvas, and every tab on this machine is that one person. Cursors between people come with cloud.
