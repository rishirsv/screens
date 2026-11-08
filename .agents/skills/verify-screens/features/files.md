# Files: uploads, export and import

Every file reaches the service through authenticated upload operations, over the socket or the Codex MCP bridge. Uploads are keyed by SHA-256 and size, and the retained byte count determines the resume point. A dropped connection or an adapter restart resumes where it stopped, and a corrupted file is refused. Export writes one versioned file with a Screen and every file it uses. Import restores it with the same IDs, and refuses a Screen the library already has.

## Sub-features

- `upload-dedupe`: content already stored sends no bytes.
- `upload-resume`: a socket dropped mid-upload resumes, and no byte is sent twice.
- `upload-resume-adapter`: an upload left half done by a failed call resumes after the adapter restarts.
- `upload-corrupt`: a file that arrives corrupted is refused and nothing is stored.
- `upload-expire`: a half-finished upload expires.
- `upload-restart`: a service restart clears half-finished uploads, and the retry starts over.
- `export-roundtrip`: export, an empty library, import: the same Screen, item, stroke, thread and comment IDs, posters as exported, and a replayed import returns its receipt.
- `import-exists`: importing a Screen the library has is refused, and says whether it is identical.
- `import-corrupt`: a file corrupted on the way in refuses the whole import.
- `import-reused-opid`: an operation ID already used for one import cannot import a different file.
- `import-damaged`: an export whose bytes were damaged on disk is refused before anything is uploaded.
- `import-legacy-link`: a Screen whose snapshot names a source image deleted before links were cleared still imports, link and all.
- `export-source-link`: a snapshot's link to the image it recreates survives export and import.
- `import-format`: an unknown export version is refused before anything is uploaded.
- `export-no-clobber`: export never replaces a file that is not a Screens export.

## How to get to it (user POV)

- An agent calls `export_screen` and `import_screen` with a local path. Its `add_object`, `update_object` and `add_image` calls upload through the same path.
- The person drops or pastes images on the canvas (see [Image drop and paste](./image-drop.md)), which also uploads through it.

## Driving it with screens-cli

```screens id=upload-dedupe
add_image title=A base64=b64:fixture:noise-a mediaType=image/png width=120 height=90 x=0 y=0
mark
add_image title=B base64=b64:fixture:noise-a mediaType=image/png width=120 height=90 x=200 y=0
expect doc.items.size=2 service.uploads.offered=+0 storage.content.files=+0
```

```screens id=upload-resume
fault drop-upload after=2
mark
add_image title=N base64=b64:fixture:noise-b mediaType=image/png width=120 height=90 x=0 y=0
expect doc.rev=+1 service.uploads.offered=+3241953 service.uploads.entries.size=0 storage.staging=0
```

```screens id=upload-resume-adapter
fault fail-upload after=2
mark
!add_image title=M base64=b64:fixture:noise-c mediaType=image/png width=120 height=90 x=0 y=0 opId=resume-1
expect doc.rev=+0 service.uploads.entries.size=1 service.uploads.entries.0.held=1048576
agent restart
add_image title=M base64=b64:fixture:noise-c mediaType=image/png width=120 height=90 x=0 y=0 opId=resume-1
expect doc.rev=+1 service.uploads.offered=+3241953 service.uploads.entries.size=0
```

```screens id=upload-corrupt
fault corrupt-upload
mark
!add_image title=C base64=b64:fixture:noise-d mediaType=image/png width=120 height=90 x=0 y=0
expect doc.rev=+0 storage.content.files=+0 storage.staging=0 service.uploads.entries.size=0
add_image title=C base64=b64:fixture:noise-d mediaType=image/png width=120 height=90 x=0 y=0
expect doc.rev=+1 storage.content.files=+1
```

```screens id=upload-expire
fault fail-upload after=2
!add_image title=E base64=b64:fixture:noise-e mediaType=image/png width=120 height=90 x=0 y=0
expect service.uploads.entries.size=1 storage.staging=1
fault expire-uploads
expect service.uploads.entries.size=0 storage.staging=0
```

```screens id=upload-restart
fault fail-upload after=2
!add_image title=R base64=b64:fixture:noise-f mediaType=image/png width=120 height=90 x=0 y=0 opId=restart-1
expect storage.staging=1
service restart
expect storage.staging=0 service.uploads.entries.size=0
mark
add_image title=R base64=b64:fixture:noise-f mediaType=image/png width=120 height=90 x=0 y=0 opId=restart-1
expect doc.rev=+1 service.uploads.offered=+3241953
```

