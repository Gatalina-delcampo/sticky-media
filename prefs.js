// Sticky Media — Preferences (GTK4 + Adwaita)
//
// Data flow: reads stickers.json on open, writes on every Add/Remove.
// No auto-save. The UI grid never auto-refreshes after Add/Remove —
// Add and Remove buttons are always visible to avoid stale-row complexity.
//
// Position presets: use Gdk.Display monitor geometry to calculate
// exact screen coordinates based on the sticker's display dimensions.

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Adw from 'gi://Adw?version=1';

const SCHEMA_ID = 'org.gnome.shell.extensions.stickymedia';
const CFG_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'stickymedia']);
const STICKERS_FILE = GLib.build_filenamev([CFG_DIR, 'stickers.json']);
const THUMB_SIZE = 96;

const SIZE_PRESETS = [10, 25, 50, 75, 100, 150, 200];
const POS_PRESETS = ['Center', 'Top-Left', 'Top-Right', 'Bottom-Left', 'Bottom-Right', 'Custom'];

function _read() {
    const f = Gio.File.new_for_path(STICKERS_FILE);
    if (!f.query_exists(null)) return [];
    try {
        const [ok, c] = f.load_contents(null);
        if (ok) return JSON.parse(new TextDecoder().decode(c));
    } catch (e) { log(`[StickyMedia] read error: ${e}`); }
    return [];
}

