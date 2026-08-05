#!/usr/bin/env bash
# Static contract check for trip-scoped Customer live-location migration.
# Does not apply the migration — only verifies the SQL file still encodes the
# conditional-approval hard rules.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260911130000_passenger_assigned_driver_location_select.sql"
fail=0

if [[ ! -f "$MIGRATION" ]]; then
  echo "FAIL: missing $MIGRATION" >&2
  exit 1
fi

assert_grep() {
  local pat="$1"
  local msg="$2"
  if ! grep -qE "$pat" "$MIGRATION"; then
    echo "FAIL: $msg" >&2
    fail=1
  fi
}

assert_not_grep() {
  local pat="$1"
  local msg="$2"
  if grep -qE "$pat" "$MIGRATION"; then
    echo "FAIL: $msg" >&2
    fail=1
  fi
}

assert_grep 'CREATE TABLE IF NOT EXISTS public\.trip_driver_live_location' \
  'must create trip_driver_live_location projection'
assert_grep 'Passengers select own live trip driver location' \
  'must define trip-scoped passenger SELECT policy'
assert_grep 'get_trip_driver_live_location' \
  'must expose authoritative min-column fetch RPC'
assert_grep 'p_trip_id uuid' \
  'submit_driver_location_sample must accept p_trip_id'
assert_grep 'p_location_sequence bigint' \
  'submit_driver_location_sample must accept p_location_sequence'
assert_grep 'p_altitude double precision' \
  'submit_driver_location_sample must accept p_altitude'
assert_grep 'TRIP_ID_REQUIRED_FOR_ACTIVE_TRIP' \
  'active_trip submissions must require trip id'
assert_grep 'TRIP_ASSIGNMENT_REJECTED' \
  'must reject submissions for non-assigned trips'
assert_grep 'trip_status_is_live_trackable' \
  'must gate access on live trackable statuses'
assert_grep 'ALTER PUBLICATION supabase_realtime ADD TABLE public\.trip_driver_live_location' \
  'must publish trip_driver_live_location for Realtime'
assert_grep 't\.driver_id = tdll\.driver_id' \
  'get_trip_driver_live_location must require still-assigned driver'

# Must NOT reopen blanket passenger SELECT on drivers.
assert_not_grep 'CREATE POLICY "Passengers can view assigned driver location"' \
  'must not recreate blanket passenger SELECT on drivers'

# Live list must not include terminal / rematch statuses.
live_fn=$(awk '/CREATE OR REPLACE FUNCTION public\.trip_status_is_live_trackable/,/\$\$;/' "$MIGRATION")
for bad in "'completed'" "'cancelled'" "'no_show'" "'searching_new_driver'" "'broadcasting'"; do
  if echo "$live_fn" | grep -q "$bad"; then
    echo "FAIL: trip_status_is_live_trackable must not include $bad" >&2
    fail=1
  fi
done

# Projection CREATE TABLE must not include sensitive columns.
table_body=$(awk '/CREATE TABLE IF NOT EXISTS public\.trip_driver_live_location/,/\);/' "$MIGRATION")
for col in phone email document push_token battery; do
  if echo "$table_body" | grep -qi "$col"; then
    echo "FAIL: trip_driver_live_location must not expose '$col'" >&2
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "trip-scoped live location contract FAILED" >&2
  exit 1
fi

echo "OK: trip-scoped Customer live-location migration contract"
