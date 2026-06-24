#!/usr/bin/env bash
# Seed Phase 1 Ops workflow test events (local/staging only — NOT production deploy).
# Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
set -euo pipefail

URL="${SUPABASE_URL:-}"
KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

if [[ -z "$URL" || -z "$KEY" ]]; then
  echo "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
  exit 1
fi

PAYLOAD='{
  "events": [
    {
      "event_type": "driver_accept_false_timeout",
      "app_name": "driver_app",
      "severity": "warning",
      "message": "Phase1 test — accept false timeout",
      "metadata": { "test": true, "phase": 1 }
    },
    {
      "event_type": "driver_offer_chips_late",
      "app_name": "driver_app",
      "severity": "warning",
      "message": "Phase1 test — preset chips late",
      "metadata": { "test": true }
    },
    {
      "event_type": "customer_call_mask_failed",
      "app_name": "customer_app",
      "severity": "critical",
      "message": "Phase1 test — call mask failed",
      "metadata": { "test": true }
    },
    {
      "event_type": "call_masking_provider_failed",
      "app_name": "backend",
      "severity": "critical",
      "message": "Phase1 test — call masking provider failed",
      "metadata": { "test": true }
    },
    {
      "event_type": "contradictory_trip_state",
      "app_name": "backend",
      "severity": "critical",
      "message": "Phase1 test — contradictory trip state",
      "metadata": { "test": true }
    }
  ]
}'

echo "Posting test workflow events to ingest-ops-event..."
curl -sS -X POST "$URL/functions/v1/ingest-ops-event" \
  -H "Authorization: Bearer $KEY" \
  -H "apikey: $KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" | jq .

echo ""
echo "Running detection scan..."
curl -sS -X POST "$URL/rest/v1/rpc/ops_run_all_detections" \
  -H "Authorization: Bearer $KEY" \
  -H "apikey: $KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .

echo ""
echo "Done. Open Ops Intelligence → Driver App / Customer App / Performance tabs."