function _write(arr) {
    try {
        const d = Gio.File.new_for_path(CFG_DIR);
        if (!d.query_exists(null)) d.make_directory_with_parents(null);
        Gio.File.new_for_path(STICKERS_FILE).replace_contents(
            JSON.stringify(arr, null, 2), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (e) { log(`[StickyMedia] write error: ${e}`); }
}

function scanFolder(p) {
    const r = [];
    try {
        const e = Gio.File.new_for_path(p).enumerate_children(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        let i;
        const ex = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
        while ((i = e.next_file(null))) {
            if (i.get_file_type() === Gio.FileType.REGULAR &&
                ex.some(x => i.get_name().toLowerCase().endsWith(x)))
                r.push({ name: i.get_name(), path: p + '/' + i.get_name() });
        }
        e.close(null);
    } catch (e) { log(`[StickyMedia] scanFolder error: ${e}`); }
    return r;
}

// Calculate screen position from a preset index and sticker display size.
// Loads the image to get original dimensions, computes display size from scale%,
// then uses primary monitor geometry to position the sticker.
function calcPosition(presetIdx, imagePath, scalePerc) {
    let origW = 100, origH = 100;
    try {
        const f = Gio.File.new_for_path(imagePath);
        const [b] = f.load_bytes(null);
        const pb = GdkPixbuf.PixbufAnimation.new_from_stream(
            Gio.MemoryInputStream.new_from_bytes(b), null).get_static_image();
        origW = pb.get_width();
        origH = pb.get_height();
    } catch (e) { log(`[StickyMedia] size calc error: ${e}`); }

    const dw = Math.max(50, Math.min(2048, Math.round(origW * scalePerc / 100)));
    const dh = Math.max(50, Math.min(2048, Math.round(origH * scalePerc / 100)));
    const margin = 20;
    let x = 100, y = 100;

    // Use primary monitor geometry. Gdk.Display may be null in headless sessions.
    try {
        const display = Gdk.Display.get_default();
        if (display) {
            const monitors = display.get_monitors();
            if (monitors.get_n_items() > 0) {
                const mon = monitors.get_item(0);
                const g = mon.get_geometry();
                switch (presetIdx) {
                    case 0: x = g.x + Math.round((g.width - dw) / 2);
                            y = g.y + Math.round((g.height - dh) / 2); break;
                    case 1: x = g.x + margin; y = g.y + margin; break;
                    case 2: x = g.x + g.width - dw - margin; y = g.y + margin; break;
                    case 3: x = g.x + margin; y = g.y + g.height - dh - margin; break;
                    case 4: x = g.x + g.width - dw - margin;
                            y = g.y + g.height - dh - margin; break;
                }
            }
        }
    } catch (e) { log(`[StickyMedia] monitor error: ${e}`); }
    return { x, y };
}

export default class StickyMediaPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings(SCHEMA_ID);
        let _stickers = _read();

        function _save() {
            if (Array.isArray(_stickers)) _write(_stickers);
        }

        // ── Media Page ──
        const mediaPage = new Adw.PreferencesPage({
            title: 'Media',
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(mediaPage);

        const fldGrp = new Adw.PreferencesGroup({ title: 'Source Folder' });
        mediaPage.add(fldGrp);
        const fldBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        fldGrp.add(fldBox);
        const browseBtn = new Gtk.Button({ label: 'Select Folder', hexpand: true });
        const picsBtn = new Gtk.Button({ label: 'Use /Pictures', hexpand: true });
        fldBox.append(browseBtn);
        fldBox.append(picsBtn);

        const gridCtr = new Adw.PreferencesGroup({ title: 'Media' });
        mediaPage.add(gridCtr);

        let _entries = [], _lastFolder = '';

        // Grid is built once per folder selection and never refreshed.
        // Add/Remove buttons always visible — avoids stale-UI complexity.
        function refreshGrid(fp) {
            if (fp === _lastFolder) return;
            _lastFolder = fp;
            settings.set_string('selected-folder', fp);
            _entries = scanFolder(fp);

            const toRemove = [];
            let c = gridCtr.get_first_child();
            while (c) { toRemove.push(c); c = c.get_next_sibling(); }
            for (const r of toRemove) {
                try { gridCtr.remove(r); } catch (e) { log(`[StickyMedia] remove error: ${e}`); }
            }
            if (!_entries.length) {
                gridCtr.add(new Adw.ActionRow({ title: 'No images found in this folder' }));
                return;
            }

            for (const e of _entries) {
                const row = new Adw.ActionRow({ title: e.name });
                let pb = null;
                try {
                    const f = Gio.File.new_for_path(e.path);
                    const [b] = f.load_bytes(null);
                    pb = GdkPixbuf.PixbufAnimation.new_from_stream(
                        Gio.MemoryInputStream.new_from_bytes(b), null)
                        .get_static_image()
                        .scale_simple(THUMB_SIZE, THUMB_SIZE, GdkPixbuf.InterpType.BILINEAR);
                } catch (e) { log(`[StickyMedia] thumbnail error: ${e}`); }
                const img = new Gtk.Image({ pixel_size: THUMB_SIZE });
                if (pb) {
                    try { img.set_from_pixbuf(pb); } catch (e) {
                        log(`[StickyMedia] set thumbnail error: ${e}`);
                        img.set_from_icon_name('image-x-generic-symbolic');
                    }
                } else {
                    img.set_from_icon_name('image-x-generic-symbolic');
                }
                row.add_prefix(img);

                const btns = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });

                const addBtn = new Gtk.Button({ label: 'Add', valign: Gtk.Align.CENTER });
                addBtn.add_css_class('flat');
                addBtn.connect('clicked', () => openAddDialog(e.path));
                btns.append(addBtn);

                // Remove-all: deletes every sticker with this image path.
                const remBtn = new Gtk.Button({ label: 'Remove', valign: Gtk.Align.CENTER });
                remBtn.add_css_class('flat');
                remBtn.connect('clicked', () => {
                    _stickers = _stickers.filter(s => s.imagePath !== e.path);
                    _save();
                });
                btns.append(remBtn);

                row.add_suffix(btns);
                gridCtr.add(row);
            }
        }

        // ── Add Dialog ──
        function openAddDialog(imagePath) {
            const dialog = new Gtk.Window({
                title: 'Add Sticker',
                modal: true,
                transient_for: window,
                default_width: 340,
            });
            const hdr = new Gtk.HeaderBar();
            dialog.set_titlebar(hdr);

            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 12,
                margin_top: 16,
                margin_bottom: 16,
                margin_start: 16,
                margin_end: 16,
            });

            const sizeLabel = new Gtk.Label({ label: 'Size (% of original)', xalign: 0, margin_top: 4 });
            box.append(sizeLabel);
            const sizeStrings = [...SIZE_PRESETS.map(p => `${p}%`), 'Custom…'];
            const sizeStore = new Gtk.StringList({ strings: sizeStrings });
            const sizeDrop = new Gtk.DropDown({ model: sizeStore });
            sizeDrop.set_selected(2); // 50%
            box.append(sizeDrop);

            const sizeEntry = new Gtk.Entry({
                placeholder_text: '10 — 400',
                input_purpose: Gtk.InputPurpose.DIGITS,
            });
            box.append(sizeEntry);
            sizeEntry.set_visible(false);

            sizeEntry.connect('changed', () => {
                const t = sizeEntry.get_text().replace(/[^0-9]/g, '');
                if (t !== sizeEntry.get_text()) sizeEntry.set_text(t);
            });

            sizeDrop.connect('notify::selected', () => {
                sizeEntry.set_visible(sizeDrop.get_selected() === SIZE_PRESETS.length);
            });

            const posLabel = new Gtk.Label({ label: 'Position', xalign: 0, margin_top: 8 });
            box.append(posLabel);
            const posStore = new Gtk.StringList({ strings: POS_PRESETS });
            const posDrop = new Gtk.DropDown({ model: posStore });
            box.append(posDrop);

            const xEntry = new Gtk.Entry({ placeholder_text: 'X', input_purpose: Gtk.InputPurpose.DIGITS });
            const yEntry = new Gtk.Entry({ placeholder_text: 'Y', input_purpose: Gtk.InputPurpose.DIGITS });
            const customPosBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
            customPosBox.append(xEntry);
            customPosBox.append(yEntry);
            customPosBox.set_visible(false);
            box.append(customPosBox);

            posDrop.connect('notify::selected', () => {
                customPosBox.set_visible(posDrop.get_selected() === 5);
            });

            xEntry.connect('changed', () => {
                const t = xEntry.get_text().replace(/[^0-9]/g, '');
                if (t !== xEntry.get_text()) xEntry.set_text(t);
            });
            yEntry.connect('changed', () => {
                const t = yEntry.get_text().replace(/[^0-9]/g, '');
                if (t !== yEntry.get_text()) yEntry.set_text(t);
            });

            const btnBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                halign: Gtk.Align.END,
                margin_top: 16,
            });
            const cancelBtn = new Gtk.Button({ label: 'Cancel' });
            cancelBtn.connect('clicked', () => dialog.close());
            const okBtn = new Gtk.Button({ label: 'OK' });
            okBtn.add_css_class('suggested-action');
            okBtn.connect('clicked', () => {
                const sizeIdx = sizeDrop.get_selected();
                let sizePerc;
                if (sizeIdx < SIZE_PRESETS.length) {
                    sizePerc = SIZE_PRESETS[sizeIdx];
                } else {
                    sizePerc = parseInt(sizeEntry.get_text()) || 50;
                    sizePerc = Math.max(10, Math.min(400, sizePerc));
                }

                const posIdx = posDrop.get_selected();
                let x, y;
                if (posIdx === 5) {
                    x = parseInt(xEntry.get_text()) || 100;
                    y = parseInt(yEntry.get_text()) || 100;
                } else {
                    const pos = calcPosition(posIdx, imagePath, sizePerc);
                    x = pos.x;
                    y = pos.y;
                }

                const sticker = {
                    id: `m${Date.now()}`,
                    imagePath: imagePath,
                    x: Math.max(0, x),
                    y: Math.max(0, y),
                    scale: sizePerc,
                };

                _stickers.push(sticker);
                _save();
                dialog.close();
            });
            btnBox.append(cancelBtn);
            btnBox.append(okBtn);
            box.append(btnBox);

            dialog.set_child(box);
            dialog.show();
        }

        browseBtn.connect('clicked', () => {
            const d = new Gtk.FileChooserNative({
                title: 'Select Media Folder',
                action: Gtk.FileChooserAction.SELECT_FOLDER,
                accept_label: 'Open',
                cancel_label: 'Cancel',
                modal: true,
            });
            const p = settings.get_string('selected-folder');
            if (p) d.set_current_folder(Gio.File.new_for_path(p));
            d.connect('response', (dlg, r) => {
                if (r === Gtk.ResponseType.ACCEPT) {
                    const f = dlg.get_file();
                    if (f) refreshGrid(f.get_path());
                }
                dlg.destroy();
            });
            d.show();
        });
        picsBtn.connect('clicked', () => refreshGrid(GLib.get_home_dir() + '/Pictures'));
    }
}
