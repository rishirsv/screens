# Pencil

With Pencil a person draws freehand marks in one of six colors and four thicknesses. A mark that starts on a frame is anchored to it: it moves with the frame, is clipped to it, and is removed with it. A tap without movement draws nothing and switches back to Move.

## Sub-features

- `pen-draw`: a drag of 4 px or more commits one `addStroke` on release, in the chosen color and thickness.
- `pen-anchor`: a stroke that starts on a frame is anchored to it; elsewhere its anchor is `world`. A pen with pressure draws too.
- `pen-follow`: moving the frame moves the stroke with it.
- `pen-tap`: a press under 4 px commits nothing and switches to Move.
- `pen-delete`: in Move, clicking a stroke selects it, and Backspace removes it.

## How to get to it (user POV)

- Press P or choose Pencil, then draw. Switch back to Move to select a stroke.

## Driving it with screens-cli

```screens id=pen-draw
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
tool pencil
pencil color red
pencil size 12
expect view.pencil.color=#e5484d view.pencil.size=12
draw @A+60,150 by 120,40 60,-20 as=@k
expect doc.strokes.size=1 doc.@k.anchor=@A doc.@k.color=#e5484d doc.@k.author=person
```

```screens id=pen-anchor
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
fit
tool pencil
draw bg:20,700 by 60,30 --pen pressure=0.7 as=@w
expect doc.@w.anchor=world
```

```screens id=pen-follow
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
tool pencil
draw @A+60,150 by 80,20 as=@k
tool move
drag @A.title by 120,0
click @k
expect view.selection=stroke:@k doc.@k.anchor=@A
```

```screens id=pen-tap
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
tool pencil
mark
click bg
expect doc.rev=+0 view.tool=move
```

```screens id=pen-delete
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
tool pencil
draw @A+60,150 by 80,20 as=@k
tool move
click @k
key Backspace
expect doc.strokes.size=0 doc.items.size=1
```

## Gotchas

- If a page has keyboard focus, the first key goes to the page. A click on the canvas takes focus back.
- The palette shows only while Pencil is active, so `pencil color` comes after `tool pencil`.
- World strokes are canvas-only. Presentations and Documents accept strokes on a page in Scroll view; Grid and Present disable drawing.
- Pen pressure goes through CDP input (`--pen pressure=P`). It proves the pointer path, not a physical stylus.
