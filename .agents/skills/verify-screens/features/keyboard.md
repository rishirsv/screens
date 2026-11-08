# Keyboard

Every canvas action works from the keyboard. On a canvas, arrow keys move the selection or pan the view and Cmd+arrows resize. On paged Screens, arrows step between pages and modifier resize does nothing. Tab walks the items, Enter renames, F focuses. Cmd or Ctrl plus scrolling up zooms in. A trackpad pinch outward zooms in too. Command shortcuts also accept Control.

## Sub-features

- `kbd-select`: Tab and Shift+Tab select the next and previous item in reading order and bring it into view. Cmd+A selects all.
- `kbd-nudge`: arrows move the selection 1 unit, 10 with Shift. Each press is one revision and one undo step.
- `kbd-resize`: Cmd+arrows grow or shrink the right and bottom edges 1 unit, 10 with Shift, and a group scales together.
- `kbd-camera`: with nothing selected the arrows pan. Shift+1 fits all, Shift+2 frames the selection, and Cmd+= and Cmd+- zoom.
- `kbd-focus`: Enter renames the selected item. F focuses it, Tab moves focus to the next item, and F or Escape leaves.
- `kbd-toolbar`: clicking a toolbar button leaves keyboard focus on the canvas, so the arrows still pan.
- `wheel-zoom`: Cmd plus scrolling up (deltaY < 0) zooms in and scrolling down zooms out, a pinch outward (Ctrl, deltaY < 0) zooms in, and Invert scroll flips both.
- `lib-kbd-open`: in the library, Cmd+Down opens the focused Screen.

## How to get to it (user POV)

- Select a frame and press the arrow keys, Cmd+arrows, Enter, F or Tab. Press Shift+1 or Shift+2.
- Hold Cmd and scroll, or pinch on a trackpad.

## Driving it with screens-cli

```screens id=kbd-select
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
add_object title=B files=fixture:plain x=500 y=0 height=300 as=@B
add_object title=C files=fixture:plain x=0 y=2000 height=300 as=@C
zoom 100
key Tab
expect view.selection=[@A]
key Tab
expect view.selection=[@B]
key Tab
expect view.selection=[@C] view.autoFit=false
key Shift+Tab
expect view.selection=[@B]
key Mod+a
expect view.selection.size=3
```

```screens id=kbd-nudge
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
click @A
mark
key ArrowRight ArrowRight
wait pending.size=0
expect doc.@A.x=2 doc.rev=+2
key Shift+ArrowDown
wait pending.size=0
expect doc.@A.y=10
undo
wait pending.size=0
expect doc.@A.y=0 doc.@A.x=2
```

```screens id=kbd-resize
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
add_object title=B files=fixture:plain x=600 y=0 width=200 height=300 as=@B
click @A
key Mod+ArrowRight Shift+Mod+ArrowDown
wait pending.size=0
expect doc.@A.width=401 doc.@A.height=310 doc.@A.x=0
key Mod+a
mark
key Shift+Mod+ArrowLeft
wait pending.size=0
expect doc.@A.width<401 doc.@B.width<200 doc.rev=+1
```

```screens id=kbd-camera
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
add_object title=B files=fixture:plain x=3000 y=0 height=300 as=@B
zoom 100
mark
key ArrowRight
expect view.camera.x=+-40 doc.rev=+0
key Shift+ArrowDown
expect view.camera.y=+-200
key Shift+1
expect view.autoFit=true
click @B
key Shift+2
expect view.camera.z>0.5 view.autoFit=false
key Mod+= Mod+-
expect doc.rev=+0
```

```screens id=kbd-focus
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
add_object title=B files=fixture:plain x=500 y=0 height=300 as=@B
click @A
key Enter
type Renamed
key Enter
expect doc.@A.title=Renamed
key f
expect view.focus=focused:@A
key Tab
expect view.focus=focused:@B
key f
wait view.focus=none
key Shift+Tab
key f
expect view.focus=focused:@A
key Escape
wait view.focus=none
```

```screens id=kbd-toolbar
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
key Escape
click ui:"Zoom in"
mark
key ArrowLeft
expect view.camera.x=+40
```

```screens id=wheel-zoom
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
zoom 100
wheel 0,-100 --cmd
expect view.camera.z>1
zoom 100
wheel 0,100 --cmd
expect view.camera.z<1
zoom 100
wheel 0,-100 --pinch
expect view.camera.z>1
zoom 100
wheel 0,100 --pinch
expect view.camera.z<1
invert-scroll on
zoom 100
wheel 0,-100 --cmd
expect view.camera.z<1
invert-scroll off
```

```screens id=lib-kbd-open
click ui:Library
click ui:keyboard/lib-kbd-open
key Mod+ArrowDown
wait dom.title=keyboard/lib-kbd-open
```

## Gotchas

- Tab past the last item, or Shift+Tab before the first, moves keyboard focus on to the toolbar instead of wrapping, so focus is never trapped on the canvas.
- A focused toolbar button, link or comment pin keeps Space, Enter, Tab and the arrows. Mouse clicks on toolbar buttons never take keyboard focus.
- Each arrow press commits on its own, so a held arrow sends one move per key repeat.
- `--pinch` holds Ctrl, which is how Chrome reports a trackpad pinch. `--cmd` holds Meta.
