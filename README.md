# Sticky Media

Place floating images and animated GIFs on your GNOME desktop.

Supports PNG, JPG, GIF, WebP, BMP, and SVG.

## Requirements

GNOME Shell 45–50

## Install

```bash
# Clone or copy to extensions directory
cp -r sticky-media@uwu ~/.local/share/gnome-shell/extensions/

# Compile the settings schema
glib-compile-schemas ~/.local/share/gnome-shell/extensions/sticky-media@uwu/schemas/
```

Log out and back in, then enable:

```bash
gnome-extensions enable sticky-media@uwu
```

## Usage

1. Open **Sticky Media** preferences from the Extensions app
2. Browse to a folder containing images
3. Click **Add** — choose a size percentage and a screen position
4. Click **Remove** to delete all instances of an image

## Uninstall

```bash
rm -rf ~/.local/share/gnome-shell/extensions/sticky-media@uwu
rm -rf ~/.config/stickymedia
```

## Build

```bash
./build.sh         # compile schemas + package zip
./build.sh install # install to local extensions directory
./build.sh clean   # remove build artifacts
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md).

## License

MIT — free and open source
