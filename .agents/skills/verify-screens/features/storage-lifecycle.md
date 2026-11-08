# Storage, operations and service lifecycle

Writes pass through the real MCP adapters and canvas. Dev faults interrupt the storage adapter at its actual commit boundaries or raise ENOSPC at its write calls. Process probes launch isolated services and unrelated listeners; every MCP result in every block is scanned before it reaches the driver.

## Sub-features

- `writers-conflict`: two adapters use one expected revision; exactly one commits.
- `failed-events`: a failed document write emits zero revision events; a successful retry emits one.
- `receipt-lifetime`: receipts report accepted while writing, replay within a run, and preserve committed outcomes after restart.
- `shared-font`: two different snapshot bundles share one valid font file.
- `bundle-normalization`: leading `./` paths in the entry, stylesheet and script render through add and update.
- `legacy-bundle-paths`: a previously valid bundle remains readable and editable after restart and export/import.
- `poster-write-receipt`: a poster ENOSPC records a failed receipt and an identical replay stays failed.
- `damaged-threads`: explicitly null thread data is damaged rather than upgraded to empty.
- `bundle-paths`: absolute and traversal paths are refused through MCP and CLI, MCP refuses symlink descriptors, and the CLI refuses a bundle symlink before reading it.
- `disk-full-document`: ENOSPC leaves the old document, fails visibly in the canvas and MCP, and permits the next write.
- `disk-full-content`: ENOSPC during upload leaves no item, content or staging file, in both canvas and MCP.
- `damaged-json`: a malformed document is listed as damaged; opening fails clearly and other Screens remain usable.
- `damaged-schema`: a valid JSON document with invalid Screen data has the same recovery behavior.
- `crash-content-flush`: a kill after content has flushed leaves the old revision and collects orphaned bytes.
- `crash-temp-write`: a kill after the temporary document write leaves the old revision.
- `crash-temp-flush`: a kill after the temporary document flush leaves the old revision.
- `crash-rename`: a kill after rename leaves the new revision, including its content.
- `service-discovery`: two real MCP adapters race to start one service.
- `service-identity`: registry lookup and the client handshake refuse an unrelated listener.
- `service-idle`: one of two clients closing keeps the service up; the last closing starts idle exit.
- `service-port`: the preferred port is occupied; the registry records a working alternate.
- `service-term`: SIGTERM while a commit is delayed drains that accepted write before exit.
- `result-scan`: tool results contain no private storage paths or unrelated-file canary; this scan also runs for every tool in the full feature suite.

## How to get to it (user POV)

- A person saves a change or an agent calls a tool while storage fails, another writer races, or the service restarts.
- A damaged Screen appears in the library. Opening it explains the problem and links back to the usable library.

## Driving it with screens-cli

```screens id=writers-conflict
agent open second
fault delay-commit 500
mark
begin first rename_screen title=Winner expectedRevision=0 opId=writer-first
wait service.commitStage=before-write
begin second rename_screen client=second title=Other expectedRevision=0 opId=writer-second
join first
expect last.status=committed
!join second
expect last.error.code=conflict doc.rev=+1 events.revisions=+1 storage.rev=doc.rev doc.title=Winner
agent close second
```

```screens id=failed-events
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
mark
fault disk-full document
!rename_screen title=Refused
expect last.error.code=storage last.error.message has "Disk full" events.revisions=+0 doc.rev=+0 storage.rev=doc.rev storage.staging=0
rename_screen title=Saved
expect events.revisions=+1 doc.rev=+1 storage.rev=doc.rev
```

```screens id=receipt-lifetime
fault delay-commit 500
begin saving rename_screen title=Durable opId=receipt-run
wait service.commitStage=before-write
op_status opId=receipt-run
expect last.status=accepted
join saving
rename_screen title=Durable opId=receipt-run
expect doc.rev=1 last.status=committed
!rename_screen title=Other opId=receipt-run
expect last.error.code=invalid
service restart
op_status opId=receipt-run
expect last.status=committed last.revision=1 doc.rev=1 storage.rev=1 doc.title=Durable
rename_screen title=Durable opId=receipt-run
expect last.status=committed doc.rev=1
!rename_screen title=Other opId=receipt-run
expect last.error.code=invalid doc.rev=1
```

