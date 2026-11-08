# Library

The library holds every Screen, flat folders of Screens, one Media collection of images, and an Archive. People organize it from a sidebar and grids; agents use the folder, archive and media tools. Library state lives in a catalog the service owns, so listing and searching read no Screen document.

## Sub-features

- `lib-folders`: `create_folder` and `move_screens` put a Screen in exactly one folder; `list_folders` and `list_screens folderId=` agree.
- `lib-archive`: archiving a folder archives its Screens; `restore` brings them back in the folder; only a person can delete permanently.
- `lib-media`: `add_media` stores an image with metadata, refuses non-images, and `search_media` matches text and `tag:` filters with thumbnails; `update_media` and `get_media` round-trip.
- `lib-media-place`: `add_image mediaId=` places a Media image on a Screen without sending its bytes; title and size come from the Media item, and a retry with the same input meets its receipt after the Media item is renamed.
- `lib-media-from-screen`: `add_media fromScreen` saves a Screen image to Media, and `get_media` lists the Screen under usedIn.
- `lib-restart`: folders, membership, archive state and Media survive a service restart, which replays the catalog log.
- `lib-no-reads`: listing Screens and folders and searching Media parse no Screen document (LP-1).
- `lib-opened`: opening a Screen in a canvas records Last Opened without changing its revision.
- `lib-drop`: dragging a tile from the Media drawer onto the canvas adds an image item centred where it lands.
- `lib-ui-archive`: on the library page, selecting a Screen and pressing Backspace archives it, and the toast's Undo restores it.
- `lib-ui-inspector`: in Media, Space opens the focused view, the inspector edits tags, and the change commits.

## How to get to it (user POV)

- The back button in a Screen opens the library. The sidebar lists All, the folders, Media and Archive. In a Screen the sidebar starts minimized behind its button, and the Media button opens the drawer.
- Agents call `list_screens`, `list_folders`, `create_folder`, `move_screens`, `archive`, `restore`, `add_media`, `search_media`, `get_media` and `update_media`.

## Driving it with screens-cli

```screens id=lib-folders
create_folder name=Fitness as=@F
move_screens screenIds=[@S] folderId=@F
list_screens folderId=@F
expect last.screens.size=1 last.screens.0.id=@S last.screens.0.folderId=@F
list_folders
expect last.folders.0.name=Fitness last.folders.0.screens=1
```

```screens id=lib-archive
create_folder name=Old as=@F
move_screens screenIds=[@S] folderId=@F
archive targets='[{"kind":"folder","id":"@F"}]'
list_screens query=lib-archive
expect last.screens.size=0
list_screens query=lib-archive archived=true
expect last.screens.size=1
restore targets='[{"kind":"folder","id":"@F"}]'
list_screens folderId=@F
expect last.screens.size=1 last.screens.0.archived=false
```

```screens id=lib-media
add_media title="Pulse onboarding" base64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== app=Pulse platform=ios screenType=onboarding tags=fitness,lib-media as=@M
search_media query="pulse tag:lib-media"
expect last.total=1 last.items.0.mediaId=@M last.images.size=1
search_media query="tag:lib-media tag:nothing"
expect last.total=0
!add_media title=Text base64=aGVsbG8=
update_media mediaId=@M tags=fitness,lib-media,dark description="Dark onboarding"
get_media mediaId=@M
expect last.tags.size=3 last.description="Dark onboarding" last.images.size=1
```

```screens id=lib-media-place
add_media title="Goal selection" base64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== tags=lib-place as=@M
add_image mediaId=@M x=0 y=0 opId=place-1 as=@I
expect doc.@I.kind=img doc.@I.title="Goal selection" doc.@I.width=1 doc.@I.height=1 dom.@I.rendered=true
update_media mediaId=@M title="Goal picker"
mark
add_image mediaId=@M x=0 y=0 opId=place-1
expect doc.rev=+0 last.itemId=@I doc.@I.title="Goal selection"
!add_image mediaId=@M x=50 y=0 opId=place-1
!add_image mediaId=nosuchmedia
```

```screens id=lib-media-from-screen
add_image title=Ref mediaType=image/png width=40 height=40 base64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== as=@I
add_media title=Saved fromScreen='{"screenId":"@S","itemId":"@I"}' tags=lib-from as=@M
get_media mediaId=@M
expect last.usedIn.0.screenId=@S
```

```screens id=lib-restart
create_folder name=Kept as=@F
move_screens screenIds=[@S] folderId=@F
add_media title=Survivor base64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== tags=lib-restart as=@M
archive targets='[{"kind":"media","id":"@M"}]'
service restart
list_screens folderId=@F
expect last.screens.size=1 last.screens.0.id=@S
search_media query=tag:lib-restart archived=true
expect last.total=1 last.items.0.mediaId=@M storage.orphans=0
```

```screens id=lib-no-reads
mark
list_screens
list_folders
search_media query=fitness
list_screens archived=true
expect service.library.docReads=+0
```

```screens id=lib-opened
list_screens query=lib-opened
expect last.screens.0.lastOpenedAt>0 last.screens.0.revision=0
```

```screens id=lib-drop
add_media title=DropMe base64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== tags=lib-drop as=@M
click ui:Media
drag ui:DropMe to w:200,100 as=@D
expect doc.items.size=1 doc.@D.x=200 doc.@D.y=100 doc.@D.title=DropMe pending.size=0 storage.rev=doc.rev
```

```screens id=lib-ui-archive
click ui:Library
click ui:library/lib-ui-archive
mark
key Backspace
wait storage.catalog.archived=+1
list_screens query=lib-ui-archive
expect last.screens.size=0
click ui:Undo
wait storage.catalog.archived=+0
list_screens query=lib-ui-archive
expect last.screens.size=1
```

```screens id=lib-ui-inspector
add_media title=InspectMe base64=iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg== tags=lib-inspect as=@M
click ui:Library
click ui:Media
click ui:InspectMe
key Space
click ui:Inspector
click ui:"Add tag"
type dark
mark
key Enter
wait storage.catalog.version=+1
get_media mediaId=@M
expect last.tags has dark
```

## Gotchas

- Library operations report `catalogVersion`, not a Screen revision, so a block waits on `storage.catalog` after a person's library action.
- Library state outlives a block within a session: blocks filter by their own Screen's title (`query=<block id>`) or their own tags.
- A view that navigates to the library page closes its Screen client. Do agent edits to the Screen before `click ui:Library`.
- `purge` has no MCP tool on purpose. Permanent delete is checked by hand in Archive (Delete, Delete all).
