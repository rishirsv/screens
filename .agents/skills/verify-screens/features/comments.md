# Comments

A comment thread is a pin with a conversation, pinned to a snapshot or to the canvas. A pin on a snapshot stores its point as fractions of the snapshot, so it follows moves and proportional resizes and survives a content update. People and agents create, reply to, resolve, reopen, move and delete threads through the same service operations. Removing a snapshot removes its threads in the same commit, and undo brings them back.

## Sub-features

- `comment-world`: in Comment mode a click on empty canvas opens a draft. Enter sends, Shift+Enter adds a newline, Escape cancels and saves nothing, and blank text sends nothing. Pressing C again returns to Move.
- `comment-area`: in Comment mode a drag of 4 px or more circles a region and pins the thread at its top-left, clipped to the snapshot under its centre. A straight-line drag places a plain pin. The area follows the snapshot, rides along when the pin moves and keeps its world size on another anchor, and `list_comments` reports it in item pixels.
- `comment-area-pending`: a circled thread keeps its circle, at its world size, while a new thread or a pin move saves and after a save fails, and Retry saves it with the area.
- `comment-item`: a click on a snapshot pins the thread to it, at the point as fractions of its width and height.
- `comment-anchor`: the pin follows the snapshot through a move, a proportional resize and a content update, on the canvas and in `list_comments`.
- `comment-pin-drag`: dragging a pin 4 px or more moves it onto the canvas or onto a snapshot. A shorter press opens or closes it. Escape during a drag puts it back.
- `comment-thread`: reply, resolve (hides the pin and closes the card), the Resolved filter, reopen from the panel, delete a reply, and delete the thread through its first comment.
- `comment-cascade`: removing a snapshot removes its threads, and undo restores them with every reply.
- `comment-undo`: undo of a pin move still applies after the agent replied; undo of a thread someone has replied to is refused.
- `comment-live`: agent comments, replies and resolves appear on an open canvas without a reload, and canvas comments are readable through MCP. `get_view` lists open threads in view and the thread the person has open.
- `comment-failed`: a reply whose save fails stays visible as failed with a toast, and Retry saves it.
- `comment-replay`: the same `opId` returns the original result and changes nothing.
- `comment-replay-changed`: the same `opId` with a different point or text is refused, for a new thread and a move.
- `comment-invalid`: blank text, a point outside the snapshot and a missing thread are refused by the service.
- `comment-restart`: threads, replies and anchors survive a service restart.

- `comment-panel-drafts`: the panel starts closed, toggles without cancelling a draft, and unfinished new comments, replies and edits survive switching surfaces and threads.
- `comment-edit`: a person edits with Save/Cancel, and guarded MCP edits preserve author/time, reject stale text, replay safely and undo without removing concurrent replies.
- `comment-edit-failed`: failed edits remain visible with Retry, and a new comment is never presented as saved before commit.
- `comment-popover`: anchored chrome stays readable through camera changes and near viewport edges, and scrolling a thread does not move the canvas.

- `comment-compact`: a thread uses one readable surface on a compact canvas, preserving unfinished replies across panel toggles and reopening.

- `comment-scroll`: a long conversation scrolls internally without moving the camera, hides when its pin leaves view and can be located from the panel.
- `comment-edit-conflict`: a concurrent edit is refused when the person saves stale text, keeping their proposed change recoverable.

- `comment-keyboard`: closing an anchored thread returns focus to its pin, where Enter reopens it without a pointer.

## How to get to it (user POV)

- Press C or choose Comment, then click the canvas or a snapshot. The composer opens beside the pin; Enter sends, Shift+Enter adds a line and Escape cancels. Drag instead of clicking to circle an area. Saved annotations show numbered pins and compact text bubbles. Click one to open the conversation in place, with replies, editing, Resolve/Reopen and deletion.
- Comments opens the optional index on the right, initially hidden in every view. Selecting a row opens the anchored conversation. Its Resolved checkbox shows resolved threads. In Present the index follows the current slide and expands read-only conversations; pins stay hidden.

## Driving it with screens-cli

