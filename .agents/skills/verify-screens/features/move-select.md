# Move and select

With the Move tool a person selects frames, drags one or several, snaps them to other frames, deletes them and renames them. A move shows as pending until the service commits it, and commits once, on release.

## Sub-features

- `sel-click`: a click selects, giving a ring and the Focus action; the page takes the pointer. A click on the background clears it.
- `sel-marquee`: a background drag selects every frame it intersects. Escape mid-drag cancels it.
- `drag-commit`: a drag shows pending until the commit, then commits one `moveItems` at the start plus the screen delta divided by zoom.
- `drag-snap`: an edge within 8 screen px of another frame snaps exactly. Holding Cmd or Ctrl turns snapping off.
- `delete`: Backspace removes the selection and the strokes drawn on it.
- `rename`: double-clicking a title or clicking the Screen name edits it; Enter commits. The agent's `retitle_item` and `rename_screen` do the same.

## How to get to it (user POV)

- Press V, or choose Move. Then click, drag a title, drag on the background, press Backspace, or double-click a title.

## Driving it with screens-cli

```screens id=sel-click
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
click @A
expect view.selection=[@A] dom.@A.selected=true frames.@A.input=page context.view.selection has @A
click bg
expect view.selection=[]
```

```screens id=sel-marquee
add_object title=L files=fixture:plain x=0 y=0 height=300 as=@L
add_object title=R files=fixture:plain x=500 y=0 height=300 as=@R
fit
drag bg:10,780 to bg:1270,70
expect view.selection has @L view.selection has @R
key Escape
press bg:10,780
move to bg:1270,70
expect view.gesture=marquee
cancel
expect view.gesture=null view.selection=[]
```

```screens id=drag-commit
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
zoom 100
mark
fault delay-commit 600
drag @A.title by 100,-50 --no-settle
expect pending.size=1 pending.0.type=moveItems dom.@A.sync=pending doc.rev=+0
wait pending.size=0
expect doc.rev=+1 doc.@A.x=100 doc.@A.y=-50 storage.rev=doc.rev events.revisions=+1
diff
```

```screens id=drag-snap
add_object title=L files=fixture:plain x=0 y=0 height=300 as=@L
add_object title=R files=fixture:plain x=600 y=40 height=300 as=@R
zoom 100
drag @R.title by 0,-36
expect doc.@R.y=0
drag @R.title by 0,30 --mod
expect doc.@R.y=30
```

```screens id=delete
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
tool pencil
draw @A+60,150 by 80,20 as=@k
tool move
click @A
delete
expect doc.items.size=0 doc.strokes.size=0 dom.empty=true
add_object title=B files=fixture:plain height=300 as=@B
remove_items itemIds=[@B]
expect doc.items.size=0
```

```screens id=rename
add_object title=Old files=fixture:plain height=300 as=@A
edit-title @A New
expect doc.@A.title=New dom.@A.title=New
rename-screen "Checkout flow"
expect doc.title="Checkout flow" dom.title="Checkout flow"
click ui:"Checkout flow"
key Mod+a
type Flow
key Enter
expect doc.title=Flow
retitle_item itemId=@A title=Agent
rename_screen title=Agents
expect doc.@A.title=Agent doc.title=Agents
```

## Gotchas

- Clicking a selected frame gives its page the pointer. Drag by the title.
- Cmd+A inside a text field selects text, not frames. That is intended.
- At 100% zoom a 844-tall phone frame does not fit an 800 px viewport, so its title is off screen. The CLI fails such a step instead of scrolling.
