#!/usr/bin/env bash
# Disposable Postgres cluster: real SQL dispatcher + migration 20261204140000,
# then the Edge settings loader against the same rows.
# Never touches a shared or production database.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${BOOKING_RADIUS_PG_PORT:-55433}"
DATA="$(mktemp -d /tmp/onecab-booking-radius-XXXXXX)"
DISPATCHER_MIGRATION="$REPO/supabase/migrations/20261203120000_dispatch_online_gate_intent_or_is_online_mk260926004.sql"

cleanup() {
  "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DATA"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA -c listen_addresses=''" -l "$DATA/server.log" -w start >/dev/null

FN_FILE="$DATA/dispatch_trip_offers_uuid_text.sql"
awk '/^CREATE OR REPLACE FUNCTION public\.dispatch_trip_offers\(p_trip_id uuid, p_trigger_reason text/{p=1} p{print}' \
  "$DISPATCHER_MIGRATION" > "$FN_FILE"
echo ";" >> "$FN_FILE"
grep -q 'v_radius := v_g.expand_radius_meters' "$FN_FILE"

"$PG_BIN/psql" -h "$DATA" -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 \
  -v dispatch_fn_file="$FN_FILE" \
  -f "$REPO/supabase/tests/booking_dispatch_wave_radius_isolated.sql"

BOOKING_RADIUS_PGHOST="$DATA" BOOKING_RADIUS_PGPORT="$PORT" PG_BIN="$PG_BIN" \
  deno test --allow-run --allow-env --allow-read \
  "$REPO/supabase/tests/_shared/bookingDispatchWaveRadiusIntegration.test.ts"
