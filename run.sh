[ -d src-tauri/vlc/plugins ] || ./scripts/fetch-vlc.sh
[ -f src/vendor/pdfjs/pdf.min.mjs ] || ./scripts/fetch-pdfjs.sh
cargo tauri dev
