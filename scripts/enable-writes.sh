#!/usr/bin/env bash
#
# enable-writes.sh — opt into mail-index mailbox writes (archive + label edit)
# for ONE account. Requests the LEAST-PRIVILEGE gmail.modify scope: read +
# modify only — never send, never delete. Writes stay OFF for anyone who does
# not run this. See docs/adr/0007-opt-in-mailbox-writes.md.
#
# Usage:
#   enable-writes.sh <account-email> [gog-client-name]
#
# After it completes, the `mail-index archive` / `mail-index label` CLI commands
# and the archive_message / modify_labels MCP tools work for that account.
#
# This script drives the GOG adapter (mail-index's one-click path). If your
# account uses the GWS adapter instead, writes use whatever scope your gws
# config already grants — re-authorize gws with a Gmail modify scope
# (gmail.modify or https://mail.google.com/); no gog step is needed.
#
set -euo pipefail

EMAIL="${1:-}"
CLIENT="${2:-mail-index}"
MODIFY_SCOPE="https://www.googleapis.com/auth/gmail.modify"

if [ -z "$EMAIL" ]; then
  echo "Usage: enable-writes.sh <account-email> [gog-client-name]" >&2
  echo "  Grants the least-privilege gmail.modify scope (never send/delete)." >&2
  exit 64
fi

if ! command -v gog >/dev/null 2>&1; then
  echo "error: the 'gog' CLI was not found on PATH (see docs/INSTALL.md)." >&2
  echo "       gws-adapter accounts don't need this — they use their own gws scope." >&2
  exit 69
fi

echo "Enabling writes for ${EMAIL} (gog client: ${CLIENT})"
echo "Requesting least-privilege scope: gmail.modify (read + modify; never send/delete)"
echo

# Mirrors authAddArgs(account, /*enableWrites*/ true) in src/cli/setup.ts:
# readonly base + gmail.modify, plus --force-consent so an already-readonly
# account is actually upgraded (gog reuses the old token otherwise).
gog auth add "$EMAIL" \
  --client "$CLIENT" \
  --services gmail \
  --gmail-scope=readonly \
  --extra-scopes="${MODIFY_SCOPE}" \
  --force-consent

echo
echo "Done. Verify with:  gog auth list --client ${CLIENT}"
echo "Then try:           mail-index archive <account:message-id>"
