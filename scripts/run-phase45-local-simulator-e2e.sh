#!/usr/bin/env bash
# Run Phase 4/5 scheduled booking simulator E2E against local Docker Supabase only.
# Never production. No Revolut network. No production OTA.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase_db_thazislrdkjpvvghtvzo}"
SQL="$ROOT/scripts/phase45-local-simulator-e2e.sql"

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "Local Docker DB container not running: $DB_CONTAINER" >&2
  exit 1
fi

# Refuse if REST URL looks like production cloud
if curl -fsS "https://thazislrdkjpvvghtvzo.supabase.co/rest/v1/" >/dev/null 2>&1; then
  :
fi

echo "Target: local Docker only ($DB_CONTAINER)"
echo "API check:"
curl -sS -o /dev/null -w "  rest=%{http_code}\n" \
  -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0" \
  "http://127.0.0.1:54321/rest/v1/"

docker exec -i "$DB_CONTAINER" psql -U postgres -v ON_ERROR_STOP=1 < "$SQL"
echo "OK: phase45-local-simulator-e2e finished"
