# Resize and reorder

A selected frame shows eight resize handles, and several selected frames share one box with eight handles that scales them together. Dragging a handle previews the new size live, on this canvas and every other open one, and commits one revision on release. The person brings the selection to the front with `]`, sends it to the back with `[`, and steps it one place forward or backward with Mod+] and Mod+[. The agent does the same with `reorder_items`. A batch with one invalid entry changes nothing. Deleting a reference image clears it from the snapshots that name it as a source.

## Sub-features

- `resize-commit`: a handle drag shows pending until the commit, then commits one `resizeItems` and one undo entry. A top or left handle also moves the origin, in the same revision. Escape mid-drag restores the start.
- `resize-snap`: a moving edge within 8 screen px of another frame's edge snaps to it and shows an alignment guide. Holding Cmd or Ctrl turns snapping off. A handle never makes a frame smaller than 24 units.
- `resize-aspect`: a reference image's corner keeps its aspect ratio along whichever axis moved more, and Shift frees it. Edge handles and snapshots resize freely unless Shift is held.
- `resize-presence`: a second person's resize shows its new size in the first view before it commits, and an earlier gesture's commit landing mid-gesture does not clear the newer preview.
- `resize-group`: with several frames selected, the box around them scales every frame in one revision and one undo entry, and Escape restores them all.
- `reorder`: `]` and `[` restack the selection, a reorder that changes nothing submits nothing, and undo restores the order. The agent's `reorder_items` does the same and refuses a no-op. A live page is not reloaded by a reorder (it logs once, on boot).
- `reorder-step`: Mod+] and Mod+[ move the selection one place past the next frame, and `reorder_items to=forward` moves a run of frames together.
- `batch-atomic`: an `arrange_items` whose move is valid but whose resize names a missing item, or whose size is out of range, commits nothing. So does a `reorder_items` naming a missing item.
- `source-link`: deleting a reference image clears it from every snapshot's `sourceReferenceIds`, and undo brings back both the image and the link.

## How to get to it (user POV)

- Select one frame with the Move tool, then drag a handle on its corners or edges. Shift-click more frames to resize them together.
- With frames selected, press `]` or `[`, or Mod+] or Mod+[.

## Driving it with screens-cli

```screens id=resize-commit
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
zoom 100
click @A.title
mark
fault delay-commit 600
drag @A.se by 100,50 --no-settle
expect pending.size=1 pending.0.type=resizeItems dom.@A.sync=pending doc.rev=+0
wait pending.size=0
expect doc.rev=+1 doc.@A.width=500 doc.@A.height=350 doc.@A.x=0 events.revisions=+1 storage.rev=doc.rev
drag @A.nw by -20,-30
expect doc.@A.x=-20 doc.@A.y=-30 doc.@A.width=520 doc.@A.height=380 events.revisions=+2
undo
expect doc.@A.x=0 doc.@A.y=0 doc.@A.width=500 doc.@A.height=350
press @A.e
move by 80,0
expect view.gesture=item-resize
key Escape
expect view.gesture=null doc.@A.width=500
```

```screens id=resize-snap
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
add_object title=B files=fixture:plain x=600 y=0 width=400 height=300 as=@B
zoom 100
click @A.title
press @A.e
move by 194,0
expect dom.guides has x@600 dom.guides.size=1
release
expect doc.@A.width=600 dom.guides.size=0
drag @A.e by 4,0 --mod
expect doc.@A.width=604
click @B.title
drag @B.w by 1000,0
expect doc.@B.width=24 doc.@B.x=976
```

```screens id=resize-group
add_object title=A files=fixture:plain x=0 y=0 width=200 height=100 as=@A
add_object title=B files=fixture:plain x=300 y=0 width=100 height=100 as=@B
zoom 100
click @A.title
click @B.title --shift
expect view.selection=[@A,@B] dom.box=[0,0,400,100]
mark
drag @A.se by 200,100
expect events.revisions=+1 doc.@A.width=300 doc.@A.height=200 doc.@B.x=450 doc.@B.width=150 doc.@B.height=200 dom.box=[0,0,600,200]
drag @B.nw by 100,0
expect events.revisions=+2 doc.@A.x=100 doc.@A.width=250 doc.@B.x=475 doc.@B.width=125
undo
expect doc.@A.x=0 doc.@A.width=300 doc.@B.x=450 doc.@B.width=150
press @A.e
move by 80,0
expect view.gesture=item-resize dom.@A.width=340 dom.@B.width=170
key Escape
expect view.gesture=null doc.@A.width=300 dom.@A.width=300 dom.@B.width=150
```

```screens id=resize-aspect
add_image title=Ref mediaType=image/png width=200 height=100 base64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== as=@I
zoom 100
click @I.title
drag @I.se by 100,10
expect doc.@I.width=300 doc.@I.height=150
drag @I.e by 50,0
expect doc.@I.width=350 doc.@I.height=150
drag @I.se by 50,0 --shift
expect doc.@I.width=400 doc.@I.height=150
drag @I.se by 0,50
expect doc.@I.width=533 doc.@I.height=200
add_object title=Snapshot files=fixture:plain x=0 y=300 width=400 height=300 as=@A
fit
zoom 100
click @A.title
drag @A.se by 100,0 --shift
expect doc.@A.width=500 doc.@A.height=375
```

```screens id=resize-presence
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
view open v2 --context
zoom 100 --view v2
click @A.title --view v2
press @A.se --view v2
move by 60,40 --view v2
wait presence.size=1 dom.@A.width=460
release --view v2
wait presence.size=0 doc.@A.width=460 doc.@A.height=340
fault delay-commit 1200
drag @A.e by 40,0 --view v2 --no-settle
press @A.nw --view v2
move by 0,-30 --view v2
wait doc.@A.width=500
expect presence.size=1 dom.@A.height=370 dom.@A.width=500
release --view v2
wait presence.size=0 doc.@A.height=370 doc.@A.y=-30
view close v2
```

```screens id=reorder
add_object title=A x=0 y=0 width=400 height=300 files='[{"path":"index.html","content":"<p>Boot</p><script>console.warn(\"boot\")</script>"}]' as=@A
add_object title=B files=fixture:plain x=200 y=100 width=400 height=300 as=@B
zoom 100
wait frames.@A.load=ready
expect doc.@A.z<doc.@B.z console.warnings=1
click @A.title
key ]
expect doc.@A.z>doc.@B.z pending.size=0
mark
key ]
expect pending.size=0 events.revisions=+0
expect console.warnings=1
key [
expect doc.@A.z<doc.@B.z
undo
expect doc.@A.z>doc.@B.z
reorder_items itemIds=[@B] to=front
expect doc.@B.z>doc.@A.z console.warnings=1
! reorder_items itemIds=[@B] to=front
```

```screens id=reorder-step
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
add_object title=B files=fixture:plain x=100 y=50 width=400 height=300 as=@B
add_object title=C files=fixture:plain x=200 y=100 width=400 height=300 as=@C
zoom 100
expect doc.@A.z<doc.@B.z doc.@B.z<doc.@C.z
click @A.title
key Mod+]
expect doc.@B.z<doc.@A.z doc.@A.z<doc.@C.z pending.size=0
key Mod+[
expect doc.@A.z<doc.@B.z doc.@B.z<doc.@C.z
mark
key Mod+[
expect pending.size=0 events.revisions=+0
reorder_items itemIds=[@A,@B] to=forward
expect doc.@C.z<doc.@A.z doc.@A.z<doc.@B.z
! reorder_items itemIds=[@A,@B] to=forward
reorder_items itemIds=[@B] to=backward
expect doc.@C.z<doc.@B.z doc.@B.z<doc.@A.z
```

```screens id=batch-atomic
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
add_object title=B files=fixture:plain x=600 y=0 width=400 height=300 as=@B
mark
! arrange_items items='[{"itemId":"@A","x":50,"y":50},{"itemId":"nosuchitem","width":100,"height":100}]'
expect doc.rev=+0 events.revisions=+0 doc.@A.x=0 doc.@A.y=0 storage.rev=doc.rev
! arrange_items items='[{"itemId":"@A","x":50,"y":50},{"itemId":"@B","width":0,"height":100}]'
expect doc.rev=+0 doc.@A.x=0 doc.@B.width=400
! reorder_items itemIds='["@A","nosuchitem"]' to=front
expect doc.rev=+0 doc.@A.z<doc.@B.z
```

```screens id=source-link
add_image title=Ref mediaType=image/png width=200 height=100 x=0 y=400 base64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== as=@I
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 sourceReferenceIds=[@I] as=@A
click @I.title
delete
expect doc.items.size=1 doc.@A.sources=[]
undo
expect doc.items.size=2 doc.@A.sources=[@I]
```

## Gotchas

- Handles show on a sole selection under Move, or on the box around several, and not while a frame is focused. `@A.se` targets the box's handle when `@A` is one of several selected.
- Front and back are plain `]` and `[`; Mod+] and Mod+[ step, and the canvas keeps them from reaching the browser's history shortcuts. Mod+Shift+] is the browser's next-tab shortcut.
- A group resize keeps the aspect at corners when it includes a reference image, and stops shrinking when its smallest frame reaches 24 units.
