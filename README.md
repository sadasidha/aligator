# Tauri + Vanilla

This template should help get you started developing with Tauri in vanilla HTML, CSS and Javascript.

## Startup address

Image Editor fills the address bar with `currentPath` from `~/.aligtor/settings.json` on startup.
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

## PDF preview

PDFs are rendered with Mozilla's [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0), vendored
into `src/vendor/pdfjs/` by `./scripts/fetch-pdfjs.sh` (`run.sh` and `build.sh` run it when missing).
In the preview, Up/Down (or Page Up/Page Down) move between pages, Home/End jump to the first/last
page, and the page box in the toolbar jumps to any page number.

The rotate and flip buttons edit only the page being shown; edits on several pages are kept until
Save / Save as…. Saving (with [lopdf](https://crates.io/crates/lopdf)) appends an incremental update
holding just the changed pages, so every other page stays byte-for-byte unchanged and text stays
vector. Password-protected PDFs cannot be edited.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
