#!/usr/bin/env bash
# Two real parallel psql sessions against non-production mod_claim_sim schema.
# Prerequisites: serial sim SQL has created the schema+function (or this script seeds).
set -euo pipefail
export PATH=/usr/bin:/bin:/opt/homebrew/bin:$PATH

PSQL=(psql -h 127.0.0.1 -p 5432 -d postgres -U admin -v ON_ERROR_STOP=1 -At)

echo "=== Seed / reset parallel fixture ==="
"${PSQL[@]}" <<'SQL'
DROP SCHEMA IF EXISTS mod_claim_sim CASCADE;
CREATE SCHEMA mod_claim_sim;
SET search_path TO mod_claim_sim, public;

CREATE TABLE mod_claim_sim.trips (
  id uuid PRIMARY KEY,
  status text NOT NULL,
  final_customer_fare_pence integer NOT NULL,
  gross_fare_pence integer NOT NULL,
  dropoff_address text NOT NULL
);
CREATE TABLE mod_claim_sim.trip_change_requests (
  id uuid PRIMARY KEY,
  trip_id uuid NOT NULL REFERENCES mod_claim_sim.trips(id),
  status text NOT NULL,
  payment_status text,
  original_fare_pence integer NOT NULL,
  new_fare_pence integer NOT NULL,
  fare_delta_pence integer NOT NULL,
  payment_confirmed_at timestamptz,
  rejection_reason text,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE mod_claim_sim.payment_session_authorisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_change_request_id uuid,
  status text NOT NULL,
  authorised_amount_pence integer NOT NULL,
  UNIQUE (trip_change_request_id)
);
CREATE TABLE mod_claim_sim.trip_modification_apply_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  trip_change_request_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL,
  fare_delta_pence integer NOT NULL,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE mod_claim_sim.wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  amount_pence integer NOT NULL
);
CREATE TABLE mod_claim_sim.payment_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  captured_amount_pence integer NOT NULL
);

CREATE OR REPLACE FUNCTION mod_claim_sim.claim_and_apply(
  p_trip_id uuid,
  p_request_id uuid,
  p_expected_original_fare_pence integer,
  p_expected_trip_status text,
  p_required_authorised_total_pence integer,
  p_provider_confirmed boolean,
  p_authorised_total_pence integer
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_trip mod_claim_sim.trips%ROWTYPE;
  v_req mod_claim_sim.trip_change_requests%ROWTYPE;
  v_claimed int;
BEGIN
  SELECT * INTO v_trip FROM mod_claim_sim.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STALE_MODIFICATION' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO v_req FROM mod_claim_sim.trip_change_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STALE_MODIFICATION' USING ERRCODE = 'P0001'; END IF;
  IF v_req.status = 'applied' THEN
    RETURN jsonb_build_object('ok', true, 'code', 'ALREADY_APPLIED');
  END IF;
  IF p_provider_confirmed IS NOT TRUE
     OR p_authorised_total_pence < p_required_authorised_total_pence THEN
    RAISE EXCEPTION 'PAYMENT_NOT_CONFIRMED' USING ERRCODE = 'P0001';
  END IF;
  IF lower(v_trip.status) IS DISTINCT FROM lower(p_expected_trip_status)
     OR v_trip.final_customer_fare_pence IS DISTINCT FROM p_expected_original_fare_pence
     OR v_req.original_fare_pence IS DISTINCT FROM p_expected_original_fare_pence THEN
    RAISE EXCEPTION 'STALE_MODIFICATION' USING ERRCODE = 'P0001';
  END IF;
  UPDATE mod_claim_sim.trip_change_requests
  SET status = 'payment_confirmed', payment_status = 'confirmed', payment_confirmed_at = now()
  WHERE id = p_request_id
    AND status IN ('payment_required', 'payment_pending', 'payment_confirmed')
  RETURNING * INTO v_req;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    SELECT * INTO v_req FROM mod_claim_sim.trip_change_requests WHERE id = p_request_id;
    IF v_req.status = 'applied' THEN
      RAISE EXCEPTION 'ALREADY_APPLIED' USING ERRCODE = 'P0001';
    END IF;
    RAISE EXCEPTION 'STALE_MODIFICATION' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO mod_claim_sim.payment_session_authorisations (
    trip_change_request_id, status, authorised_amount_pence
  ) VALUES (p_request_id, 'ADDITIONAL_AUTHORISATION_CONFIRMED', p_authorised_total_pence)
  ON CONFLICT (trip_change_request_id) DO NOTHING;
  UPDATE mod_claim_sim.trips
  SET final_customer_fare_pence = v_req.new_fare_pence,
      gross_fare_pence = v_req.new_fare_pence,
      dropoff_address = 'Elder Gate, Milton Keynes MK9 1LA'
  WHERE id = p_trip_id
    AND final_customer_fare_pence = p_expected_original_fare_pence;
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RAISE EXCEPTION 'STALE_MODIFICATION' USING ERRCODE = 'P0001', DETAIL = 'fare_apply_zero_rows';
  END IF;
  UPDATE mod_claim_sim.trip_change_requests SET status = 'applied', updated_at = now()
  WHERE id = p_request_id;
  INSERT INTO mod_claim_sim.trip_modification_apply_events (
    trip_id, trip_change_request_id, event_type, fare_delta_pence
  ) VALUES (p_trip_id, p_request_id, 'MODIFICATION_APPLIED', v_req.fare_delta_pence)
  ON CONFLICT (trip_change_request_id) DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'code', 'MODIFICATION_APPLIED', 'fare_delta_pence', v_req.fare_delta_pence);
