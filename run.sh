[ -d src-tauri/vlc/plugins ] || ./scripts/fetch-vlc.sh
cargo tauri dev
