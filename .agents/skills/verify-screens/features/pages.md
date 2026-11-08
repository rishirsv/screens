# Presentations and Documents

A Presentation (`layout: slides`, 1920x1080 pages) or a Document (`layout: a4`, 794x1123 pages) is a Screen whose items are pages. Core keeps them in z order, at the page size, in one column with 64-unit gaps. The canvas shows them in a scroll view where the person edits, a responsive grid where dragging reorders, and, for slides, Present.

## Sub-features

- `pages-agent`: `create_screen layout=slides` makes a Presentation; `add_object` appends pages at the page size and inserts at `index`; `reorder_items to={index}` moves a page; free placement and world comments are refused.
- `pages-undo`: placement writes no revision, so undoing an add still works after another page moved, and `update_object` with a revision read before the move still commits.
- `pages-scroll`: in the scroll view a drag on a page pans and never moves it; arrows step the selection between pages; pencil marks only land on a page.
- `pages-drop`: images dropped on a Document page become pages after it, fitted inside the page, as one undo step; a paste appends.
- `pages-grid`: the grid shows pages in columns and keeps live pages shielded even when selected; dragging a page reorders by index, shows pending at once, and one undo restores the order; leaving the grid ends any focus taken there.
- `pages-present`: Present starts at the selected slide (from the scroll view or the grid), keeps only that slide live and shielded, steps with keys, ignores edits, and Escape returns to the scroll view.
- `pages-library`: Presentations and Documents rows list Screens by layout with counts; New there creates that layout.
- `pages-files`: slide posters are full resolution (read from the image itself); export and import into an empty library keep the layout and pages.

- `pages-comments`: Present starts with comments hidden, offers a read-only current-slide drawer, does not advance on drawer interaction and restores unfinished annotation text on exit.

## How to get to it (user POV)

- The library sidebar has Presentations and Documents rows next to Media. New in either creates that kind; New anywhere else makes a canvas.
- In a Presentation or Document, the Scroll and Grid control and the Present button (slides only) sit at the bottom left.
- Agents pass `layout` to `create_screen`, `index` to `add_object` and `add_image`, and `to: { index }` to `reorder_items`.

## Driving it with screens-cli

```screens id=pages-agent
create_screen title=Deck layout=slides as=@P
add_object title=One files=fixture:plain as=@A
add_object title=Two files=fixture:plain as=@B
add_object title=Zero files=fixture:plain index=0 as=@Z
expect doc.@A.width=1920 doc.@A.height=1080 doc.@Z.y=0 doc.@A.y=1144 doc.@B.y=2288
reorder_items itemIds=[@B] to='{"index":0}'
expect doc.@B.y=0 doc.@Z.y=1144 doc.@A.y=2288
!reorder_items itemIds=[@B] to='{"index":0}'
!reorder_items itemIds=[@B] to='{"index":3}'
!arrange_items items='[{"itemId":"@A","x":5,"y":5}]'
!add_object title=Placed files=fixture:plain x=10 y=10
!add_comment x=10 y=10 text=hi
add_comment itemId=@A x=100 y=100 text=hi
get_screen
expect last.layout=slides last.items.0.id=@B last.items.2.id=@A
list_screens query=Deck
expect last.screens.0.layout=slides
get_view
expect last.view.pages.view=scroll
```

```screens id=pages-undo
create_screen title=Shift layout=a4 as=@P
add_object title=A files=fixture:plain as=@A
add_object title=B files=fixture:plain as=@B
add_object title=C files=fixture:plain as=@C
expect doc.@C.revision=3
click @A
delete
expect doc.@B.y=0 doc.@C.y=1187 doc.@C.revision=3
undo
expect doc.items.size=3 doc.@A.y=0 doc.@B.y=1187
update_object itemId=@C expectedRevision=3 files=fixture:modules
expect pending.size=0
```

```screens id=pages-scroll
create_screen title=Scroll layout=slides as=@P
add_object title=One files=fixture:plain as=@A
add_object title=Two files=fixture:plain as=@B
drag @A by 0,-200
expect doc.@A.y=0 pending.size=0 view.camera.y<96
click @A
key ArrowDown
expect view.selection=[@B]
key Mod+ArrowRight
expect doc.@B.width=1920 pending.size=0
tool pencil
draw w:-60,1200 by 30,30
expect doc.strokes.size=0
draw @B by 40,40
expect doc.strokes.size=1
```

