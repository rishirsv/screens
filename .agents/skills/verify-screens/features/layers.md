# Layers

An object's pieces are the elements of its HTML. An agent changes them with `edit_object` instead of resending the page, and a person sees and edits them in the inspector in focus mode. The HTML stays the only source: piece ids, names and hidden flags are attributes in it.

## Sub-features

- `layers-edit`: a cold `edit_object` finds the button by a query, restyles and moves it in one call, and saves without the load check on an object with no scripts. `read_object` returns the outline.
- `layers-ambiguous`: a query that matches two pieces commits nothing and names both.
- `layers-write`: `write` appends a section that becomes pieces, `look` attaches a picture of the changed pieces, and `get_poster` renders the object's current version.
- `layers-panel`: focus mode lists the pieces; Hide hides one; the details sit behind a chevron, closed by default, and keep their open state; a rename and a text edit save through the service.
- `layers-minimize`: the Layers button beside Exit focus hides and shows the panel, and a hidden panel stays hidden on the next focus.
- `layers-click`: clicking a piece in the live object selects its row.
- `layers-merge`: the person's hide and the agent's card edit both stay, and the person's undo takes back only the hide.
- `layers-format`: on a slide, clicking a piece shows the format bar beside it with no focus mode; Italic, size and alignment save as inline styles.
- `layers-type`: double-clicking text types on the page; Enter saves it through the service, Escape discards it and keeps the selection.
- `layers-text-selection`: dragging across words starts text editing, replaces only those words and saves no position change; a reverse drag selects multiple words.
- `layers-drag`: an absolutely positioned piece drags to a new left and top, and the person's undo puts it back.
- `layers-multi`: a drag from the slide's background draws a marquee that selects the pieces inside it; arrow keys nudge them together (ten pixels with Shift) as one saved move, and go on working after the page reloads. A piece in the flow moves by a relative offset.
- `layers-resize`: every piece carries eight handles; dragging the east handle of a heading saves its width.
- `layers-insert`: the Layers panel adds a table that arrives selected; a cell takes typed text; Add row and Add column grow it; Delete removes the selected piece.
- `layers-tree`: the panel lists content, not layout: an unnamed wrapper around one piece is skipped and a group is titled by what it is.
- `layers-hint`: an object with no text elements comes back with a hint that the person cannot edit its words.
- `layers-scripted`: a piece edit to an object with scripts is test-loaded before it commits, like an update.

## How to get to it (user POV)

- An agent calls `read_object`, `edit_object` and `get_poster`.
- A person selects an object, presses Focus, and uses the Layers panel on the right. The Layers button beside Exit focus hides or shows it.
- On a Presentation or Document, a person clicks a page and then a piece on it: the format bar appears beside the piece. Dragging across text selects words for editing. Double-clicking text also types into it. Anywhere else the same works in focus mode.

## Driving it with screens-cli

```screens id=layers-edit
add_object title=Water files=fixture:pieces x=0 y=0 height=500 as=@A
mark
edit_object itemId=@A edits='[{"at":{"tag":"button","text":"water"},"style":{"background-color":"#2563eb"},"move":{"before":{"tag":"h1"}}}]'
expect last.status=committed doc.rev=+1 last.resolved.0.0=cta last.changed~=cta doc.@A.poster=null last.warnings.size=0
read_object itemId=@A
expect last.pieces~="hdr header" last.pieces~="cta button"
read_object itemId=@A piece=cta format=source
expect last.source~="#2563eb"
```

```screens id=layers-ambiguous
add_object title=Water files=fixture:pieces x=0 y=0 height=500 as=@A
mark
!edit_object itemId=@A edits='[{"at":{"class":"card"},"style":{"color":"red"}}]'
expect doc.rev=+0 op.last.status=failed op.last.error.message~="matches 2 pieces" op.last.error.message~="am div.card"
```

```screens id=layers-write
add_object title=Water files=fixture:pieces x=0 y=0 height=500 as=@A
edit_object itemId=@A look=true edits='[{"at":"body","pos":"end","write":"<section data-pid=\"tips\"><p>Water in the morning</p></section>"}]'
expect last.status=committed last.changed~="tips section" last.images.size=1 last.poster.rect!=null
get_poster itemId=@A
expect last.images.size=1 last.contentVersion=doc.@A.cv
```