```screens id=comment-world
tool comment
expect view.tool=comment dom.panel=null
mark
click bg:150,600
expect dom.composer="New comment" view.comment.draft!=null
key Enter
type never sent
key Escape
expect doc.rev=+0 view.comment.draft=null
click bg:150,600
type First line
key Shift+Enter
type second line
key Enter as=@T
expect doc.@T.anchor=world doc.@T.author=person doc.@T.text='"First line\nsecond line"' dom.card=null dom.panel=null pending.size=0
key Escape
key c
expect view.tool=move dom.@T.pin=shown dom.card=null
```

```screens id=comment-item
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
tool comment
click @A+100,60
type Tighten the header
key Enter as=@T
expect doc.@T.anchor=@A doc.@T.x=0.25 doc.@T.y=0.2 doc.@T.at=[100,60] dom.@T.at=[100,60]
```

```screens id=comment-area
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
tool comment
drag @A+100,60 to @A+300,210
expect dom.composer="New comment" view.comment.draft!=null
type Look here
key Enter as=@T
expect doc.@T.anchor=@A doc.@T.x=0.25 doc.@T.y=0.2 doc.@T.area=[0.5,0.5] dom.card=null dom.panel=null
list_comments
expect last.threads.0.area.w=200 last.threads.0.area.h=150
arrange_items items=[{"itemId":"@A","x":0,"y":0,"width":800,"height":600}]
list_comments
expect last.threads.0.area.w=400 last.threads.0.area.h=300
tool move
drag @T by 1000,0
expect doc.@T.anchor=world doc.@T.area=[400,300]
undo
expect doc.@T.anchor=@A doc.@T.area=[0.5,0.5]
add_object title=B files=fixture:plain x=1200 y=0 width=100 height=100 as=@B
move_comment threadId=@T itemId=@B x=10 y=10
expect doc.@T.anchor=@B doc.@T.area=[4,3]
move_comment threadId=@T x=1500 y=40
expect doc.@T.anchor=world doc.@T.area=[400,300]
tool comment
drag @A+100,400 to @A+300,400
type A line circles nothing
key Enter as=@L
expect doc.@L.anchor=@A doc.@L.area=null pending.size=0
```

```screens id=comment-area-pending
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
tool comment
fault fail-commit storage
drag @A+100,60 to @A+300,210
type Circled but failing
key Enter
expect doc.threads.size=0 pending.failed=1 dom.toast="Couldn't save" dom.areas=[[200,150]]
toast retry as=@T
expect doc.@T.area=[0.5,0.5] pending.size=0 dom.@T.area=[200,150] dom.areas=[[200,150]]
tool move
fault delay-commit 800
drag @T by 600,0 --no-settle
expect pending.size=1 doc.@T.anchor=@A dom.@T.area=[200,150]
wait pending.size=0
expect doc.@T.anchor=world doc.@T.area=[200,150] dom.@T.area=[200,150]
```

```screens id=comment-anchor
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
tool comment
click @A+100,60
type On A
key Enter as=@T
arrange_items items=[{"itemId":"@A","x":200,"y":0,"width":800,"height":600}]
expect doc.@T.anchor=@A doc.@T.x=0.25 doc.@T.y=0.2 doc.@T.at=[400,120]
wait dom.@T.at=[400,120]
update_object itemId=@A expectedRevision=3 files=fixture:modules
expect doc.@T.anchor=@A doc.@T.x=0.25
list_comments
expect last.threads.0.anchor.x=0.25 last.threads.0.at.x=200 last.threads.0.at.y=120 last.threads.0.world.x=400
```

```screens id=comment-pin-drag
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
add_comment itemId=@A x=100 y=60 text=Here as=@T
tool move
drag @T by 400,0
expect doc.@T.anchor=world doc.@T.at=[500,60]
drag @T by -400,0
expect doc.@T.anchor=@A doc.@T.x=0.25 doc.@T.y=0.2
mark
press @T
move by 100,0
cancel
expect doc.rev=+0 doc.@T.anchor=@A view.gesture=null
click @T
expect doc.rev=+0 dom.card=@T view.comment.activeThreadId=@T
click @T
expect dom.card=null
tool hand
click @T
expect dom.card=@T view.tool=hand
```

