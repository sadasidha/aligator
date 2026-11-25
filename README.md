# Tauri + Vanilla

This template should help get you started developing with Tauri in vanilla HTML, CSS and Javascript.

## Startup address

Aligator fills the address bar with `currentPath` from `~/.aligtor/settings.json` on startup.
If the settings file is missing or invalid, the address bar starts at your home directory.
Every folder you successfully open is saved back to that file, so the next launch starts there.

## Video preview

Videos are previewed with a bundled libVLC, so formats the system webview can't play
(mkv, avi, wmv, flv, …) still work. Run `./scripts/fetch-vlc.sh` once to download libVLC
and its plugins into `src-tauri/vlc/` (`run.sh` does this automatically when it is missing);
`tauri build` bundles that folder as an app resource. The script covers macOS only; on Windows
copy `libvlc.dll`, `libvlccore.dll` and `plugins/` from the VLC win64 zip into
`src-tauri/vlc/lib` and `src-tauri/vlc/plugins`.

The first launch after downloading can take a minute while macOS checks the new plugins.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