```screens id=layers-panel
add_object title=Water files=fixture:pieces x=0 y=0 height=500 as=@A
focus @A
wait dom.layers.rows.size=6
expect dom.layers.rows.0=hdr dom.layers.selected=null
click ui:"Hide Help"
wait dom.layers.hidden has ftr
read_object itemId=@A
expect last.pieces~="ftr footer \"Help\" hidden"
click ui:"Water now"
expect dom.layers.selected=cta dom.layers.details.open=false
click ui:"Details of Water now"
expect dom.layers.details.open=true dom.layers.details.text="Water now"
click ui:Text
key Mod+a
type Drink water
key Enter
read_object itemId=@A piece=cta format=source
expect last.source~="Drink water"
click ui:Monstera
expect dom.layers.selected=am dom.layers.details.open=true
click ui:"Drink water"
click ui:"Drink water" --double
type Add a glass
key Enter
wait dom.layers.labels has "Add a glass"
read_object itemId=@A piece=cta format=source
expect last.source~="data-name=\"Add a glass\""
```

```screens id=layers-minimize
add_object title=Water files=fixture:pieces x=0 y=0 height=500 as=@A
focus @A
wait dom.layers.rows.size=6
click ui:Layers
expect dom.layers=null
key Escape
focus @A
expect dom.layers=null
click ui:Layers
wait dom.layers.rows.size=6
```

```screens id=layers-click
add_object title=Water files=fixture:pieces x=0 y=0 height=500 as=@A
focus @A
wait frames.@A.load=ready dom.layers.rows.size=6
click @A+54,198
wait dom.layers.selected=pm
```

```screens id=layers-merge
add_object title=Water files=fixture:pieces x=0 y=0 height=500 as=@A
focus @A
wait dom.layers.rows.size=6
click ui:"Hide Help"
wait dom.layers.hidden has ftr
edit_object itemId=@A edits='[{"at":{"class":"card"},"all":true,"style":{"background-color":"#eff6ff"}}]'
read_object itemId=@A
expect last.pieces~="ftr footer \"Help\" hidden"
undo
wait dom.layers.hidden.size=0
read_object itemId=@A piece=am format=source
expect last.source~="#eff6ff"
```

```screens id=layers-scripted
add_object title=Plain files=fixture:plain x=0 y=0 height=400 as=@P
mark
edit_object itemId=@P edits='[{"at":{"tag":"h1"},"text":"Pay"}]'
expect last.status=committed doc.rev=+1 doc.@P.poster!=null
```

```screens id=layers-format
create_screen title=Deck layout=slides as=@P
add_object title=One files=fixture:slide as=@A
click @A
wait frames.@A.load=ready
click @A+300,170
wait dom.format.pid=ttl
expect dom.format.size=96 dom.layers=null
expect dom.format.pressed has Bold
click ui:Italic
wait dom.format.pressed has Italic
click ui:"Larger text"
wait dom.format.size=106
click ui:"Align center"
wait dom.format.pressed has "Align center"
read_object itemId=@A piece=ttl format=source
expect last.source~="font-style: italic" last.source~="font-size: 106px" last.source~="text-align: center"
```

```screens id=layers-type
create_screen title=Deck layout=slides as=@P
add_object title=One files=fixture:slide as=@A
click @A
wait frames.@A.load=ready
click @A+300,170 --double
key Mod+a
type Revenue reached
key Enter
wait frames.@A.load=ready
read_object itemId=@A piece=ttl format=source
expect last.source~="Revenue reached" pending.size=0 storage.rev=doc.rev
mark
click @A+300,170 --double
type Discarded
key Escape
click @A+300,290
wait dom.format.pid=sub
expect doc.rev=+0
```

```screens id=layers-text-selection
create_screen title=Selection layout=slides as=@P
add_object title=One files=fixture:slide as=@A
click @A
wait frames.@A.load=ready
mark
drag @A+145,170 to @A+540,170
expect doc.rev=+0
type "Strong "
key Enter
wait doc.rev=+1 frames.@A.load=ready
read_object itemId=@A piece=ttl format=source
expect last.source='<h1 data-pid="ttl" style="font-size: 96px; margin: 0">Strong grew</h1>' pending.size=0 storage.rev=doc.rev
undo
wait frames.@A.load=ready
mark
drag @A+800,170 to @A+145,170
expect doc.rev=+0
type Annual growth
key Enter
wait doc.rev=+1 frames.@A.load=ready
read_object itemId=@A piece=ttl format=source
expect last.source='<h1 data-pid="ttl" style="font-size: 96px; margin: 0">Annual growth</h1>' pending.size=0 storage.rev=doc.rev
```