```screens id=comment-thread
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
tool comment
click @A+100,60
type First
key Enter as=@T
click @T
expect dom.composer=Reply
type A reply
key Enter as=@c
expect doc.@T.comments=2 doc.@c.thread=@T doc.@c.text="A reply" dom.@c.rendered=true
click ui:Resolve
expect doc.@T.resolved=true dom.@T.pin=hidden dom.card=null dom.panel=null
click ui:Comments
click ui:Resolved
expect view.comment.showResolved=true dom.@T.pin=shown dom.panel=[@T]
click @T.row
click ui:Reopen
expect doc.@T.resolved=false dom.card=@T
click @c
expect doc.@T.comments=1
click ui:"Delete thread"
expect doc.threads.size=1
click ui:"Delete thread"
expect doc.threads.size=0 dom.card=null dom.panel=[]
```

```screens id=comment-cascade
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
tool comment
click @A+100,60
type On A
key Enter as=@T
click @T
type Second
key Enter as=@c
tool move
click @A
key Backspace
expect doc.items.size=0 doc.threads.size=0 storage.rev=doc.rev
undo
expect doc.@A.title=A doc.@T.anchor=@A doc.@T.comments=2 doc.@T.text="On A" doc.@c.thread=@T doc.@c.text=Second dom.@T.pin=shown
```

```screens id=comment-undo
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
tool comment
click @A+100,60
type Mine
key Enter as=@T
key Escape
tool move
drag @T by 400,0
expect doc.@T.anchor=world
reply_comment threadId=@T text="Agent reply" as=@r
undo
expect doc.@T.anchor=@A doc.@T.comments=2 doc.@r.text="Agent reply" dom.toast=null
undo
expect doc.@T.comments=2 dom.toast="Can't undo: it changed since"
```

```screens id=comment-live
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
add_comment itemId=@A x=40 y=40 text="From the agent" as=@T
expect doc.@T.author=agent last.id=@T last.current.thread.anchor.x=0.1 last.current.thread.at.x=40
wait dom.@T.pin=shown
click @T
type Thanks
key Enter as=@c
list_comments
expect last.threads.0.comments.1.text=Thanks last.threads.0.comments.1.author.kind=person
reply_comment threadId=@T text="On it" as=@r
wait dom.@r.rendered=true
get_view
expect last.open=true last.view.activeThread=@T last.comments.0.threadId=@T
resolve_comment threadId=@T
wait dom.@T.pin=hidden dom.card=null
resolve_comment threadId=@T resolved=false
wait dom.@T.pin=shown
move_comment threadId=@T x=700 y=40
wait dom.@T.at=[700,40]
expect doc.@T.anchor=world
delete_comment threadId=@T commentId=@r
expect doc.@T.comments=2
delete_comment threadId=@T
expect doc.threads.size=0 last.current.thread=null dom.card=null
```

```screens id=comment-failed
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
add_comment itemId=@A x=40 y=40 text=Start as=@T
click @T
fault fail-commit storage
type Lost?
key Enter
expect doc.@T.comments=1 pending.failed=1 dom.toast="Couldn't save" dom.@T.failed=1 dom.@T.texts has Lost?
toast retry
expect doc.@T.comments=2 pending.size=0 dom.toast=null dom.@T.failed=0 dom.@T.texts has Lost?
```

```screens id=comment-replay
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
add_comment itemId=@A x=40 y=40 text=Once opId=c-replay-1 as=@T
arrange_items items=[{"itemId":"@A","x":0,"y":0,"width":800,"height":600}]
mark
add_comment itemId=@A x=40 y=40 text=Once opId=c-replay-1
expect doc.rev=+0 doc.threads.size=1 doc.@T.x=0.1 last.id=@T last.status=committed
reply_comment threadId=@T text=Again opId=c-replay-2
reply_comment threadId=@T text=Again opId=c-replay-2
expect doc.@T.comments=2
```