```screens id=shared-font
service reset
create_screen title=Fonts as=@S
add_object title=A files=fixture:font-a x=0 y=0 height=300 as=@A
read_object itemId=@A format=files
mark font last
mark
add_object title=B files=fixture:font-b x=500 y=0 height=300 as=@B
expect doc.items.size=2 storage.content.files=5 storage.content.files=+2
read_object itemId=@A format=files
expect last.files.1.path=shared.ttf last.files.1.mediaType=font/ttf
read_object itemId=@B format=files
expect last.files.1.path=shared.ttf last.files.1.mediaType=font/ttf last.files.1.hash=mark:font
service restart
expect doc.items.size=2 storage.content.files=5 storage.orphans=0 frames.@A.load=ready frames.@B.load=ready
```

```screens id=bundle-paths
mark
!add_object title=Absolute files=fixture:absolute-path
expect last.error.code=invalid
!add_object title=Traversal files=fixture:traversal-path
expect last.error.code=invalid
!add_object title=Drive files=fixture:dot-drive-path
expect last.error.code=invalid
!add_object title=LinkDescriptor files=fixture:symlink-path
!add_object title=Symlink files=dir:fixture:bundle-symlink
expect doc.rev=+0 events.revisions=+0 storage.content.files=+0 storage.staging=0
```

```screens id=disk-full-document
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
mark
fault disk-full document
!create_screen title=Refused
expect last.message has "Disk full" storage.screens=+0 storage.staging=0
fault disk-full document
drag @A.title by 40,0
expect pending.failed=1 dom.toast has "Disk full" doc.rev=+0 doc.@A.x=0 storage.rev=doc.rev storage.staging=0 events.revisions=+0
toast dismiss
fault disk-full document
!rename_screen title=Refused
expect last.error.code=storage last.error.message has "Disk full" doc.rev=+0 storage.staging=0
rename_screen title=Saved
service restart
expect doc.title=Saved doc.@A.x=0 doc.rev=+1 storage.rev=doc.rev
```

```screens id=disk-full-content
service reset
create_screen title=ContentFault as=@S
mark
fault disk-full content
!add_image title=Refused base64=b64:fixture:noise-g mediaType=image/png width=120 height=90 x=0 y=0
expect last.error.code=storage last.error.message has "Disk full" doc.items.size=0 doc.rev=+0 storage.content.files=+0 storage.staging=0 service.uploads.entries.size=0
fault disk-full content
drop fixture:noise-g at w:0,0
expect pending.failed=1 dom.toast has "Disk full" doc.items.size=0 doc.rev=+0 storage.content.files=+0 storage.staging=0
toast retry
expect doc.items.size=1 doc.rev=+1 pending.size=0 storage.staging=0
service restart
expect doc.items.size=1 storage.rev=doc.rev storage.orphans=0
```

```screens id=damaged-json
service reset
create_screen title=Damaged as=@D
add_object title=Keep files=fixture:modules x=0 y=0 height=300
create_screen title=Healthy as=@S
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
probe thumbnails
use @D
probe thumbnails
use @S
expect storage.thumbs.files=2
mark assets
fault corrupt-document @D json
service restart
wait frames.@A.load=ready
expect storage.damaged=1 storage.collectionSuspended=true storage.content.hashes=mark:assets storage.thumbs.hashes=mark:assets doc.rev=+0 frames.@A.load=ready
list_screens query=Damaged
expect last.screens.0.damaged=true
!get_screen screenId=@D
expect last.message has "This Screen is damaged"
view open damaged screen=@D
get dom --view damaged
expect last.text has "This Screen is damaged" last.text has Library
view close damaged
open_screen screenId=@S
rename_screen title=StillWorks
expect doc.title=StillWorks storage.rev=doc.rev
service reset
expect storage.damaged=0 storage.collectionSuspended=false
```

