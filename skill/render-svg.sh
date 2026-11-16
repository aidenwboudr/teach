#!/usr/bin/env bash
# render-svg.sh IN.svg [OUT.png]: the same as render-svg.mjs next to it (kept for older notes that name this script).
exec node "$(dirname "$0")/render-svg.mjs" "$@"