```screens id=comment-replay-changed
add_comment x=10 y=10 text=First opId=c-changed-1 as=@T
mark
!add_comment x=99 y=99 text=Different opId=c-changed-1
move_comment threadId=@T x=12 y=14 opId=c-changed-2
!move_comment threadId=@T x=50 y=50 opId=c-changed-2
expect doc.rev=+1 doc.threads.size=1 doc.@T.x=12 doc.@T.y=14 doc.@T.text=First
```

```screens id=comment-invalid
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
mark
! add_comment itemId=@A x=40 y=40 text="   "
! add_comment itemId=@A x=5000 y=40 text=Outside
! reply_comment threadId=nosuchthread text=Hi
expect doc.rev=+0 doc.threads.size=0
```

```screens id=comment-restart
add_object title=A files=fixture:plain x=0 y=0 width=400 height=300 as=@A
tool comment
click @A+100,60
type Survives
key Enter as=@T
reply_comment threadId=@T text="So does this" as=@r
mark
service restart
expect doc.rev=+0 doc.@T.anchor=@A doc.@T.x=0.25 doc.@T.comments=2 doc.@r.text="So does this" storage.rev=doc.rev
wait dom.@T.pin=shown
```

```screens id=comment-panel-drafts
add_comment x=750 y=300 text=Existing as=@T
key c
click bg:150,300
type Unfinished annotation
click ui:Comments
expect view.comment.panelOpen=true dom.commentValue="Unfinished annotation"
click ui:"Hide comments"
expect dom.panel=null dom.commentValue="Unfinished annotation"
click @T
expect dom.composer=Reply view.comment.parkedDraft!=null
click @T
expect dom.commentValue="Unfinished annotation"
click @T
type Unfinished reply
click ui:Close
expect dom.composer="New comment" dom.commentValue="Unfinished annotation"
key Enter as=@N
expect doc.@N.text="Unfinished annotation" dom.card=null
click @T
expect dom.commentValue="Unfinished reply"
key Enter as=@r
expect doc.@r.text="Unfinished reply" storage.rev=doc.rev
click ui:Comments
click ui:"Hide comments"
expect dom.card=@T dom.panel=null
```

```screens id=comment-edit
key c
click bg:150,300
type Original
key Enter as=@T
click @T
click ui:"Edit comment"
key Mod+a
type Cancelled
click ui:Close
click @T
click ui:"Edit comment"
expect dom.commentValue=Cancelled
click ui:Cancel
expect doc.@T.text=Original dom.composer=Reply
click ui:"Edit comment"
key Mod+a
type Revised
click ui:"Save comment"
expect doc.@T.text=Revised dom.@T.texts has Revised pending.size=0
reply_comment threadId=@T text="Agent reply" as=@r
key Escape
undo
expect doc.@T.text=Original doc.@r.text="Agent reply"
edit_comment threadId=@T commentId=@r text="Agent revised" expectedText="Agent reply" opId=edit-replay1
edit_comment threadId=@T commentId=@r text="Agent revised" expectedText="Agent reply" opId=edit-replay1
expect doc.@r.text="Agent revised"
mark
!edit_comment threadId=@T commentId=@r text=Stale expectedText="Agent reply"
expect doc.rev=+0 doc.@r.text="Agent revised"
list_comments
expect last.threads.0.comments.0.author.kind=person last.threads.0.comments.1.author.kind=agent storage.rev=doc.rev
```

```screens id=comment-edit-failed
key c
click bg:150,300
type Original
key Enter as=@T
click @T
click ui:"Edit comment"
key Mod+a
type Recoverable
fault fail-commit storage
click ui:"Save comment"
expect doc.@T.text=Original pending.failed=1 dom.@T.texts has Recoverable dom.toast="Couldn't save"
toast retry
expect doc.@T.text=Recoverable pending.size=0 dom.toast=null
```

```screens id=comment-popover
add_comment x=150 y=300 text=Here as=@T
click @T
expect dom.popover.w=296 dom.popover.visible=true dom.panel=null
wheel 0,80 at bg:700,600
expect view.camera.y=-80 dom.popover.y=192 dom.popover.w=296
wheel 0,-10 at bg:100,220 --cmd
expect dom.popover.w=296 dom.popover.visible=true
key Escape
move_comment threadId=@T x=1100 y=600
click @T
expect dom.popover.x>=6 dom.popover.x<=978 dom.popover.y>=6 dom.popover.y<=700
wheel 0,100 at ui:Reply
expect dom.popover.w=296 dom.card=@T
```

