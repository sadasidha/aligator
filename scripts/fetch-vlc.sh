#!/usr/bin/env bash
# Downloads libVLC and its plugins into src-tauri/vlc so they can be bundled with the app.
set -euo pipefail

VLC_VERSION="${VLC_VERSION:-3.0.24}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src-tauri/vlc"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) DMG="vlc-$VLC_VERSION-arm64.dmg" ;;
  Darwin-x86_64) DMG="vlc-$VLC_VERSION-intel64.dmg" ;;
  *) echo "Only macOS is scripted. On Windows, copy libvlc.dll, libvlccore.dll and plugins/ from the VLC win64 zip into $DEST/lib and $DEST/plugins." >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
MOUNT="$WORK/mount"
trap 'hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; rm -rf "$WORK"' EXIT

curl -fL --progress-bar -o "$WORK/$DMG" "https://get.videolan.org/vlc/$VLC_VERSION/macosx/$DMG"
hdiutil attach "$WORK/$DMG" -nobrowse -readonly -quiet -mountpoint "$MOUNT"

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$MOUNT/VLC.app/Contents/MacOS/lib" "$DEST/lib"
cp -R "$MOUNT/VLC.app/Contents/MacOS/plugins" "$DEST/plugins"
echo "$VLC_VERSION" > "$DEST/VERSION"
echo "libVLC $VLC_VERSION installed in $DEST"