```screens id=damaged-schema
service reset
create_screen title=Damaged as=@D
add_object title=Keep files=fixture:modules x=0 y=0 height=300
create_screen title=Healthy as=@S
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
probe thumbnails
use @D
probe thumbnails
use @S
expect storage.thumbs.files=2
mark assets
fault corrupt-document @D schema
service restart
expect storage.damaged=1 storage.collectionSuspended=true storage.content.hashes=mark:assets storage.thumbs.hashes=mark:assets
!get_screen screenId=@D
expect last.message has "This Screen is damaged"
rename_screen title=Usable
view open damaged screen=@D
get dom --view damaged
expect last.text has "This Screen is damaged"
view close damaged
expect doc.title=Usable storage.rev=doc.rev
service reset
expect storage.damaged=0 storage.collectionSuspended=false
```

```screens id=crash-content-flush
add_object title=Old files=fixture:plain x=0 y=0 height=300 as=@A
add_comment itemId=@A x=20 y=30 text="Keep this thread"
mark before
fault crash after-content-flush
!add_object title=New files=fixture:modules x=500 y=0 height=300
expect storage.doc=mark:before
service restart
expect storage.doc=mark:before doc.rev=+0 storage.rev=doc.rev storage.staging=0 storage.orphans=0 frames.@A.load=ready
```

```screens id=crash-temp-write
add_object title=Old files=fixture:plain x=0 y=0 height=300 as=@A
add_comment itemId=@A x=20 y=30 text="Keep this thread"
mark before
fault crash after-temp-write
!add_object title=New files=fixture:modules x=500 y=0 height=300
expect storage.doc=mark:before
service restart
expect storage.doc=mark:before doc.rev=+0 storage.rev=doc.rev storage.staging=0 storage.orphans=0 frames.@A.load=ready
```

```screens id=crash-temp-flush
add_object title=Old files=fixture:plain x=0 y=0 height=300 as=@A
add_comment itemId=@A x=20 y=30 text="Keep this thread"
mark before
fault crash after-temp-flush
!add_object title=New files=fixture:modules x=500 y=0 height=300
expect storage.doc=mark:before
service restart
expect storage.doc=mark:before doc.rev=+0 storage.rev=doc.rev storage.staging=0 storage.orphans=0 frames.@A.load=ready
```

```screens id=crash-rename
add_object title=Old files=fixture:plain x=0 y=0 height=300 as=@A
add_comment itemId=@A x=20 y=30 text="Keep this thread"
mark before
fault crash after-rename
!add_object title=New files=fixture:modules x=500 y=0 height=300 as=@B
expect storage.doc.id=mark:before storage.doc.title=mark:before storage.doc.schemaVersion=mark:before storage.doc.createdAt=mark:before storage.doc.items.@A=mark:before storage.doc.strokes=mark:before storage.doc.threads=mark:before storage.doc.revision=+1
mark after storage
service restart
expect storage.doc=mark:after doc.items.size=2 storage.rev=doc.rev storage.staging=0 storage.orphans=0 frames.@A.load=ready
wait frames.@B.load=ready
read_object itemId=@B format=files
expect last.files.size=4 last.files.1.path=app.js last.files.2.content has "modules ok" last.files.3.path=late.js
focus @B
inside @B text "#out"
expect last="modules ok"
```

```screens id=service-discovery
probe discovery tool=list_screens
expect last.adapters=2 last.oneService=true last.starts=1
```

```screens id=service-identity
probe identity
expect last.registryRefused=true last.handshakeRefused=true last.instanceRefused=true last.protocolRefused=true last.validAccepted=true last.requestsSent=0
```

```screens id=service-idle
probe idle
expect last.keptAlive=true last.exitedWhenIdle=true last.registryRemoved=true
```

```screens id=service-port
probe port
expect last.occupied=true last.newPort=true last.recordedPortWorks=true
```

```screens id=service-term
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
mark
fault delay-commit 800
drag @A.title by 40,0 --no-settle
wait service.commitStage=before-write
service terminate
service restart
expect doc.rev=+1 doc.@A.x=40 pending.size=0 storage.rev=doc.rev storage.staging=0 storage.orphans=0
```