```screens id=export-roundtrip
add_object title=A files=fixture:plain x=0 y=0 height=300 as=@A
add_image title=I base64=b64:fixture:png mediaType=image/png width=320 height=240 x=500 y=0 as=@I
add_comment itemId=@A x=20 y=30 text="Tighten this" as=@T
reply_comment threadId=@T text="On it"
tool pencil
draw @A+50,50 by 40,10 30,20 as=@K
tool move
mark
export_screen path=out:round.screens
expect last.revision=doc.rev last.files=3
service reset
list_screens
expect last.screens.size=0
import_screen path=out:round.screens opId=round-1
expect last.status=committed last.screenId=@S
import_screen path=out:round.screens opId=round-1
expect last.status=committed last.revision=5
use @S
expect doc.rev=+0 doc.items.size=2 doc.strokes.size=1 doc.threads.size=1 doc.@A.x=0 doc.@I.x=500 doc.@K.anchor=@A doc.@T.comments=2 doc.@A.poster!=null
wait frames.@A.load=ready
expect storage.orphans=1
service restart
expect storage.orphans=0 doc.rev=+0
```

```screens id=import-exists
add_object title=A files=fixture:plain height=300 as=@A
export_screen path=out:same.screens
mark
!import_screen path=out:same.screens opId=same-1
op_status opId=same-1
expect last.error.code=exists last.error.identical=true doc.rev=+0
retitle_item itemId=@A title=Changed
!import_screen path=out:same.screens opId=same-2
op_status opId=same-2
expect last.error.identical=false doc.@A.title=Changed
```

```screens id=import-corrupt
add_object title=A files=fixture:plain height=300 as=@A
export_screen path=out:corrupt.screens
service reset
fault corrupt-upload
!import_screen path=out:corrupt.screens
list_screens
expect last.screens.size=0 storage.staging=0
import_screen path=out:corrupt.screens
expect last.status=committed last.screenId=@S
```

```screens id=import-reused-opid
add_object title=A files=fixture:plain height=300 as=@A
export_screen path=out:first.screens
service reset
import_screen path=out:first.screens opId=reuse-1
create_screen title=Other as=@O
add_object title=B files=fixture:plain height=300
export_screen path=out:second.screens
!import_screen path=out:second.screens opId=reuse-1
op_status opId=reuse-1
expect last.status=committed last.screenId=@S
```

```screens id=import-damaged
mark
!import_screen path=fixture-file:archive-damaged
expect service.uploads.offered=+0 storage.content.files=+0
```

```screens id=import-legacy-link
import_screen path=fixture-file:archive-legacy-link as=@L
expect last.status=committed
use @L
expect doc.items.size=1 doc.@legacyitem1.sources has deletedimage1
```

```screens id=export-source-link
add_image title=Ref base64=b64:fixture:png mediaType=image/png width=320 height=240 x=500 y=0 as=@I
add_object title=Recreation files=fixture:plain x=0 y=0 height=300 sourceReferenceIds=[@I] as=@A
export_screen path=out:linked.screens
service reset
import_screen path=out:linked.screens
use @S
expect doc.@A.sources has @I doc.@I.kind=img
```

```screens id=import-format
mark
!import_screen path=fixture-file:archive-v99
expect service.uploads.offered=+0 storage.content.files=+0
```

```screens id=export-no-clobber
add_object title=A files=fixture:plain height=300 as=@A
!export_screen path=fixture-file:text
export_screen path=out:twice.screens
export_screen path=out:twice.screens
expect last.revision=doc.rev
```

## Gotchas

- Each `noise-*` fixture is different bytes, about 3.2 MB in four 1 MiB chunks. A block that needs a real upload uses its own seed, because content already stored sends nothing.
- `service reset` moves the library aside and starts on an empty one, with no current Screen. Import keeps the Screen's ID, so `@S` resolves again; `use @S` to show it.
- The import header is uploaded like any file and referenced by no Screen, so it is one orphan until the next restart collects it.
- A format refusal happens in the client before any upload, so it has no receipt and `op_status` says `unknown`.
- An op that names content nobody uploaded fails `missing-content`. No MCP tool or canvas input can send one, so no block drives it.
