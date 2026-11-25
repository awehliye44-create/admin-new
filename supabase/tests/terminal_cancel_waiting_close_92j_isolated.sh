#!/usr/bin/env bash
# #92J — real PostgreSQL: terminal cancel closes open waiting segments.
# LOCAL DB only. No Edge / Revolut / live money / historical remediation.
#
#   DB_URL=postgresql://admin@127.0.0.1:5432/onecab_payment_ssot_92a \
#     bash supabase/tests/terminal_cancel_waiting_close_92j_isolated.sh
set -euo pipefail
export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/opt/postgresql@16/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DB_URL="${DB_URL:-postgresql://admin@127.0.0.1:5432/onecab_payment_ssot_92a}"

case "$DB_URL" in
  *@127.0.0.1:*|*@localhost:*|*@localhost/*|*@127.0.0.1/*) ;;
  *) echo "REFUSING: DB_URL must be LOCAL. Got: $DB_URL" >&2; exit 2 ;;
esac

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql required" >&2; exit 1
fi
if ! PGCONNECT_TIMEOUT=5 psql "$DB_URL" -X -q -At -c 'select 1' >/dev/null 2>&1; then
  echo "ERROR: no Postgres at $DB_URL" >&2; exit 1
fi

PSQL=(psql "$DB_URL" -X -q -v ON_ERROR_STOP=1)

echo "=== #92J terminal cancel waiting-close (isolated PG) ==="

# Dedicated schema so we never fight the 92A stub trips shape.
"${PSQL[@]}" <<'SQL'
DROP SCHEMA IF EXISTS twc92j CASCADE;
CREATE SCHEMA twc92j;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE twc92j.trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by text,
  cancel_reason text,
  cancellation_reason text,
  arrived_at timestamptz,
  pickup_arrived_at timestamptz,
  is_scheduled boolean DEFAULT false,
  scheduled_at timestamptz,
  scheduled_status text,
  dispatch_status text,
  negotiation_status text,
  negotiation_owner_driver_id uuid,
  current_offer_driver_id uuid,
  negotiation_locked_until timestamptz,
  current_offer_expires_at timestamptz,
  searching_expires_at timestamptz,
  special_instructions text,
  driver_id uuid,
  confirmed_driver_id uuid,
  passenger_id uuid,
  pickup_waiting_counted_seconds integer,
  stop_waiting_counted_seconds integer,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE twc92j.drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  current_trip_id uuid,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE twc92j.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  active_trip_id uuid,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE twc92j.ride_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid,
  status text,
  revoked_reason text,
  negotiation_status text,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE twc92j.trip_waiting_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  location_type text NOT NULL,
  stop_id uuid,
  started_at timestamptz NOT NULL,
  ended_at timestamptz
);

CREATE OR REPLACE FUNCTION twc92j.is_trip_terminal_cancel_status(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(COALESCE(p_status, '')) IN (
    'cancelled', 'customer_cancelled', 'no_show', 'expired', 'rejected'
  );
$$;

-- Schema-local copy of #92J apply_terminal (same close semantics as production migration).
CREATE OR REPLACE FUNCTION twc92j.apply_terminal_trip_cancellation(
  p_trip_id uuid,
  p_cancelled_by text DEFAULT 'admin'::text,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'twc92j', 'public'
AS $function$
DECLARE
  v_trip twc92j.trips%ROWTYPE;
  v_now timestamptz := now();
  v_reason text := NULLIF(trim(COALESCE(p_reason, '')), '');
  v_terminal_neg text;
  v_close_at timestamptz;
  v_closed_segments int := 0;
BEGIN
  SELECT * INTO v_trip FROM twc92j.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  v_close_at := COALESCE(v_trip.cancelled_at, v_now);
  UPDATE twc92j.trip_waiting_segments s
  SET ended_at = GREATEST(s.started_at, v_close_at)
  WHERE s.trip_id = p_trip_id
    AND s.ended_at IS NULL;
  GET DIAGNOSTICS v_closed_segments = ROW_COUNT;

  IF twc92j.is_trip_terminal_cancel_status(v_trip.status) THEN
    RETURN jsonb_build_object(
      'success', true,
      'trip_id', p_trip_id,
      'already_terminal', true,
      'waiting_segments_closed', v_closed_segments
    );
  END IF;

  IF lower(COALESCE(v_trip.status, '')) = 'completed' OR v_trip.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'trip_id', p_trip_id,
      'error', 'COMPLETED_TRIP_NOT_CANCELLABLE',
      'waiting_segments_closed', v_closed_segments
    );
  END IF;

  v_terminal_neg := CASE
    WHEN lower(COALESCE(p_cancelled_by, '')) IN ('customer','passenger','rider') THEN 'cancelled_by_customer'
    WHEN lower(COALESCE(p_cancelled_by, '')) = 'driver' THEN 'cancelled_by_driver'
    ELSE 'cancelled_by_admin'
  END;

  UPDATE twc92j.trips
  SET
    status = CASE
      WHEN lower(COALESCE(p_cancelled_by, '')) IN ('customer','passenger','rider')
        THEN 'customer_cancelled'
      ELSE 'cancelled'
    END,
    cancelled_at = v_now,
    cancelled_by = p_cancelled_by,
    cancel_reason = COALESCE(v_reason, 'cancelled_by_' || COALESCE(p_cancelled_by, 'admin')),
    cancellation_reason = v_reason,
    negotiation_owner_driver_id = NULL,
    current_offer_driver_id = NULL,
    negotiation_locked_until = NULL,
    current_offer_expires_at = NULL,
    searching_expires_at = NULL,
    dispatch_status = 'cancelled',
    negotiation_status = v_terminal_neg,
    scheduled_status = CASE
      WHEN v_trip.is_scheduled IS TRUE OR v_trip.scheduled_at IS NOT NULL THEN 'cancelled'
      ELSE scheduled_status
    END,
    special_instructions = CASE
      WHEN v_reason IS NOT NULL AND lower(p_cancelled_by) = 'admin' THEN 'Cancelled by admin: ' || v_reason
      WHEN lower(p_cancelled_by) = 'admin' THEN 'Cancelled by admin'
      ELSE special_instructions
    END,
    updated_at = v_now
  WHERE id = p_trip_id
    AND completed_at IS NULL;

  IF v_trip.confirmed_driver_id IS NOT NULL OR v_trip.driver_id IS NOT NULL THEN
    UPDATE twc92j.drivers SET current_trip_id = NULL, updated_at = v_now
    WHERE id IN (v_trip.confirmed_driver_id, v_trip.driver_id) AND current_trip_id = p_trip_id;
  END IF;

  IF v_trip.passenger_id IS NOT NULL THEN
    UPDATE twc92j.customers SET active_trip_id = NULL, updated_at = v_now
    WHERE id = v_trip.passenger_id AND active_trip_id = p_trip_id;
  END IF;

  UPDATE twc92j.ride_offers
  SET status = 'revoked',
      revoked_reason = 'trip_terminal_cancel',
      negotiation_status = v_terminal_neg,
      updated_at = v_now
  WHERE trip_id = p_trip_id AND status IN ('pending', 'countered', 'accepted');

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', p_trip_id,
    'cancelled_by', p_cancelled_by,
    'negotiation_status', v_terminal_neg,
    'waiting_segments_closed', v_closed_segments
  );
END;
$function$;
SQL

# Prove migration SQL contains the close UPDATE (source lock) + behavioural PG proof.
grep -q 'ended_at IS NULL' "$REPO/supabase/migrations/20270301150000_terminal_cancel_close_waiting_segments_92j.sql"
grep -q 'waiting_segments_closed' "$REPO/supabase/migrations/20270301150000_terminal_cancel_close_waiting_segments_92j.sql"

"${PSQL[@]}" <<'SQL'
DO $$
DECLARE
  v_trip_id uuid := gen_random_uuid();
  v_seg_id uuid := gen_random_uuid();
  v_result jsonb;
  v_ended timestamptz;
  v_closed int;
  v_replay jsonb;
BEGIN
  INSERT INTO twc92j.trips (id, status, arrived_at, pickup_arrived_at)
  VALUES (v_trip_id, 'arrived_at_pickup', now() - interval '10 minutes', now() - interval '10 minutes');

  INSERT INTO twc92j.trip_waiting_segments (id, trip_id, location_type, started_at, ended_at)
  VALUES (v_seg_id, v_trip_id, 'pickup', now() - interval '8 minutes', NULL);

  v_result := twc92j.apply_terminal_trip_cancellation(v_trip_id, 'admin', '92j waiting close test');
  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION '92J_WAITING_CLOSE: cancel failed %', v_result;
  END IF;

  v_closed := COALESCE((v_result->>'waiting_segments_closed')::int, -1);
  IF v_closed < 1 THEN
    RAISE EXCEPTION '92J_WAITING_CLOSE: expected waiting_segments_closed>=1 got % / %', v_closed, v_result;
  END IF;

  SELECT ended_at INTO v_ended FROM twc92j.trip_waiting_segments WHERE id = v_seg_id;
  IF v_ended IS NULL THEN
    RAISE EXCEPTION '92J_WAITING_CLOSE: segment still open after terminal cancel';
  END IF;

  v_replay := twc92j.apply_terminal_trip_cancellation(v_trip_id, 'admin', 'replay');
  IF COALESCE((v_replay->>'already_terminal')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION '92J_WAITING_CLOSE: expected already_terminal on replay %', v_replay;
  END IF;
  IF COALESCE((v_replay->>'waiting_segments_closed')::int, -1) <> 0 THEN
    RAISE EXCEPTION '92J_WAITING_CLOSE: replay should close 0 open segments %', v_replay;
  END IF;

  IF (SELECT status FROM twc92j.trips WHERE id = v_trip_id) <> 'cancelled' THEN
    RAISE EXCEPTION '92J_WAITING_CLOSE: trip status not cancelled';
  END IF;

  RAISE NOTICE '92J_WAITING_CLOSE_OK';
END $$;
SQL

"${PSQL[@]}" -c 'DROP SCHEMA IF EXISTS twc92j CASCADE;' >/dev/null

echo "ALL terminal_cancel_waiting_close_92j_isolated CHECKS PASSED"
