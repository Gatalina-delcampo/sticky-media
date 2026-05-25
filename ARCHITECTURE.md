# Sticky Media — Architecture

## Data Model

Each sticker is a plain JSON object in `~/.config/stickymedia/stickers.json`:

```json
{
  "id": "m1712345678",
  "imagePath": "/home/user/Pictures/image.png",
  "x": 640,
  "y": 360,
  "scale": 50
}
```

- **id** — unique timestamp-based string (`m${Date.now()}`)
- **imagePath** — absolute path to the media file
- **x, y** — top-left anchor position in screen pixels
- **scale** — percentage of original image dimensions (10–400)
- The widget is **immutable** after creation. To change size or position, delete and re-create.

## Data Flow

```
prefs.js (sole writer)              extension.js (sole reader)
─────────────────────               ──────────────────────────
reads stickers.json on open         reads stickers.json on startup
modifies _stickers[] in memory      Gio.File.monitor on stickers.json
write on Add/Remove ─────────────→  CHANGES_DONE_HINT triggers _scheduleReload()
                                    debounce 500ms — coalesces rapid writes
                                    creates/destroys StickerWidget instances
```

**Key rules:**
- `extension.js` **never writes to disk**. `_writeStickers()` and `saveStickers()` do not exist.
- `prefs.js` reads once, writes on every Add/Remove. No auto-save, no debounce on the prefs side.
- The file monitor debounce (500ms) prevents reload storms from rapid UI interactions.

## Rendering Pipeline

### Cairo-based scaling (zero per-frame allocation)

```
image loaded → loadImage()
    → GdkPixbuf.PixbufAnimation → detect static vs GIF
    → calculate display size (origW × scale / 100, clamped 50–2048)
    → set Clutter.Actor + St.DrawingArea sizes
    → _display(firstFrame) → stores pixbuf, queues repaint

repaint handler (St.DrawingArea):
    → get Cairo context
    → read allocation box (display dimensions)
    → calculate scale: s = min(aw/pw, ah/ph)
    → cr.translate(center) + cr.scale(s, s)
    → Gdk.cairo_set_source_pixbuf + cr.paint()
    → cière
```

No `scale_simple()` is ever called. The source pixbuf stays at native resolution. Cairo handles the transform on every paint. This means zero intermediate pixbuf allocations per frame — memory usage is limited to the original pixbuf plus Clutter actor overhead (~2 KB per sticker).

### Static images
`_originalPixbuf` is stored once. `_display()` sets `_currentPixbuf = _originalPixbuf`. Subsequent repaints reuse the same source. No caching, no scale tracking needed.

### GIF playback
Each frame advances the iterator, `get_pixbuf()` returns the next frame's raw pixbuf, `_display()` stores it as `_currentPixbuf`, and `queue_repaint()` triggers the Cairo handler. The frame pixbuf is discarded when the next frame arrives (GJS GC handles cleanup).

Frame timing uses a recursive `GLib.timeout_add`:
- Native delay from `gif_iter.get_delay_time()`, clamped to ≥16ms
- Delays under 20ms are set to 100ms (avoids excessive frame rates from malformed GIFs)
- The timer re-schedules itself after each frame

## UI (prefs.js)

### Media Page
- Folder browser: `Gtk.FileChooserNative` or one-click `/Pictures` shortcut
- Thumbnail grid: 96px previews generated via `GdkPixbuf.scale_simple()`
- **Add** button always visible per image → opens Add Dialog
- **Remove** button always visible → removes ALL instances of that image path
- Grid never auto-refreshes after Add/Remove (KISS: buttons always visible to avoid stale UI)

### Add Dialog
- **Size**: dropdown with presets (10%, 25%, 50%, 75%, 100%, 150%, 200%) + Custom… option (freeform 10–400%)
- **Position**: dropdown with presets (Center, Top-Left, Top-Right, Bottom-Left, Bottom-Right) + Custom option (X, Y number inputs)
- Preset positions calculate exact coordinates using `Gdk.Display.get_default().get_monitors().get_item(0).get_geometry()`
- OK writes to stickers.json and closes

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Widget immutable | Eliminates `applyConfig()` and all data-consistency bugs from v0 |
| Remove-all | One action, one predictable result. Re-add if needed |
| Cairo scaling | Zero per-frame memory allocation. Pixbuf stays native, Cairo transforms are GPU-friendly |
| File monitor over GSettings | Dynamic arrays of objects are awkward in GSettings. Plain JSON is simple |
| No auto-refresh grid | GTK4/Adwaita grid refresh requires remove+recreate rows. Keeping buttons always visible avoids this complexity |
| No layer support | All stickers go to `Main.layoutManager._backgroundGroup`. Simpler, no reparenting bugs |

## Extension Points

To **add frame styling**: wrap `_drawArea` in a `St.Widget`, apply CSS via `set_style()`. Frame keys go in the sticker data model and gschema.

To **add multi-monitor support**: enumerate `Gdk.Display.get_monitors()` in prefs, add a monitor selector to the Add dialog. `calcPosition()` already has the geometry math.

To **add GIF speed control**: add a multiplier to `_scheduleGif()` delay calculation and a UI control in prefs.

## Gotchas

- **GJS GC**: never call `GObject.unref()` on pixbufs. Setting references to `null` and letting GC collect is the GJS convention. Explicit unref can double-free.
- **File monitor events**: use `CHANGES_DONE_HINT`, not `CHANGED`. The latter fires twice per write (data + metadata).
- **Monitor geometry in prefs**: `Gdk.Display.get_default()` may return null in headless/SSH sessions. Always guard with try/catch.
- **Schema compilation**: run `glib-compile-schemas schemas/` after any gschema.xml changes. The binary `gschemas.compiled` must be regenerated.
