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
- `layers-scripted`: a piece edit to an object with scripts is test-loaded before it commits, like an update.

## How to get to it (user POV)

- An agent calls `read_object`, `edit_object` and `get_poster`.
- A person selects an object, presses Focus, and uses the Layers panel on the right. The Layers button beside Exit focus hides or shows it.

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

## Gotchas

- Pieces are listed from the committed source. A row's eye shows the new state only after the service commits it; until then the row shows a spinner.
- The details section remembers whether it was left open, in the browser. Run `layers-panel` in a fresh session (`run --fresh`), or a session that opened it earlier starts with it open.
- An object with scripts (like `fixture:plain`, which has an `onclick`) can't skip the load check, so its piece edits take as long as an update.
- Pieces only exist in the source HTML. Elements a page's own script creates are not pieces.
