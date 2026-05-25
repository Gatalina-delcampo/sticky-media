// Sticky Media — GNOME Shell Extension
// Places floating images and animated GIFs on the desktop background.
//
// Data model per sticker: { id, imagePath, x, y, scale }
//   - scale is percentage of original dimensions (10–400)
//   - x, y are top-left anchor in screen pixels
//   - widget is immutable after creation (no applyConfig)
//
// Rendering: Cairo scales the source pixbuf on every repaint.
//   No intermediate pixbufs → zero per-frame memory allocation.
//
// Data flow: prefs.js writes stickers.json → file monitor → reloads widgets.
//   This file NEVER writes to disk. Prefs is the sole persistence layer.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gdk from 'gi://Gdk?version=4.0';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.stickymedia';
const CFG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'stickymedia']);
const STICKERS_FILE = GLib.build_filenamev([CFG_DIR, 'stickers.json']);

const DEBUG = false;
function logd(msg) { if (DEBUG) log(`[StickyMedia] ${msg}`); }

function _readStickers() {
    const f = Gio.File.new_for_path(STICKERS_FILE);
    if (!f.query_exists(null)) return [];
    try {
        const [ok, contents] = f.load_contents(null);
        if (ok) return JSON.parse(new TextDecoder().decode(contents));
    } catch (e) { log(`[StickyMedia] read error: ${e}`); }
    return [];
}

class StickerWidget {
    constructor(cfg) {
        this.id = cfg.id;
        this._cfg = cfg;
        this._actor = null;
        this._drawArea = null;
        this._currentPixbuf = null;
        this._originalPixbuf = null;
        this._gifIter = null;
        this._gifTimeoutId = 0;
        this._origW = 0;
        this._origH = 0;
        this._displayW = 0;
        this._displayH = 0;
        this._buildUI();
    }

    get actor() { return this._actor; }
    get cfg() { return this._cfg; }

    _buildUI() {
        this._actor = new Clutter.Actor({
            reactive: false,
            x: this._cfg.x,
            y: this._cfg.y,
            width: 1,
            height: 1,
        });
        this._drawArea = new St.DrawingArea({ reactive: false, x: 0, y: 0 });
        this._drawArea.set_size(1, 1);

        // Cairo-based rendering: scales the source pixbuf to fit the drawArea
        // on every repaint. No intermediate pixbufs — zero per-frame allocation.
        this._drawArea.connect('repaint', () => {
            if (!this._currentPixbuf) return;
            const cr = this._drawArea.get_context();
            const pw = this._currentPixbuf.get_width();
            const ph = this._currentPixbuf.get_height();
            const alloc = this._drawArea.get_allocation_box();
            const aw = alloc.x2 - alloc.x1;
            const ah = alloc.y2 - alloc.y1;
            if (aw <= 0 || ah <= 0) return;
            const s = Math.min(aw / pw, ah / ph);
            const rw = Math.round(pw * s);
            const rh = Math.round(ph * s);
            cr.save();
            cr.translate((aw - rw) / 2, (ah - rh) / 2);
            cr.scale(s, s);
            Gdk.cairo_set_source_pixbuf(cr, this._currentPixbuf, 0, 0);
            cr.paint();
            cr.restore();
        });
        this._actor.add_child(this._drawArea);
    }

    _stopGif() {
        if (this._gifTimeoutId > 0) {
            GLib.source_remove(this._gifTimeoutId);
            this._gifTimeoutId = 0;
        }
        this._gifIter = null;
    }

    // Store the source pixbuf and trigger a repaint. Cairo handles scaling.
    // For static images: uses _originalPixbuf (set once, reused forever).
    // For GIF frames: each frame's pixbuf replaces the previous, GC cleans up.
    _display(pixbuf) {
        if (!this._drawArea || !pixbuf) return;
        if (!this._originalPixbuf && !this._gifIter) this._originalPixbuf = pixbuf;
        this._currentPixbuf = this._gifIter ? pixbuf : this._originalPixbuf;
        this._drawArea.queue_repaint();
    }

