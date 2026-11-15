#!/usr/bin/env bash
# Bug #29 — post-deploy smoke for scheduled JIT Edge health.
# 1) Run static bundle lock (dynamic-import / missing-module regression).
# 2) Optionally invoke live scheduled-dispatch and assert no Module not found.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== [1/2] Bug #29 Edge bundle lock ==="
deno test --no-check --allow-read \
  supabase/functions/_shared/scheduledJitActivationEdgeBundleLock.test.ts

PROJECT_REF="${SUPABASE_PROJECT_REF:-thazislrdkjpvvghtvzo}"
SERVICE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"
if [[ -z "$SERVICE_KEY" && -f "$HOME/.supabase/access-token" ]]; then
  : # token alone cannot invoke; require SERVICE_ROLE
fi

if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  echo "NOTICE: SUPABASE_SERVICE_ROLE_KEY unset — skipping live invoke smoke."
  echo "OK: local Edge bundle lock passed."
  exit 0
fi

echo "=== [2/2] Live scheduled-dispatch invoke ==="
URL="https://${PROJECT_REF}.supabase.co/functions/v1/scheduled-dispatch"
BODY=$(curl -sS -w "\n%{http_code}" -X POST "$URL" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d '{}')
HTTP=$(echo "$BODY" | tail -n1)
PAYLOAD=$(echo "$BODY" | sed '$d')
echo "HTTP $HTTP"
echo "$PAYLOAD" | head -c 800
echo

if echo "$PAYLOAD" | grep -qi 'Module not found'; then
  echo "FAIL: Module not found in scheduled-dispatch response (incomplete Edge bundle)"
  exit 1
fi
if [[ "$HTTP" != "200" ]]; then
  echo "FAIL: expected HTTP 200 from scheduled-dispatch, got $HTTP"
  exit 1
fi
echo "OK: scheduled-dispatch smoke passed (no Module not found)."
