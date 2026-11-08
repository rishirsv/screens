# Camera and focus

A person pans with Hand, Space-drag, the middle button or the wheel. They zoom with Cmd plus the wheel, the zoom buttons or the keyboard, and fit everything into view. Focus hides the other frames and returns to the previous view. Tall canvas objects start at the top, fitted to width up to 100%, so a large board stays readable and scrolls within its bounds. An agent can ask an open canvas to show or focus items. The canvas defers that while the person is busy. Camera moves never create a revision.

## Sub-features

- `cam-pan`: Hand, Space-drag and the wheel pan by the screen delta, with no revision.
- `cam-zoom`: zoom out and in around the centre; Cmd+0 goes to 100%; Fit all frames everything and turns auto-fit back on.
- `focus`: the Focus action, or the agent's `focus_item`, fits one frame and hides the others. Exit focus or Escape returns.
- `focus-wheel`: in focus with Move, the wheel over the live page pans the camera, as Hand does. A scroll area inside the page keeps the wheel while it can still scroll.
- `focus-large`: a 40-screen board opens at a readable zoom at the top, scrolls to both ends without leaving focus, hides other objects and restores the previous camera on exit.
- `wheel-root-overflow`: overflowing body content under a hidden or clipped viewport never traps the wheel, in focus or with only selection.
- `wheel-native-boundary`: a real page scrolls to either end, then hands the wheel back to the focused canvas without Escape or refresh.
- `wheel-nested-boundary`: nested scroll areas and a body with its own scrollbar keep native scrolling until their edge, then hand off to the canvas.
- `wheel-horizontal`: horizontal page scrolling hands off at its right edge, and Cmd+wheel still zooms over the page.
- `view-defer`: `focus_item` during a gesture returns `deferred`, then applies when the gesture ends.
- `view-command-clock`: agent focus, return and show animations finish on the same clock as animation frames.
- `view-defer-expiry`: a command deferred beyond its 30-second lifetime does not take over when the gesture ends.
- `focus-cancels-drag`: the person's focus shortcut cancels a held drag and clears the preview in other views.
- `view-context`: `get_view` reports the selection and the visible world rect.

## How to get to it (user POV)

- Press H or hold Space and drag. Use the zoom buttons, Cmd+wheel, the Focus action on a selected frame, and Escape.
- An agent calls `show_items`, `focus_item`, `get_view` and `open_screen`.

## Driving it with screens-cli

```screens id=cam-pan
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
mark
tool hand
drag bg by -100,-50
expect view.camera.x=+-100 view.camera.y=+-50 view.autoFit=false doc.rev=+0
tool move
drag bg by 40,0 --space
expect view.camera.x=+-60
wheel 0,100
expect view.camera.y=+-150
```

```screens id=cam-zoom
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
zoom 100
expect view.camera.z=1
zoom in
expect view.camera.z=1.25
zoom out
expect view.camera.z=1
wheel 0,-100 --cmd
expect view.camera.z>1 view.autoFit=false
fit
expect view.autoFit=true
```

```screens id=focus
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
add_object title=B files=fixture:plain x=500 y=0 height=300 as=@B
focus @A
expect view.focus=focused:@A dom.@B.visible=false
exit-focus
wait view.focus=none
focus_item itemId=@B
expect last.result=applied view.focus=focused:@B
key Escape
wait view.focus=none
show_items itemIds=[@A]
expect last.result=applied
```

```screens id=view-defer
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
fit
press bg:10,780
move by 40,-40
focus_item itemId=@A
expect last.result=deferred view.deferredCommand=focus
release
wait view.focus=focused:@A
```

```screens id=view-context
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
click @A
settle
get_view
expect last.open=true last.view.selection=[@A] context.view.busy=false
open_screen
expect last.url~=/s/
```

Run `view-command-clock` with `screens-cli run --fresh --motion .agents/skills/verify-screens/features/camera-focus.md --id view-command-clock` to exercise animation frames without reduced motion.

```screens id=view-command-clock
add_object title=A files=fixture:pieces x=0 y=0 height=300 as=@A
add_object title=B files=fixture:pieces x=500 y=0 height=300 as=@B
mark
focus_item itemId=@B
expect last.result=applied
wait view.animation=null timeout=2s
expect view.focus=focused:@B
focus_item
expect last.result=applied
wait view.focus=none view.animation=null timeout=2s
show_items itemIds=[@A]
expect last.result=applied
wait view.animation=null timeout=2s
expect view.selection=[@A] doc.rev=+0 storage.rev=doc.rev
```

```screens id=view-defer-expiry
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
press bg:10,780
focus_item itemId=@A
expect last.result=deferred view.deferredCommand=focus
mark
wait service.uptimeMs>+31000 timeout=33s
release
expect view.deferredCommand=null view.focus=none view.animation=null doc.rev=+0 storage.rev=doc.rev
```

```screens id=focus-cancels-drag
add_object title=A files=fixture:pieces x=0 y=0 height=300 as=@A
view open v2 --context
mark
press @A.title --view v2
move by 40,0 --view v2
wait presence.size=1 timeout=2s
key f --view v2
release --view v2
wait presence.size=0 timeout=2s
expect doc.@A.x=0 doc.rev=+0 storage.rev=doc.rev
view close v2
expect presence.size=0 pending.size=0
```


