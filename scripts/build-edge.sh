#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT_DIR/dist/edge}"
UNPACKED_DIR="$OUT_DIR/unpacked"
ZIP_PATH="$OUT_DIR/wizmage-ai-edge.zip"

mkdir -p "$OUT_DIR"
rm -rf "$UNPACKED_DIR"
mkdir -p "$UNPACKED_DIR"

shopt -s nullglob

for path in "$ROOT_DIR"/*; do
    name="$(basename "$path")"
    case "$name" in
        .DS_Store|.git|_metadata|dist|scripts|"Wizmage AI")
            continue
            ;;
    esac
    cp -R "$path" "$UNPACKED_DIR/"
done

MANIFEST_PATH="$UNPACKED_DIR/manifest.json"
if [[ ! -f "$MANIFEST_PATH" ]]; then
    echo "manifest.json was not copied into $UNPACKED_DIR" >&2
    exit 1
fi

# Remove Chrome Web Store-specific fields from the Edge package.
perl -0pi -e 's/,\n\s*"key":\s*"[^"]*"//s; s/,\n\s*"update_url":\s*"[^"]*"//s' "$MANIFEST_PATH"

(
    cd "$UNPACKED_DIR"
    zip -rq "$ZIP_PATH" .
)

echo "Built Edge package:"
echo "  Unpacked: $UNPACKED_DIR"
echo "  Zip: $ZIP_PATH"
