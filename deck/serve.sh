#!/usr/bin/env bash
# Serve the mail-index pitch deck locally.
#
# The deck embeds the real GitHub demos as iframes (../docs/demo/*.html), so it
# must be SERVED from the repo root — opening deck/index.html from file:// leaves
# those three demo stations blank (browsers block file:// iframes). anime.js and
# the fonts are vendored locally, so no internet is needed.
#
#   ./deck/serve.sh            # serves on :8000 and opens the deck
#   ./deck/serve.sh 9000       # pick a different port
set -euo pipefail

PORT="${1:-8000}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root (parent of deck/)
URL="http://127.0.0.1:${PORT}/deck/index.html"

echo "Serving ${ROOT}"
echo "Deck →  ${URL}   (Ctrl-C to stop)"

# Open the browser once the server is up (best-effort; ignore if no opener).
( sleep 1; command -v open >/dev/null 2>&1 && open "${URL}" || true ) &

exec python3 -m http.server "${PORT}" --bind 127.0.0.1 --directory "${ROOT}"
