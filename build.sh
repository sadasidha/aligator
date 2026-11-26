#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

[ -f src/vendor/pdfjs/pdf.min.mjs ] || ./scripts/fetch-pdfjs.sh
rm -f src-tauri/target/release/bundle/macos/rw.*.dmg
cargo tauri build --bundles dmg