    loadImage(path) {
        this._stopGif();
        this._currentPixbuf = null;
        this._originalPixbuf = null;
        this._origW = 0;
        this._origH = 0;
        if (this._drawArea) this._drawArea.queue_repaint();
        if (!path) return;

        try {
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null)) return;
            const [bytes] = file.load_bytes(null);
            const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
            const anim = GdkPixbuf.PixbufAnimation.new_from_stream(stream, null);
            let pb;
            if (anim.is_static_image()) {
                pb = anim.get_static_image();
                this._originalPixbuf = pb;
            } else {
                this._gifIter = anim.get_iter(null);
                pb = this._gifIter.get_pixbuf();
            }
            if (!pb) return;
            this._origW = pb.get_width();
            this._origH = pb.get_height();
            // Calculate display size from scale percentage, clamp 50–2048
            this._displayW = Math.max(50, Math.min(2048, Math.round(this._origW * this._cfg.scale / 100)));
            this._displayH = Math.max(50, Math.min(2048, Math.round(this._origH * this._cfg.scale / 100)));
            this._actor.set_size(this._displayW, this._displayH);
            this._drawArea.set_size(this._displayW, this._displayH);
            this._display(pb);
            if (!anim.is_static_image() && this._gifIter) this._scheduleGif();
        } catch (e) { log(`[StickyMedia] ${this.id} load error: ${e}`); }
    }

    // Recursive timer-based GIF frame loop.
    // Native delay clamped to ≥16ms. Delays under 20ms → 100ms (malformed GIF guard).
    // To add speed control: divide delay by a multiplier (e.g. delay / speed).
    _scheduleGif() {
        if (!this._gifIter) return;
        let delay = Math.max(16, this._gifIter.get_delay_time());
        if (delay < 20) delay = 100;
        this._gifTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            if (!this._gifIter) return GLib.SOURCE_REMOVE;
            this._gifIter.advance(null);
            const pb = this._gifIter.get_pixbuf();
            if (pb) this._display(pb);
            this._gifTimeoutId = 0;
            this._scheduleGif();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._stopGif();
        this._currentPixbuf = null;
        this._originalPixbuf = null;
        if (this._actor) {
            this._actor.destroy();
            this._actor = null;
        }
    }
}

// StickerManager — read-only persistence layer.
// Reads stickers.json on startup, creates widgets, monitors file for changes.
// NEVER writes to disk. Prefs.js is the sole writer.
class StickerManager {
    constructor(settings) {
        this._settings = settings;
        this._widgets = new Map();
        this._reloadTimeoutId = 0;

        const stickers = _readStickers();
        for (const s of stickers) this._createWidget(s);
        logd(`StickerManager: ${this._widgets.size} stickers loaded`);

        const f = Gio.File.new_for_path(STICKERS_FILE);
        this._monitor = f.monitor(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', (mon, file, other, eventType) => {
            if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT)
                this._scheduleReload();
        });
    }

    // Debounced reload: cancels any pending reload, schedules a new one.
    // 500ms delay coalesces rapid prefs writes into a single widget refresh.
    _scheduleReload() {
        if (this._reloadTimeoutId > 0)
            GLib.source_remove(this._reloadTimeoutId);
        this._reloadTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._reloadTimeoutId = 0;
            this.reloadStickers();
            return GLib.SOURCE_REMOVE;
        });
    }

    _createWidget(cfg) {
        if (this._widgets.has(cfg.id)) return;
        const w = new StickerWidget(cfg);
        Main.layoutManager._backgroundGroup.add_child(w.actor);
        this._widgets.set(cfg.id, w);
        w.loadImage(cfg.imagePath);
    }

    reloadStickers() {
        const stickers = _readStickers();
        const existingIds = new Set(this._widgets.keys());
        const newIds = new Set(stickers.map(s => s.id));

        for (const id of existingIds) {
            if (!newIds.has(id)) {
                const w = this._widgets.get(id);
                if (w) { w.destroy(); this._widgets.delete(id); }
            }
        }
        for (const s of stickers) {
            if (!this._widgets.has(s.id))
                this._createWidget(s);
        }
    }

    destroy() {
        if (this._reloadTimeoutId > 0) {
            GLib.source_remove(this._reloadTimeoutId);
            this._reloadTimeoutId = 0;
        }
        if (this._monitor) this._monitor.cancel();
        for (const w of this._widgets.values()) w.destroy();
        this._widgets.clear();
    }
}

export default class StickyMediaExtension extends Extension {
    enable() {
        this._settings = this.getSettings(SCHEMA_ID);
        this._manager = new StickerManager(this._settings);
    }
    disable() {
        if (this._manager) { this._manager.destroy(); this._manager = null; }
        this._settings = null;
    }
}
