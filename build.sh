#!/bin/bash
set -e
cd "$(dirname "$0")"

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/sticky-media@uwu"
UUID="sticky-media@uwu"

build() {
    echo "→ Compiling schemas…"
    glib-compile-schemas schemas/
    echo "→ Packaging zip…"
    rm -f "../${UUID}.zip"
    zip -r "../${UUID}.zip" . -x "schemas/gschemas.compiled" ".gitignore" > /dev/null
    echo "✓ Build complete: ../${UUID}.zip"
}

install() {
    echo "→ Installing to $EXT_DIR…"
    mkdir -p "$EXT_DIR"
    cp extension.js prefs.js metadata.json stylesheet.css "$EXT_DIR/"
    cp -r schemas "$EXT_DIR/"
    glib-compile-schemas "$EXT_DIR/schemas/"
    echo "✓ Installed. Log out and back in to apply."
}

clean() {
    echo "→ Cleaning…"
    rm -f "../${UUID}.zip"
    rm -f schemas/gschemas.compiled
    echo "✓ Clean."
}

case "${1:-build}" in
    build)   build ;;
    install) install ;;
    clean)   clean ;;
    *)
        echo "Usage: $0 {build|install|clean}"
        echo "  build   — compile schemas + create zip"
        echo "  install — copy to ~/.local/share/gnome-shell/extensions/"
        echo "  clean   — remove zip + compiled schema"
        ;;
esac