```screens id=layers-drag
create_screen title=Deck layout=slides as=@P
add_object title=One files=fixture:slide as=@A
click @A
wait frames.@A.load=ready
click @A+1600,130
wait dom.format.pid=badge
drag @A+1600,130 by -200,100
wait frames.@A.load=ready
read_object itemId=@A piece=badge format=source
expect last.source~="left: 1147px" last.source~="top: 256px"
undo
read_object itemId=@A piece=badge format=source
expect last.source~="left: 1500px; top: 80px"
```

```screens id=layers-multi
create_screen title=Deck layout=slides as=@P
add_object title=One files=fixture:slide as=@A
click @A
wait frames.@A.load=ready
drag @A+60,60 by 1015,170
mark
key ArrowRight
key ArrowRight
key Shift+ArrowDown
wait doc.rev=+1
read_object itemId=@A piece=badge format=source
expect last.source~="left: 1502px; top: 90px"
read_object itemId=@A piece=copy format=source
expect last.source~="left: 2px; top: 10px; position: relative"
wait frames.@A.load=ready
mark
key ArrowLeft
wait doc.rev=+1
read_object itemId=@A piece=badge format=source
expect last.source~="left: 1501px"
```

```screens id=layers-resize
create_screen title=Deck layout=slides as=@P
add_object title=One files=fixture:slide as=@A
click @A
wait frames.@A.load=ready
click @A+300,170
wait dom.format.pid=ttl
mark
drag @A+1777,202 by -300,0
wait doc.rev=+1
read_object itemId=@A piece=ttl format=source
expect last.source~="width: 1103px"
```

```screens id=layers-insert
create_screen title=Deck layout=slides as=@P
add_object title=One files=fixture:slide as=@A
focus @A
wait frames.@A.load=ready dom.layers.rows.size=4
click ui:"Add table"
wait dom.format!=null frames.@A.load=ready
expect dom.layers.labels has Table
click @A+700,540 --double
type Region
key Enter
wait frames.@A.load=ready
read_object itemId=@A
expect last.pieces~="td \"Region\""
click @A+700,540
wait dom.format!=null
click ui:"Add row"
wait frames.@A.load=ready
click ui:"Add column"
wait frames.@A.load=ready
read_object itemId=@A
expect last.pieces~="Region"
click ui:"Add rectangle"
wait dom.layers.labels has Rectangle
wait dom.format!=null frames.@A.load=ready
click ui:Delete
wait dom.format=null
read_object itemId=@A
expect last.pieces~="Table"
```

```screens id=layers-tree
create_screen title=Deck layout=slides as=@P
add_object title=One files=fixture:slide as=@A
focus @A
wait frames.@A.load=ready dom.layers.rows.size=4
expect dom.layers.rows.0=copy dom.layers.rows.1=ttl dom.layers.rows.3=badge dom.layers.labels.0=Section dom.layers.labels.3=Badge
```

```screens id=layers-hint
add_object title=Photo files=fixture:big-image x=0 y=0 height=400 as=@I
expect last.hint~="no text elements"
add_object title=Water files=fixture:pieces x=500 y=0 height=500 as=@A
expect last !has hint
```

## Gotchas

- Pieces are listed from the committed source. A row's eye shows the new state only after the service commits it; until then the row shows a spinner.
- The details section remembers whether it was left open, in the browser. Run `layers-panel` in a fresh session (`run --fresh`), or a session that opened it earlier starts with it open.
- An object with scripts (like `fixture:plain`, which has an `onclick`) can't skip the load check, so its piece edits take as long as an update.
- Pieces only exist in the source HTML. Elements a page's own script creates are not pieces.
- Typing on the page works on a piece that holds only text. A heading with a span or a `<br>` inside takes its text through the panel or `edit_object` instead.
- A double-click that lands while the object's new source is still arriving starts typing once it has arrived.