```screens id=comment-compact
add_comment x=50 y=300 text="Compact annotation" as=@T
expect dom.panel=null
click @T
expect dom.card=@T dom.popover.visible=true
type Keep this reply
click ui:Comments
click ui:"Hide comments"
expect dom.commentValue="Keep this reply" dom.card=@T
click ui:Close
click @T
expect dom.commentValue="Keep this reply"
key Enter as=@r
expect doc.@r.text="Keep this reply" pending.size=0 storage.rev=doc.rev
shot as=compact-annotation
```

```screens id=comment-scroll
add_comment x=150 y=300 text="Review notes" as=@T
reply_comment threadId=@T text="1. A detailed note about the spacing between the heading, the supporting copy and the primary action. Keep the content aligned with the rest of the page and preserve its hierarchy."
reply_comment threadId=@T text="2. A detailed note about the spacing between the heading, the supporting copy and the primary action. Keep the content aligned with the rest of the page and preserve its hierarchy."
reply_comment threadId=@T text="3. A detailed note about the spacing between the heading, the supporting copy and the primary action. Keep the content aligned with the rest of the page and preserve its hierarchy."
reply_comment threadId=@T text="4. A detailed note about the spacing between the heading, the supporting copy and the primary action. Keep the content aligned with the rest of the page and preserve its hierarchy."
reply_comment threadId=@T text="5. A detailed note about the spacing between the heading, the supporting copy and the primary action. Keep the content aligned with the rest of the page and preserve its hierarchy."
reply_comment threadId=@T text="6. A detailed note about the spacing between the heading, the supporting copy and the primary action. Keep the content aligned with the rest of the page and preserve its hierarchy."
reply_comment threadId=@T text="7. A detailed note about the spacing between the heading, the supporting copy and the primary action. Keep the content aligned with the rest of the page and preserve its hierarchy."
reply_comment threadId=@T text="8. A detailed note about the spacing between the heading, the supporting copy and the primary action. Keep the content aligned with the rest of the page and preserve its hierarchy."
click @T
wheel 0,-10000 at ui:Conversation
expect dom.popover.scroll=0
reply_comment threadId=@T text="Another agent reply while reading"
expect dom.popover.scroll=0
wheel 0,160 at ui:Conversation
expect dom.popover.scroll>0 view.camera.x=0 view.camera.y=0
move_comment threadId=@T x=2500 y=1500
expect dom.popover.visible=false
click ui:Comments
click @T.row
expect dom.popover.visible=true dom.card=@T
```

```screens id=comment-edit-conflict
add_comment x=150 y=300 text=Start as=@T
click @T
type Original reply
key Enter as=@c
click ui:"Edit comment"
key Mod+a
type My revision
edit_comment threadId=@T commentId=@c text="Concurrent revision" expectedText="Original reply"
click ui:"Save comment"
expect doc.@c.text="Concurrent revision" pending.failed=1 dom.@T.texts has "My revision" dom.toast="Couldn't save: it changed since"
```

```screens id=comment-keyboard
add_comment x=150 y=300 text=Keyboard as=@T
click @T
click ui:Close
key Enter
expect dom.card=@T dom.composer=Reply
key Escape
expect dom.card=null
```

## Gotchas

- `@T` is a thread's pin, `@T.row` its panel row (when the Comments index is open), and `@c` a comment's Delete button in the open card. `as=` on a person step binds the thread or comment the step created.
- screens-cli cannot raise a real `pointercancel`. `cancel` sends Escape, which runs the same cancel path in the reducer.
- A reply box is disabled until its thread is saved, so a reply can never land before its thread.
- The Resolved filter applies to pins and to the panel. Resolving closes the card.
- Unsent text is cached per draft, reply or edited comment in the view's runtime, independently of mounted textareas. View state holds positions, the active thread, edit target, panel visibility, filter and whether the person is composing.
- Agent comments use the active presence lane's name, with "Agent" as the fallback.