```screens id=focus-wheel
add_object title=Tall 'files=[{"path":"index.html","content":"<body style=margin:0;padding-top:1400px><div style=height:300px;width:400px;overflow:auto><div style=height:2000px>inner</div></div></body>"}]' x=0 y=0 width=600 height=3000 as=@A
focus @A
tool hand
wheel 0,1148 at @A+100,200
tool move
mark
expect view.focus=focused:@A view.camera.y=-1100
wheel 0,300 at @A+100,1500
wait view.moving=false
expect view.camera.y=-1100
wheel 0,300 at @A+500,1300
wait view.moving=false
expect view.camera.y=-1400
tool hand
wheel 0,-300 at @A+500,1700
wait view.moving=false
expect view.camera.y=-1100 doc.rev=+0
```

```screens id=focus-large
add_object title=Other files=fixture:pieces x=1000 y=0 height=300 as=@B
add_object title="40 screens" files=fixture:wheel-board x=0 y=0 width=640 height=3368 as=@A
mark overview view
focus @A
mark
expect view.camera.z=1 view.camera.y=48 view.focus=focused:@A dom.@B.visible=false
wheel 0,10000 at @A+100,200
wait view.moving=false
expect view.camera.y=-2616 view.focus=focused:@A
wheel 0,-10000 at @A
wait view.moving=false
expect view.camera.y=48 view.focus=focused:@A
wheel 10000,0 at @A+100,200
wait view.moving=false
expect view.camera.x=320 doc.rev=+0 storage.rev=doc.rev
exit-focus
expect view.focus=none view.camera=mark:overview dom.@B.visible=true
```

```screens id=wheel-root-overflow
add_object title="Hidden root" files=fixture:wheel-hidden-root x=0 y=0 width=600 height=3000 as=@A
focus @A
mark
wheel 0,300 at @A+100,200
wait view.moving=false
expect view.camera.y=+-300 view.focus=focused:@A doc.rev=+0 storage.rev=doc.rev
exit-focus
zoom 100
key Escape
click @A
wait frames.@A.input=page
mark
wheel 0,100 at @A
wait view.moving=false
expect view.camera.y=+-100 view.focus=none view.selection=[@A]
add_object title="Hidden body" files=fixture:wheel-hidden-body x=800 y=0 width=600 height=3000 as=@B
focus_item itemId=@B
wait frames.@B.input=page
mark
wheel 0,300 at @B+100,200
wait view.moving=false
expect view.camera.y=+-300 view.focus=focused:@B doc.rev=+0 storage.rev=doc.rev
add_object title="Clipped root" files=fixture:wheel-clipped-root x=1600 y=0 width=600 height=3000 as=@C
focus_item itemId=@C
wait frames.@C.input=page
mark
wheel 0,300 at @C+100,200
wait view.moving=false
expect view.camera.y=+-300 view.focus=focused:@C doc.rev=+0 storage.rev=doc.rev
```

```screens id=wheel-native-boundary
add_object title="Native scroll" files=fixture:wheel-native x=0 y=0 width=600 height=3000 as=@A
focus @A
mark
wheel 0,1000 at @A+100,200
wait service.uptimeMs>+300 timeout=1s
inside @A text '#scroll-state'
expect last="root=600,left=0,body=0,inner=0" view.camera.y=+0
wheel 0,300 at @A+100,200
wait view.moving=false
expect view.camera.y=+-300 view.focus=focused:@A
mark
wheel 0,-1000 at @A+100,500
wait service.uptimeMs>+300 timeout=1s
inside @A text '#scroll-state'
expect last="root=0,left=0,body=0,inner=0" view.camera.y=+0
wheel 0,-300 at @A+100,500
wait view.moving=false
expect view.camera.y=48 view.focus=focused:@A doc.rev=+0 storage.rev=doc.rev
```

```screens id=wheel-nested-boundary
add_object title="Nested scroll" files=fixture:wheel-nested x=0 y=0 width=600 height=3000 as=@A
focus @A
mark
wheel 0,1000 at @A+100,200
wait service.uptimeMs>+300 timeout=1s
inside @A text '#scroll-state'
expect last="root=0,left=0,body=0,inner=600" view.camera.y=+0
wheel 0,200 at @A+100,200
wait view.moving=false
expect view.camera.y=+-200 view.focus=focused:@A doc.rev=+0 storage.rev=doc.rev
add_object title="Body scroll" files=fixture:wheel-body x=800 y=0 width=600 height=3000 as=@B
focus_item itemId=@B
wait frames.@B.input=page
mark
wheel 0,1000 at @B+100,200
wait service.uptimeMs>+300 timeout=1s
inside @B text '#scroll-state'
expect last="root=0,left=0,body=600,inner=0" view.camera.y=+0
wheel 0,200 at @B+100,200
wait view.moving=false
expect view.camera.y=+-200 view.focus=focused:@B doc.rev=+0 storage.rev=doc.rev
```

```screens id=wheel-horizontal
add_object title="Horizontal scroll" files=fixture:wheel-horizontal x=0 y=0 width=2000 height=600 as=@A
focus @A
zoom 100
mark
wheel 1000,0 at @A+1000,100
wait service.uptimeMs>+300 timeout=1s
inside @A text '#scroll-state'
expect last="root=0,left=600,body=0,inner=0" view.camera.x=+0
wheel 200,0 at @A+1000,100
wait view.moving=false
expect view.camera.x=+-200 view.focus=focused:@A
mark
wheel 0,-10 at @A+1000,100 --cmd
wait view.moving=false
expect view.camera.z>+0 view.focus=focused:@A doc.rev=+0 storage.rev=doc.rev
```

## Gotchas

- Focus and return animate for 360 ms. Sessions use reduced motion unless started with `up --motion`, so they finish at once.
- With no canvas open, `focus_item` returns `no-view` and `get_view` returns `open: false`.
