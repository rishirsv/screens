# Agent snapshots

An agent adds a self-contained HTML bundle to a Screen, updates it in place, and reads its source back. Each change appears on any open canvas without a reload. Retrying an operation with the same `opId` returns the original result.

## Sub-features

- `snap-add`: `add_object` commits an item. HTML, CSS, images and ES modules are inlined, relative and dynamic imports included.
- `snap-replay`: the same `opId` and payload returns the same `itemId` and revision. The same `opId` with a different payload fails.
- `snap-update`: `update_object` keeps the item's ID, position and size, swaps `contentVersion`, and the open canvas remounts that frame.
- `snap-read`: `read_object` and `get_screen` return the bundle and the item; `list_screens` and `get_screen` page with `limit` and `cursor`.
- `snap-read-binary`: `read_object` returns binary files as size and hash unless asked, and `update_object` keeps a file by its hash.
- `snap-image`: `add_image` adds a reference image.
- `snap-inline`: every asset attribute is inlined, quoted or not; a CSS import cycle is a diagnostic, not a crash.
- `snap-live`: agent edits appear on the open canvas without a reload.
- `snap-guide`: `get_guide` serves the main guide and its topics, and refuses an unknown topic.

## How to get to it (user POV)

- An agent calls the MCP tools `get_guide`, `add_object`, `update_object`, `read_object`, `add_image`, `get_screen` and `list_screens`.

## Driving it with screens-cli

```screens id=snap-guide
get_guide topic=screens-instructions
get_guide topic=recovery
!get_guide topic=nope
```

```screens id=snap-add
add_object title=Mods files=fixture:modules x=0 y=0 height=400 as=@M
expect frames.@M.load=ready doc.@M.files has lib.js
click @M
inside @M text #out
expect last="modules ok"
```

```screens id=snap-replay
add_object title=Once files=fixture:plain opId=v-add-1 height=300 as=@A
mark
add_object title=Once files=fixture:plain opId=v-add-1 height=300 as=@B
expect doc.rev=+0 doc.items.size=1 last.itemId=@A
!add_object title=Other files=fixture:plain opId=v-add-1 height=300
op_status opId=v-add-1
expect last.status=committed
```

```screens id=snap-update
add_object title=Live files=fixture:plain x=40 y=60 height=300 as=@A
mark
update_object itemId=@A expectedRevision=1 files=fixture:modules
expect doc.@A.x=40 doc.@A.y=60 doc.@A.height=300 doc.@A.cv=last.contentVersion frames.@A.gen=+1 frames.@A.load=ready
click @A
inside @A text #out
expect last="modules ok"
```

```screens id=snap-live
add_object title=Live files=fixture:plain height=300 as=@A
update_object itemId=@A expectedRevision=1 files=fixture:modules
click @A
inside @A text #out
expect last="modules ok" frames.@A.load=ready
```

```screens id=snap-read
add_object title=Read files=fixture:modules height=300 as=@A
read_object itemId=@A format=files
expect last.files.size=4 last.entry=index.html
get_screen
expect last.items.0.id=@A last.totalItems=1 last.next=null
add_image title=Ref mediaType=image/png width=40 height=40 base64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== as=@I
get_screen limit=1
expect last.items.size=1 last.items.0.id=@A last.totalItems=2 last.next!=null
list_screens limit=1
expect last.screens.size=1 last.total>0
```

```screens id=snap-read-binary
add_object title=Big files=fixture:big-image height=300 as=@B
read_object itemId=@B format=files
expect last.files.size=2 last.files.1.path=big.bmp last.files.1.encoding=omitted last.files.1.bytes>0 last.files.0.encoding=utf8
read_object itemId=@B paths=big.bmp
expect last.files.size=1 last.files.0.encoding=base64
!read_object itemId=@B paths=nothing.png
```

```screens id=snap-inline
add_object title=Inline height=300 files='[{"path":"index.html","content":"<link rel=stylesheet href=a.css><img id=i src=dot.svg><video id=v src=dot.svg poster=dot.svg></video><p id=r></p><script>onload=()=>{r.textContent=`img:${i.naturalWidth} poster:${v.getAttribute(\"poster\").slice(0,5)}`}</script>"},{"path":"a.css","content":"@import \"b.css\"; body{color:red}"},{"path":"b.css","content":"@import \"a.css\";"},{"path":"dot.svg","content":"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"4\" height=\"4\"/>"}]' as=@A
expect frames.@A.load=ready
click @A
inside @A text #r
expect last="img:4 poster:data:"
```

```screens id=snap-image
add_image title=Ref mediaType=image/png width=40 height=40 base64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== as=@I
expect doc.@I.kind=img dom.@I.rendered=true
```

## Gotchas

- A snapshot that references `https://…` assets loads without them, and the service log shows a diagnostic. Snapshots never touch the network.
- Without `x` and `y`, the item is placed 80 units right of everything, by the core operation. That keeps replays identical.
- screens-cli gives every mutation an `opId` when you do not, so `op.last.status` always has something to ask about.
- Every add and update test-loads the page first. See [snapshot validation](./snapshot-validation.md) for posters, warnings and refusals.
