#!/usr/bin/env bash
# Downloads Mozilla's pdf.js (legacy build, for WebKit) into src/vendor/pdfjs for the PDF preview.
set -euo pipefail

PDFJS_VERSION="${PDFJS_VERSION:-5.4.394}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src/vendor/pdfjs"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fL --progress-bar -o "$WORK/pdfjs.tgz" "https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-$PDFJS_VERSION.tgz"
tar xzf "$WORK/pdfjs.tgz" -C "$WORK"

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$WORK/package/legacy/build/pdf.min.mjs" "$WORK/package/legacy/build/pdf.worker.min.mjs" "$DEST/"
# Character maps and fonts are needed for CJK and non-embedded fonts; wasm/iccs decode JPEG 2000 and ICC colors.
cp -R "$WORK/package/cmaps" "$WORK/package/standard_fonts" "$WORK/package/wasm" "$WORK/package/iccs" "$DEST/"
cp "$WORK/package/LICENSE" "$DEST/LICENSE"
echo "$PDFJS_VERSION" > "$DEST/VERSION"
echo "pdf.js $PDFJS_VERSION installed in $DEST"