```screens id=result-scan
add_object title=A files=fixture:plain height=300 as=@A
read_object itemId=@A format=files
!import_screen path=out:missing.screens
probe results
expect last.scanned>3 last.leaks=0 last.tools has read_object last.controls.siblingRefused=true last.controls.descendantRefused=true last.controls.encodedPathRefused=true last.controls.exactPathAllowed=true last.controls.authoredAllowed=true last.controls.argumentPrefixRefused=true last.controls.canaryRefused=true
rename_screen title="Project /Users/me/design"
get_screen
expect last.title="Project /Users/me/design"
```

```screens id=bundle-normalization
add_object title=Relative files=fixture:dot-paths entry=./index.html x=0 y=0 height=300 as=@A
inside @A text "#out"
expect last="rgb(12, 34, 56)"
update_object itemId=@A files=fixture:dot-paths entry=./index.html expectedRevision=1
read_object itemId=@A format=files
expect last.entry=index.html last.files.1.path=style.css last.files.2.path=app.js
focus @A
inside @A text "#out"
expect last="rgb(12, 34, 56)"
```

```screens id=legacy-bundle-paths
import_screen path=fixture-file:archive-legacy-paths as=@L
use @L
service restart
expect storage.damaged=0 doc.items.size=1 doc.threads.size=0
read_object itemId=legacyitem1 format=files
expect last.files.1.path=C:notes.txt last.files.2.content="old backslash name"
retitle_item itemId=legacyitem1 title=Readable
export_screen path=out:legacy.screens
service reset
import_screen path=out:legacy.screens
use @L
expect doc.@legacyitem1.title=Readable storage.damaged=0
focus @legacyitem1
inside @legacyitem1 text "#legacy"
expect last="Legacy stays readable"
```

```screens id=poster-write-receipt
service reset
create_screen title=Poster as=@S
mark
fault disk-full poster
!add_object title=Poster files=fixture:plain width=413 height=307 opId=poster-full
expect last.error.code=storage doc.rev=+0 events.revisions=+0 storage.staging=0
op_status opId=poster-full
expect last.status=failed last.error.code=storage
!add_object title=Poster files=fixture:plain width=413 height=307 opId=poster-full
expect last.error.code=storage doc.rev=+0 events.revisions=+0
!add_object title=Other files=fixture:plain width=413 height=307 opId=poster-full
expect last.error.code=invalid
add_object title=Poster files=fixture:plain width=413 height=307 opId=poster-ok
expect doc.items.size=1 doc.rev=+1 events.revisions=+1
```

```screens id=damaged-threads
service reset
create_screen title=Damaged as=@D
add_object title=Keep files=fixture:modules x=0 y=0 height=300
add_comment x=20 y=30 text="Preserve the damaged original"
create_screen title=Healthy as=@S
mark assets
fault corrupt-document @D threads
service restart
expect storage.damaged=1 storage.collectionSuspended=true storage.content.hashes=mark:assets
!get_screen screenId=@D
expect last.message has "This Screen is damaged"
rename_screen title=Usable
expect doc.title=Usable
service reset
expect storage.damaged=0
```

## Gotchas

- The content-write fault starts with an empty library so another block's identical image cannot bypass the write through content deduplication.

- The shared-font fixtures already mark their pieces with `data-pid`, so stamping adds no source version. Two entry files, two posters and one shared font are the five committed files.
- `probe thumbnails` reads the real service thumbnail endpoint for the current Screen, ensuring the on-disk cache exists even if the browser already cached the image before a library reset.
- Each process probe uses a separate library and closes every process and socket it starts. The idle probe shortens only the dev service's idle period to 800 ms.
- Disk-full faults raise the OS error at the content or document write, rather than filling the machine's actual disk. The real storage cleanup and public error handling run unchanged.
- Damaged documents remain in place. Since their references cannot be trusted, content and thumbnail collection pauses for the whole library while any remain damaged.
- Recent committed receipts survive restart: 32 per Screen and 256 for the library. Failed receipts stay in memory. An evicted operation's `unknown` is indeterminate; read the Screen before deciding whether to submit again.
- The result scanner allows a caller's explicit export/import path to be echoed, but refuses private library paths and a canary in an unrelated local file. Full-suite tool coverage therefore also covers result scanning for every tool.