```screens id=pages-drop
create_screen title=Notes layout=a4 as=@P
add_image title=First mediaType=image/png width=40 height=40 base64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== as=@I
add_image title=Last mediaType=image/png width=40 height=40 base64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== as=@L
expect doc.@I.width=794 doc.@I.height=1123
drop fixture:png fixture:png at @I
expect doc.items.size=4 doc.@L.y=3561 pending.size=0
undo
expect doc.items.size=2 doc.@L.y=1187
paste fixture:png
expect doc.items.size=3 doc.@L.y=1187
```

```screens id=pages-grid
create_screen title=Order layout=slides as=@P
add_object title=One files=fixture:plain as=@A
add_object title=Two files=fixture:plain as=@B
add_object title=Three files=fixture:plain as=@C
add_object title=Four files=fixture:plain as=@D
add_object title=Five files=fixture:plain as=@E
click ui:Grid
expect view.pages.view=grid
click @B
wait frames.@B.load=ready
expect frames.@B.input=shield
press @E
move to @B
release
expect doc.@E.y=2288 doc.@C.y=3432 pending.size=0
undo
expect doc.@E.y=4576 doc.@C.y=2288
click @B
key f
expect view.focus=focused:@B
click ui:Scroll
expect view.pages.view=scroll view.focus=none
```

```screens id=pages-present
create_screen title=Talk layout=slides as=@P
add_object title=One files=fixture:plain as=@A
add_object title=Two files=fixture:plain as=@B
add_object title=Three files=fixture:plain as=@C
click @A
key ArrowDown
click ui:Present
expect view.pages.view=present view.focus=focused:@B frames.live=1 frames.@B.input=shield
click ui:"Previous slide"
expect view.focus=focused:@A
click ui:"Next slide"
expect view.focus=focused:@B
key ArrowRight
expect view.focus=focused:@C
key ArrowRight
expect view.focus=focused:@C
key Home
expect view.focus=focused:@A frames.live=1
key Delete
expect doc.items.size=3
key Escape
expect view.pages.view=scroll view.selection=[@A]
click ui:Grid
click @B
click ui:Present
expect view.focus=focused:@B view.camera.y<-700
click ui:"Exit presentation"
expect view.pages.view=scroll
```

```screens id=pages-library
create_screen title=Lib-deck layout=slides as=@P
create_screen title=Lib-doc layout=a4 as=@D
click ui:Library
click ui:Presentations
mark
click ui:"New presentation"
list_screens query=Untitled
expect last.screens.0.layout=slides
click ui:Library
click ui:Documents
click ui:"New document"
list_screens query=Untitled
expect last.screens.0.layout=a4
```

```screens id=pages-files
create_screen title=Posters layout=slides as=@P
add_object title=One files=fixture:plain as=@A
get_poster itemId=@A
expect last.width=1920 last.height=1080 last.images.0.width=1920 last.images.0.height=1080
export_screen path=.verify/pages-files.screens
!import_screen path=.verify/pages-files.screens
service reset
import_screen path=.verify/pages-files.screens opId=pages-files-1
use @P
get_screen
expect last.layout=slides last.items.0.id=@A last.items.0.width=1920
```

```screens id=pages-comments
create_screen title=Review layout=slides as=@P
add_object title=One files=fixture:plain as=@A
add_object title=Two files=fixture:plain as=@B
add_comment itemId=@A x=100 y=100 text="Slide one" as=@T
add_comment itemId=@B x=100 y=100 text="Slide two" as=@U
click @A
click ui:Present
expect view.pages.view=present dom.panel=null dom.@T.pin=hidden
click ui:Comments
expect dom.panel=[@T] view.focus=focused:@A
click @T.row
expect dom.card=@T dom.composer=null view.focus=focused:@A
key Escape
expect view.pages.view=present dom.panel=null
key ArrowRight
click ui:Comments
expect dom.panel=[@U] view.focus=focused:@B
click ui:"Exit presentation"
expect view.pages.view=scroll dom.panel=null
key c
click @B+200,200
type Preserve this draft
click ui:Present
expect dom.commentValue=null
click ui:"Exit presentation"
expect dom.commentValue="Preserve this draft" view.comment.draft!=null
```

## Gotchas

- An image dropped on a page inserts after it. Pasting inserts after the sole selected page, or appends when no single page is selected. Grid reordering chooses before or after by the page's horizontal half.
- In the grid the canvas shows its own arrangement, so `doc` rects stay the stored column while the frames sit in grid cells. Agents and `get_view` see stored coordinates only.
- Present shields the live slide, so its own buttons cannot be clicked while presenting; clicks advance instead.
- Fullscreen is requested from the Present button and is not checked headless. Whether the Claude desktop Browser pane allows it is a host check.
