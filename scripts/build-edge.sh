#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is required to build the Edge package." >&2
    exit 1
fi

if [[ $# -gt 1 ]]; then
    echo "Usage: $0 [output-directory]" >&2
    exit 2
fi

if [[ $# -eq 1 ]]; then
    exec node "$SCRIPT_DIR/package-edge.mjs" --out-dir "$1"
fi

exec node "$SCRIPT_DIR/package-edge.mjs"
