#!/usr/bin/env bash
# Securely run Step 8.2A.5 archive download using a shell-only token.
# IMPORTANT: This script runs in a child shell — it can unset its own copy of
# SUPABASE_ACCESS_TOKEN only. It CANNOT unset a variable exported in the
# parent/interactive shell. The caller must run `unset SUPABASE_ACCESS_TOKEN`
# in the parent shell afterward.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"

cleanup_token() {
  unset SUPABASE_ACCESS_TOKEN 2>/dev/null || true
}
trap cleanup_token EXIT INT TERM

if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "SUPABASE_ACCESS_TOKEN already set in this shell (value not shown)"
else
  read -r -s -p "Paste Supabase personal access token (input hidden): " SUPABASE_ACCESS_TOKEN
  echo
  export SUPABASE_ACCESS_TOKEN
fi

if ! supabase projects list >/dev/null 2>&1; then
  echo "AUTH FAIL: supabase projects list"
  exit 1
fi
echo "AUTH PASS: supabase projects list"

/bin/bash "$REPO/scripts/step82a5-download-function-archive.sh"
rc=$?

echo ""
echo "Parent-shell cleanup required (this script cannot unset your interactive export):"
echo "  unset SUPABASE_ACCESS_TOKEN"
echo "  test -z \"\${SUPABASE_ACCESS_TOKEN+x}\" && echo \"Token safely unset\""

exit $rc
