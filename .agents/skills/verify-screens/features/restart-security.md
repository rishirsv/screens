# Restart and security

Screens survive a service restart with the same IDs, and an open canvas reconnects on its own when the service returns at the same origin. Domain operations require the per-install token; the app, health and capability-scoped content have separate HTTP access rules. Requests with a foreign Host or Origin are refused, and a snapshot frame loads only with the Screen's capability. A crash leaves the old or the new revision, never half of one.

## Sub-features

- `persist`: after a restart the same items, positions, content versions and strokes come back, on disk and in the canvas.
- `reconnect`: while the connection is down the canvas shows "Reconnecting…", then reconnects and asks for the status of any unresolved operation instead of resubmitting it.
- `crash`: a crash before the write leaves the old revision and no staging files.
- `crash-after`: after a crash between the write and the answer, `op_status` reports the commit and a retry with the same `opId` returns it without a second revision.
- `lost-result`: a commit whose result never arrives is still shown once its revision lands.
- `reconnect-accepted-failure`: a request still accepted when the canvas reconnects later reports its failure and can be retried.
- `security`: a wrong token closes with 4401, a foreign Host gets 421, a foreign Origin is refused, a frame host without the capability gets 403, dev controls refuse a wrong secret, and oversized frames before/after authentication close only the offending socket with 1009.

## How to get to it (user POV)

- The service restarts or crashes, or something else on the machine or a web page tries to reach it.

## Driving it with screens-cli

```screens id=persist
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
tool pencil
draw @A+60,150 by 80,20 as=@k
tool move
mark
service restart
expect doc.rev=+0 doc.@A.x=0 doc.@k.anchor=@A storage.rev=doc.rev frames.@A.load=ready history.canUndo=false
```

```screens id=reconnect
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
fault disconnect
wait dom.reconnecting=true timeout=2s
wait dom.reconnecting=false timeout=15s
expect console.errors=0
```

```screens id=crash
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
mark
fault crash before-write
drag @A.title by 40,0
expect pending.0.status=unknown
service restart
expect doc.rev=+0 doc.@A.x=0 storage.staging=0 storage.orphans=0
service log 3
```

```screens id=crash-after
add_image title=Ref mediaType=image/png width=40 height=40 base64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== as=@I
mark
fault crash after-write
!arrange_items items=[{"itemId":"@I","x":100,"y":0}] opId=crash-after-1
service restart
op_status opId=crash-after-1
expect last.status=committed doc.rev=+1 doc.@I.x=100
arrange_items items=[{"itemId":"@I","x":100,"y":0}] opId=crash-after-1
expect last.status=committed doc.rev=+1
!arrange_items items=[{"itemId":"@I","x":200,"y":0}] opId=crash-after-1
```

```screens id=lost-result
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
fault drop-result
drag @A.title by 40,0
expect doc.@A.x=40 pending.size=0 service.receipts.size>0
fault fail-commit storage
drag @A.title by 40,0
expect pending.failed=1 dom.toast="Couldn't save"
toast retry
expect doc.@A.x=80 pending.size=0
```

```screens id=security
add_object title=A files=fixture:plain height=300 as=@A
probe security
rename_screen title=AliveAfterOversizedFrames
expect doc.title=AliveAfterOversizedFrames storage.rev=doc.rev
```

```screens id=reconnect-accepted-failure
add_object title=A files=fixture:pieces x=0 y=0 height=300 as=@A
mark
fault delay-commit 3000
fault fail-commit storage
drag @A.title by 40,0 --no-settle
fault disconnect
wait dom.reconnecting=true timeout=2s
wait dom.reconnecting=false timeout=15s
wait pending.0.status=accepted timeout=2s
wait pending.failed=1 timeout=5s
expect doc.rev=+0 doc.@A.x=0 storage.rev=doc.rev dom.toast="Couldn't save"
toast retry
expect pending.size=0 doc.rev=+1 doc.@A.x=40 storage.rev=doc.rev
```

## Gotchas

- The token lives in `$SCREENS_HOME/token` and survives restarts, so open canvases reconnect.
- After a crash before the write, the canvas keeps the move as `unknown` and shows "Saving" until it is dismissed: nothing was committed, so no receipt exists. After a crash past the write, the receipt is on disk with the document, and the canvas settles the move on reconnect.
- Content files under `/content/<sha256>` are served without the token, but only to a valid Host. The hash is the access key.
