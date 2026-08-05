#!/usr/bin/env bash
# CI guard: P0 frozen-location fix (audit: Ahmed Osman) must stay structurally
# intact in the authoritative migration SQL — heartbeat must NEVER be able to
# carry lat/lng, and the location-freshness gate must keep rejecting
# stale/duplicate/out-of-order cache replays. See
# supabase/migrations/20260910120000_driver_location_frozen_ssot.sql and
# docs/FROZEN_LOCATION_SSOT_SMOKE.md.
#
# This is a static-text contract check on the migration file, not a live DB
# test (this environment has no local Postgres/pgTAP runner available) — it
# still catches the exact regression class this fix exists for: someone
# re-wiring driver_heartbeat_ping to accept coordinates, or someone removing
# the stale/duplicate/out-of-order reject reasons from upsert_driver_presence.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20260910120000_driver_location_frozen_ssot.sql"
fail=0

if [[ ! -f "$MIGRATION" ]]; then
  echo "FAIL: missing $MIGRATION" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. driver_heartbeat_ping must NEVER accept/forward lat/lng/gps_recorded_at.
#    Extract just its function body (between its CREATE OR REPLACE and the
#    next top-level statement) so a lat/lng param on a DIFFERENT function
#    cannot cause a false pass/fail here.
# ---------------------------------------------------------------------------
hb_body=$(awk '/CREATE OR REPLACE FUNCTION public\.driver_heartbeat_ping\(/,/^\$\$;/' "$MIGRATION")
if [[ -z "$hb_body" ]]; then
  echo "FAIL: could not locate driver_heartbeat_ping() function body in migration"
  fail=1
else
  # Strip SQL comment lines first — the body intentionally documents "never
  # passes p_lat/p_lng" in a comment; only real parameter declarations
  # (`p_lat double precision`) or actual call-site arguments (`p_lat =>`)
  # must fail this guard.
  hb_code_only=$(echo "$hb_body" | grep -v '^\s*--')
  if echo "$hb_code_only" | grep -qE 'p_lat\s|p_lng\s|p_gps_recorded_at\s'; then
    echo "FAIL: driver_heartbeat_ping() must never declare or forward p_lat/p_lng/p_gps_recorded_at — heartbeat is liveness-only by construction."
    fail=1
  fi
fi

# ---------------------------------------------------------------------------
# 2. submit_driver_location_sample must require a genuine GPS timestamp
#    (no DEFAULT on p_gps_recorded_at) — location writes must prove freshness.
# ---------------------------------------------------------------------------
if ! grep -qE 'p_gps_recorded_at timestamptz,' "$MIGRATION"; then
  echo "FAIL: submit_driver_location_sample's p_gps_recorded_at must be a required (non-default) parameter."
  fail=1
fi

# ---------------------------------------------------------------------------
# 3. upsert_driver_presence must keep every reject reason that closes the
#    stale/duplicate/out-of-order/future-timestamp cache-replay bug.
# ---------------------------------------------------------------------------
for reason in \
  "duplicate_cached_sample" \
  "duplicate_cached_sample_no_timestamp" \
  "stale_gps_timestamp" \
  "out_of_order_sample" \
  "future_timestamp" \
  "impossible_coordinates"
do
  if ! grep -q "$reason" "$MIGRATION"; then
    echo "FAIL: upsert_driver_presence must keep the '$reason' location-freshness reject reason."
    fail=1
  fi
done

# ---------------------------------------------------------------------------
# 4. Location-freshness columns must only advance behind v_accept_location —
#    guards against someone loosening the gate back to "any non-null lat/lng
#    is fresh" (the original bug).
# ---------------------------------------------------------------------------
if ! grep -q 'last_gps_sample_at = CASE WHEN v_accept_location THEN v_now' "$MIGRATION"; then
  echo "FAIL: last_gps_sample_at must only advance when v_accept_location is true."
  fail=1
fi
if ! grep -q 'last_coordinate_change_at = CASE WHEN v_accept_location AND v_coordinate_changed THEN v_now' "$MIGRATION"; then
  echo "FAIL: last_coordinate_change_at must only advance when v_accept_location AND v_coordinate_changed."
  fail=1
fi

# ---------------------------------------------------------------------------
# 5. Dispatch / nearby-drivers protection must keep excluding frozen drivers.
#    All four dispatch_trip_offers overloads + find_nearby_drivers.
# ---------------------------------------------------------------------------
frozen_gate_count=$(grep -c 'driver_location_is_frozen\|driver_location_state(' "$MIGRATION" || true)
if [[ "$frozen_gate_count" -lt 5 ]]; then
  echo "FAIL: expected at least 5 frozen-location dispatch gates (dispatch_trip_offers x3, find_nearby_drivers, wave-cascade) — found $frozen_gate_count."
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo ""
  echo "See supabase/migrations/20260910120000_driver_location_frozen_ssot.sql and docs/FROZEN_LOCATION_SSOT_SMOKE.md"
  exit 1
fi

echo "OK: frozen-location P0 SSOT guard passed (heartbeat carries no coords; freshness gate + dispatch exclusion intact)"
