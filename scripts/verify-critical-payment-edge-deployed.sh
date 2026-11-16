#!/usr/bin/env bash
# Bug #37 release gate — refuse to report payment Edge fixes as shipped when
# required functions are missing from the live project or auth is unavailable.
set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-thazislrdkjpvvghtvzo}"
REQUIRED_FUNCTIONS=(
  "submit-revolut-google-pay"
)

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "DEPLOY_GATE_BLOCKED: SUPABASE_ACCESS_TOKEN is not set."
  echo "Create a token at https://supabase.com/dashboard/account/tokens"
  echo "then: export SUPABASE_ACCESS_TOKEN='sbp_…'"
  echo "and re-run: $0"
  exit 2
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo "DEPLOY_GATE_BLOCKED: supabase CLI not found on PATH"
  exit 2
fi

LIST_JSON="$(supabase functions list --project-ref "$PROJECT_REF" -o json 2>/dev/null || true)"
if [[ -z "$LIST_JSON" || "$LIST_JSON" == *"Access token"* || "$LIST_JSON" == *"Error"* ]]; then
  echo "DEPLOY_GATE_BLOCKED: could not list functions for $PROJECT_REF"
  echo "$LIST_JSON" | head -5
  exit 2
fi

missing=0
for fn in "${REQUIRED_FUNCTIONS[@]}"; do
  if ! printf '%s' "$LIST_JSON" | rg -q "\"name\"\\s*:\\s*\"$fn\"|\"slug\"\\s*:\\s*\"$fn\""; then
    # Fallback: plain table output
    if ! supabase functions list --project-ref "$PROJECT_REF" 2>/dev/null | rg -q "$fn"; then
      echo "MISSING_LIVE_FUNCTION: $fn"
      missing=1
    else
      echo "PRESENT: $fn"
    fi
  else
    echo "PRESENT: $fn"
  fi
done

if [[ "$missing" -ne 0 ]]; then
  echo "DEPLOY_GATE_FAILED: critical payment function(s) not live on $PROJECT_REF"
  exit 1
fi

echo "DEPLOY_GATE_OK: critical payment functions present on $PROJECT_REF"
