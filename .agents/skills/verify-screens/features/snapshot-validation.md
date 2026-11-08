# Snapshot validation and posters

Before a snapshot commits, the service test-loads it in headless Chrome under the canvas's own host page and CSP, then captures a poster. Only a page that never finishes loading is refused. An update then leaves the previous version live. Everything else commits with warnings. The agent receives the poster image in the tool result and can fetch it again later. Frames that are not live show their poster instead of a gray box.

## Sub-features

- `val-poster`: an add stores a poster, links it to the item and returns it as an image. An update replaces it.
- `val-canvas-poster`: at fit, items with posters are not live and draw the poster, not the placeholder.
- `val-network`: a page that asks the network commits with a `network` warning.
- `val-broken-update`: a page that never loads is refused. An update leaves the old content, poster and live frame untouched.
- `val-fetch`: `get_poster` returns the committed poster after a service restart.
- `val-replay`: a replayed opId returns the original poster and warnings without loading the page again.
- `val-montage`: `get_montage` composes one JPEG of the whole Screen from stored posters with a legend of each item's rect in image pixels; `rect` crops to a world region and `maxSize` caps the longest side.
- `val-no-browser`: without Chrome, the snapshot commits with no poster and an `unchecked` warning.

## How to get to it (user POV)

- An agent calls `add_object`, `update_object`, `get_poster` or `get_montage`. The result shows the poster image and any warnings.
- A person zooms out: items too small to run live show their poster.

## Driving it with screens-cli

```screens id=val-poster
add_object title=Plain files=fixture:plain x=0 y=0 height=400 as=@A
expect last.status=committed doc.@A.poster!=null storage.rev=doc.rev last.poster.hash=doc.@A.poster last.poster.width=390 last.poster.height=400 last.warnings.size=0 last.images.size=1 last.images.0.mimeType=image/jpeg last.images.0.sha256=doc.@A.poster
mark
update_object itemId=@A expectedRevision=1 files=fixture:modules
expect doc.rev=+1 last.poster.hash=doc.@A.poster last.images.0.sha256=doc.@A.poster frames.@A.load=ready
```

```screens id=val-canvas-poster
add_object title=Near files=fixture:plain x=0 y=0 as=@A
add_object title=Far files=fixture:plain x=6000 y=0 as=@B
fit
expect frames.@A.live=false frames.@B.live=false dom.@A.surface=poster dom.@A.poster=doc.@A.poster dom.@B.surface=poster
shot @A as=poster-not-live
```

```screens id=val-network
add_object title=Net files=fixture:network x=0 y=0 height=400 as=@N
expect last.status=committed doc.@N.poster!=null last.warnings.size=1 last.warnings.0.code=network last.warnings.0.message~=example.com last.images.size=1
```

```screens id=val-broken-update
add_object title=Keep files=fixture:plain x=0 y=0 height=400 as=@A
expect frames.@A.load=ready
mark
!update_object itemId=@A expectedRevision=1 files=fixture:never-loads
expect doc.rev=+0 storage.rev=doc.rev op.last.status=failed op.last.error.code=not-loaded frames.@A.gen=+0 frames.@A.load=ready dom.@A.surface=live
!add_object title=Stuck files=fixture:never-loads
expect doc.rev=+0 doc.items.size=1 op.last.error.code=not-loaded
```

```screens id=val-fetch
add_object title=Look files=fixture:modules x=0 y=0 height=400 as=@A
service restart
get_poster itemId=@A
expect last.posterHash=doc.@A.poster last.contentVersion=doc.@A.cv last.images.size=1 last.images.0.mimeType=image/jpeg last.images.0.sha256=doc.@A.poster
```

```screens id=val-replay
add_object title=Once files=fixture:network opId=v-val-1 height=300 as=@A
mark
add_object title=Once files=fixture:network opId=v-val-1 height=300
expect doc.rev=+0 last.itemId=@A last.poster.hash=doc.@A.poster last.warnings.0.code=network last.images.0.sha256=doc.@A.poster
```

```screens id=val-montage
add_object title=Left files=fixture:plain x=0 y=0 width=400 height=600 as=@A
add_object title=Right files=fixture:plain x=1000 y=0 width=400 height=600 as=@B
get_montage maxSize=800
expect last.width=800 last.items.size=2 last.items.0.id=@B last.items.1.rect.x=28 last.items.1.rect.y=28 last.images.size=1 last.images.0.mimeType=image/jpeg
get_montage rect='{"x":900,"y":-100,"w":600,"h":800}' maxSize=400
expect last.width=300 last.height=400 last.scale=0.5 last.items.size=1 last.items.0.id=@B last.items.0.rect.x=50 last.items.0.rect.y=50 last.items.0.rect.w=200
```

```screens id=val-no-browser
fault no-browser
add_object title=Blind files=fixture:plain x=0 y=0 height=300 as=@A
expect last.status=committed doc.@A.poster=null last.poster=null last.warnings.0.code=unchecked last.images.size=0 frames.@A.load=ready dom.@A.surface=live
```

## Gotchas

- A refusal takes the full load timeout (5 s) before it returns.
- The check runs before the Screen's commit queue, so a slow page never delays a drag. A snapshot can commit after an edit sent while it loaded.
- `fault no-browser` takes the same branch as a failed Chrome launch. A machine with no Chrome at all is an environment check this fault does not replace.
- A page that throws an uncaught error commits with a `script-error` warning, but the canvas then hides its live frame and shows only the poster.
- The poster is captured at the item's size when it is checked. Resizing an item later does not re-render it.
