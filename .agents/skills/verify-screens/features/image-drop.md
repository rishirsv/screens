# Image drop and paste

The person drops image files on the canvas, or pastes an image with Cmd+V, and each becomes a reference image on the Screen. On a canvas, a drop lands centred on the drop point, and a paste in the middle of the view. Images keep their natural size, with the longest side capped at 1600; several images go in one row. Paged Screens keep the original size and insert images in page order. Either route commits the batch in one undo step. The item shows as pending, previewed from local bytes, until the service commits it, and the bytes go through the same resumable upload as the agent's (see [Files](./files.md)).

## Sub-features

- `drop-image`: one file lands centred on the drop point at its natural size, selected; undo removes it, redo restores it.
- `drop-batch`: several files make one revision and one undo step, in a row 40 apart.
- `drop-large`: a large image is placed with its longest side at 1600.
- `drop-pending`: with commits delayed, the item shows pending and never as saved until the revision arrives.
- `drop-resume`: a socket dropped mid-upload resumes and the drop commits.
- `drop-on-frame`: a drop over a live snapshot lands on the canvas, not in the page.
- `drop-ignored`: a file that is not an image adds nothing.
- `paste-image`: Cmd+V with an image on the clipboard adds it in the middle of the view, titled "Pasted image"; a paste while typing in a text field adds nothing.
- `drop-live`: the agent sees the dropped image.
- `copy-image`: Copy as image in the toolbar (or Shift+Cmd+C) puts the selected design on the clipboard as a 2x PNG; pasting it back adds an image twice the design's size.
- `copy-tall`: a design taller than the poster's 4096 limit copies whole, not cropped.

## How to get to it (user POV)

- Drag image files from the desktop or a file browser onto the canvas.
- Copy an image, click the canvas, and press Cmd+V (Ctrl+V on other systems).

## Driving it with screens-cli

```screens id=drop-image
mark
drop fixture:png at bg:400,300 as=@P
expect doc.rev=+1 doc.@P.kind=img doc.@P.title=landing doc.@P.width=640 doc.@P.height=480 doc.@P.x=80 doc.@P.y=60 view.selection.0=@P pending.size=0
undo
expect doc.items.size=0
redo
expect doc.items.size=1 doc.@P.x=80
```

```screens id=drop-batch
mark
drop fixture:png fixture:png-small at bg:600,300 as=@P
expect doc.rev=+1 doc.items.size=2 doc.@P.width=640 view.selection.size=2
undo
expect doc.rev=+2 doc.items.size=0
```

```screens id=drop-large
drop fixture:png-large at bg:400,300 as=@L
expect doc.@L.width=1600 doc.@L.height=1200
```

```screens id=drop-pending
fault delay-commit 1500
mark
drop fixture:png-small at bg:300,300 --no-settle
wait pending.size=1 timeout=1s
expect doc.rev=+0 dom.unsavedItems=1
wait pending.size=0 doc.rev=+1 timeout=5s
```

```screens id=drop-resume
fault drop-upload after=2
mark
drop fixture:noise-g at bg:400,300
wait pending.size=0 doc.rev=+1 timeout=10s
expect doc.items.size=1 service.uploads.offered=+3241953 service.uploads.entries.size=0 storage.staging=0
```

```screens id=drop-on-frame
add_object title=Page files=fixture:plain x=0 y=0 height=300 as=@A
click @A --double
expect view.interacting=@A
mark
drop fixture:png-small at @A+150,150 as=@P
expect doc.rev=+1 doc.items.size=2 doc.@P.kind=img
```

```screens id=drop-ignored
mark
drop fixture:text at bg:300,300
expect doc.rev=+0 pending.size=0
```

```screens id=paste-image
mark
paste fixture:png-small
expect doc.rev=+1 doc.items.size=1 pending.size=0
get doc
add_comment x=100 y=600 text=Anchor as=@T
click @T
click ui:Reply
paste fixture:png-small
expect doc.items.size=1
```

```screens id=drop-live
drop fixture:png at bg:400,300 as=@P
get_screen
expect last.items.0.id=@P last.items.0.kind=reference-image
```

```screens id=copy-image
add_object title=Card files=fixture:plain width=400 height=250 as=@A
click @A.title
mark
click "ui:Copy as image (⇧⌘C)"
wait dom.copy=copied timeout=10s
key Escape
key Mod+v
wait doc.rev=+1 timeout=10s
expect doc.items.size=2 pending.size=0
key Mod+z
click @A.title
key Shift+Mod+c
wait dom.copy=copied timeout=10s
key Escape
key Mod+v
wait doc.rev=+3 timeout=10s
expect doc.items.size=2
```

```screens id=copy-tall
add_object title=Tall files=fixture:plain width=1200 height=6000 as=@A
click @A.title
mark
key Shift+Mod+c
wait dom.copy=copied timeout=10s
key Escape
key Mod+v as=@P
expect doc.@P.width=320 doc.@P.height=1600
```

## Gotchas

- A drop commits after its upload, so a large one may settle before its revision: `wait` for it, and bind nothing with `as=` on that step.
- `drop` is a real CDP drag that carries files from disk, so the browser builds the `DataTransfer` and fires `dragenter`, `dragover` and `drop`. `paste` writes the image to the page clipboard, then presses Mod+v.
- A drop at `bg:X,Y` maps through the camera; a fresh Screen's camera is at 100%, so world and stage pixels agree.
- While files are dragged over the window, live frames stop taking pointer events, so a drop over a snapshot reaches the canvas.
- Untested in the Claude desktop Browser pane: whether it delivers file drops and pasted images to the page.