END;
$$;

INSERT INTO mod_claim_sim.trips VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'in_progress', 500, 500, 'MK4 4DD');
INSERT INTO mod_claim_sim.trip_change_requests VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'payment_pending', 'pending', 500, 811, 311, NULL, NULL, now());
INSERT INTO mod_claim_sim.wallet_ledger (trip_id, amount_pence)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0);
INSERT INTO mod_claim_sim.payment_captures (trip_id, captured_amount_pence)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0);
SQL

TMPDIR=$(mktemp -d)
CLAIM_SQL="SELECT mod_claim_sim.claim_and_apply(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
  500, 'in_progress', 811, true, 811
);"

echo "=== Launch two parallel confirm sessions ==="
(
  "${PSQL[@]}" -c "BEGIN; ${CLAIM_SQL} COMMIT;" >"$TMPDIR/s1.out" 2>"$TMPDIR/s1.err"
  echo $? >"$TMPDIR/s1.rc"
) &
PID1=$!
(
  "${PSQL[@]}" -c "BEGIN; ${CLAIM_SQL} COMMIT;" >"$TMPDIR/s2.out" 2>"$TMPDIR/s2.err"
  echo $? >"$TMPDIR/s2.rc"
) &
PID2=$!
wait "$PID1" "$PID2"

echo "--- session1 ---"; cat "$TMPDIR/s1.out" "$TMPDIR/s1.err" || true
echo "--- session2 ---"; cat "$TMPDIR/s2.out" "$TMPDIR/s2.err" || true

echo "=== Assert invariants ==="
"${PSQL[@]}" <<'SQL'
SELECT
  (SELECT count(*) FROM mod_claim_sim.trip_modification_apply_events) AS apply_events,
  (SELECT count(*) FROM mod_claim_sim.payment_session_authorisations) AS auth_rows,
  (SELECT final_customer_fare_pence FROM mod_claim_sim.trips
     WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') AS fare,
  (SELECT fare_delta_pence FROM mod_claim_sim.trip_modification_apply_events LIMIT 1) AS delta,
  (SELECT amount_pence FROM mod_claim_sim.wallet_ledger LIMIT 1) AS wallet,
  (SELECT captured_amount_pence FROM mod_claim_sim.payment_captures LIMIT 1) AS capture,
  (SELECT status FROM mod_claim_sim.trip_change_requests
     WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') AS req_status;
SQL

RESULTS=$("${PSQL[@]}" -c "
SELECT format('%s|%s|%s|%s|%s|%s|%s',
  (SELECT count(*) FROM mod_claim_sim.trip_modification_apply_events),
  (SELECT count(*) FROM mod_claim_sim.payment_session_authorisations),
  (SELECT final_customer_fare_pence FROM mod_claim_sim.trips WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  (SELECT fare_delta_pence FROM mod_claim_sim.trip_modification_apply_events LIMIT 1),
  (SELECT amount_pence FROM mod_claim_sim.wallet_ledger LIMIT 1),
  (SELECT captured_amount_pence FROM mod_claim_sim.payment_captures LIMIT 1),
  (SELECT status FROM mod_claim_sim.trip_change_requests WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
);
")

IFS='|' read -r EVENTS AUTH FARE DELTA WALLET CAPTURE STATUS <<<"$RESULTS"
echo "parsed events=$EVENTS auth=$AUTH fare=$FARE delta=$DELTA wallet=$WALLET capture=$CAPTURE status=$STATUS"

# Exactly one of the two sessions must report MODIFICATION_APPLIED in stdout;
# the other ALREADY_APPLIED (or STALE after lock release).
APPLIED_COUNT=$(cat "$TMPDIR/s1.out" "$TMPDIR/s2.out" | grep -c 'MODIFICATION_APPLIED' || true)
ALREADY_COUNT=$(cat "$TMPDIR/s1.out" "$TMPDIR/s2.out" | grep -c 'ALREADY_APPLIED' || true)
echo "session_codes applied=$APPLIED_COUNT already=$ALREADY_COUNT"

FAIL=0
[[ "$EVENTS" == "1" ]] || { echo "FAIL events"; FAIL=1; }
[[ "$AUTH" == "1" ]] || { echo "FAIL auth"; FAIL=1; }
[[ "$FARE" == "811" ]] || { echo "FAIL fare"; FAIL=1; }
[[ "$DELTA" == "311" ]] || { echo "FAIL delta"; FAIL=1; }
[[ "$WALLET" == "0" ]] || { echo "FAIL wallet"; FAIL=1; }
[[ "$CAPTURE" == "0" ]] || { echo "FAIL capture"; FAIL=1; }
[[ "$STATUS" == "applied" ]] || { echo "FAIL status"; FAIL=1; }
[[ "$APPLIED_COUNT" == "1" ]] || { echo "FAIL applied_count=$APPLIED_COUNT"; FAIL=1; }
[[ "$ALREADY_COUNT" == "1" ]] || { echo "FAIL already_count=$ALREADY_COUNT"; FAIL=1; }

"${PSQL[@]}" -c "DROP SCHEMA IF EXISTS mod_claim_sim CASCADE;" >/dev/null
rm -rf "$TMPDIR"

if [[ "$FAIL" -ne 0 ]]; then
  echo "PARALLEL_CONCURRENCY_FAIL"
  exit 1
fi
echo "PARALLEL_CONCURRENCY_PASS"
