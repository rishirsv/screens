# Undo and redo

Undo and redo reverse the person's own canvas edits through the service. They apply only when the fields an edit touched are still what that edit wrote. An agent's change to the same field makes undo or redo refuse with a toast instead of overwriting it. Agent edits never enter the person's stack.

## Sub-features

- `undo-own`: Cmd+Z undoes the last move, stroke, delete or rename. Cmd+Shift+Z redoes it. With nothing to undo, the key does nothing.
- `undo-cascade`: undoing a delete restores the frames and their strokes with the same IDs.
- `redo-cascade`: redo after restoring a frame with a thread removes the dependent records in order, and another undo restores them again.
- `undo-invariants`: dependent document, piece and library edits redo in order; undo and redo refuse when another writer consumed the available capacity.
- `undo-unrelated`: undo still applies when the agent has changed other items, or other fields of the same item.
- `undo-guard`: undo or redo fails when the touched field has changed since, with the toast "Can't undo: it changed since" or "Can't redo: it changed since".
- `undo-anchored`: redoing a delete refuses when someone has drawn on the item since, instead of orphaning the stroke.
- `undo-session`: each tab has its own stack, which survives a reload and is lost when the service restarts.
- `undo-replay`: lost undo results and concurrent retries return stable receipts; conflicting operation-ID reuse cannot consume history or deadlock purge.

## How to get to it (user POV)

- Press Cmd+Z or Cmd+Shift+Z on the canvas.

## Driving it with screens-cli

```screens id=undo-own
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
undo
expect pending.size=0 dom.toast=null
drag @A.title by 80,0
expect doc.@A.x=80 history.canUndo=true history.undo.size=1
undo
expect doc.@A.x=0 history.canRedo=true
redo
expect doc.@A.x=80
```

```screens id=undo-cascade
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
tool pencil
draw @A+60,150 by 80,20 as=@k
tool move
click @A
key Backspace
expect doc.items.size=0
undo
expect doc.@A.title=A doc.@k.anchor=@A
```

```screens id=undo-unrelated
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
add_object title=B files=fixture:plain x=500 y=0 height=300 as=@B
drag @A.title by 60,0
arrange_items items=[{"itemId":"@B","x":500,"y":360}]
update_object itemId=@A expectedRevision=3 files=fixture:modules
expect doc.@A.cv=last.contentVersion
undo
expect doc.@A.x=0 doc.@B.y=360 doc.@A.files has app.js
```

```screens id=redo-cascade
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
add_comment itemId=@A x=100 y=60 text=First as=@T
reply_comment threadId=@T text=Second as=@c
tool pencil
draw @A+60,150 by 80,20 as=@k
tool move
click @A
key Backspace
expect doc.items.size=0 doc.threads.size=0 doc.strokes.size=0 storage.rev=doc.rev
undo
expect doc.@A.title=A doc.@T.comments=2 doc.@k.anchor=@A storage.rev=doc.rev
redo
expect doc.items.size=0 doc.threads.size=0 doc.strokes.size=0 pending.size=0 storage.rev=doc.rev
undo
expect doc.@A.title=A doc.@T.comments=2 doc.@k.anchor=@A storage.rev=doc.rev
```

```screens id=undo-guard
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
drag @A.title by 60,0
undo
arrange_items items=[{"itemId":"@A","x":300,"y":0}]
mark
redo
expect doc.rev=+0 doc.@A.x=300 pending.failed=1 dom.toast="Can't redo: it changed since"
toast dismiss
expect pending.size=0
```

```screens id=undo-anchored
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
click @A
key Backspace
undo
view open v2
tool pencil --view v2
draw @A+60,150 by 80,20 --view v2 as=@k
redo
expect doc.@A.title=A doc.@k.anchor=@A dom.toast="Can't redo: it changed since"
view close v2
```

```screens id=undo-session
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
drag @A.title by 60,0
view open v2
key Mod+z --view v2
expect doc.@A.x=60
view reload v1
expect history.canUndo=true
undo
expect doc.@A.x=0
view close v2
```

The replay probe drives the same canvas WebSocket requests as the app, with fixed operation IDs so it can repeat an exact undo after losing its answer. MCP has no undo tool. It also queues conflicting imports and races a permanent delete against an edit reusing its operation ID.

```screens id=undo-replay
probe history-replay
expect last.firstReplay=true last.undoEmpty=true last.redoReplay=true last.mismatch=true last.emptyHistoryStable=true last.emptyLibraryStable=true last.importMismatch=true last.purgeCompleted=true last.legacySnapshot=true last.revision=5 last.title=First
service restart
probe history-replay
expect last.firstReplay=true last.undoEmpty=true last.redoReplay=true last.mismatch=true last.emptyHistoryStable=true last.emptyLibraryStable=true last.importMismatch=true last.purgeCompleted=true last.legacySnapshot=true last.revision=5 last.title=First
```

```screens id=undo-invariants
probe history-invariants
expect last.batchOrder=true last.pieceOrder=true last.libraryOrder=true last.itemLimit=true last.strokeLimit=true last.threadLimit=true last.commentLimit=true last.folderLimit=true
service restart
expect storage.damaged=0
```

## Gotchas

- A conflicting undo entry is dropped because it can no longer apply. A storage failure retains the entry for a later retry.
- Agent edits never enter a stack, so `undo` after an agent-only change does nothing.
