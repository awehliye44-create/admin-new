-- Non-production concurrency simulation for fare-increase atomic claim.
-- Uses a disposable schema only. ALWAYS ends in ROLLBACK of outer setup
-- (or DROP SCHEMA CASCADE). Never touches public production tables.
--
-- Proves with two parallel sessions:
--   - one successful apply
--   - one ALREADY_APPLIED / STALE
--   - one fare delta
--   - one success event
--   - unchanged wallet + payment capture rows

\set ON_ERROR_STOP on

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
  UNIQUE (trip_change_request_id) -- ADDITIONAL_AUTHORISATION_CONFIRMED uniqueness
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
LANGUAGE plpgsql
AS $$
DECLARE
  v_trip mod_claim_sim.trips%ROWTYPE;
  v_req mod_claim_sim.trip_change_requests%ROWTYPE;
  v_claimed int;
BEGIN
  SELECT * INTO v_trip FROM mod_claim_sim.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STALE_MODIFICATION' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_req FROM mod_claim_sim.trip_change_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STALE_MODIFICATION' USING ERRCODE = 'P0001';
  END IF;

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
  SET status = 'payment_confirmed',
      payment_status = 'confirmed',
      payment_confirmed_at = now()
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
  ) VALUES (
    p_request_id, 'ADDITIONAL_AUTHORISATION_CONFIRMED', p_authorised_total_pence
  )
  ON CONFLICT (trip_change_request_id) DO NOTHING;

  -- Apply once: restamp fare + destination.
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

  UPDATE mod_claim_sim.trip_change_requests
  SET status = 'applied', updated_at = now()
  WHERE id = p_request_id;

  INSERT INTO mod_claim_sim.trip_modification_apply_events (
    trip_id, trip_change_request_id, event_type, fare_delta_pence
  ) VALUES (
    p_trip_id, p_request_id, 'MODIFICATION_APPLIED', v_req.fare_delta_pence
  )
  ON CONFLICT (trip_change_request_id) DO NOTHING;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'MODIFICATION_APPLIED',
    'fare_delta_pence', v_req.fare_delta_pence
  );
END;
$$;

-- Seed (MK-260915-002 class amounts — simulation only, not the frozen live trip).
INSERT INTO mod_claim_sim.trips VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'in_progress',
  500,
  500,
  'MK4 4DD'
);

INSERT INTO mod_claim_sim.trip_change_requests VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'payment_pending',
  'pending',
  500,
  811,
  311,
  NULL,
  NULL,
  now()
);

-- Pre-existing wallet + capture rows that must remain unchanged.
INSERT INTO mod_claim_sim.wallet_ledger (trip_id, amount_pence)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0);
INSERT INTO mod_claim_sim.payment_captures (trip_id, captured_amount_pence)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0);

-- Advise: true parallel is driven by
--   supabase/tests/atomic_fare_increase_modification_claim_parallel.sh
-- This SQL file proves serial idempotency + completion gate, then exits cleanly.

DO $$
DECLARE
  r1 jsonb;
  r2_code text;
  fare int;
  events int;
  auth_rows int;
  wallet_amt int;
  capture_amt int;
  dropoff text;
BEGIN
  r1 := mod_claim_sim.claim_and_apply(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
    500,
    'in_progress',
    811,
    true,
    811
  );

  r2_code := (mod_claim_sim.claim_and_apply(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
    500,
    'in_progress',
    811,
    true,
    811
  ))->>'code';

  SELECT final_customer_fare_pence, dropoff_address INTO fare, dropoff
  FROM mod_claim_sim.trips
  WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  SELECT count(*) INTO events FROM mod_claim_sim.trip_modification_apply_events;
  SELECT count(*) INTO auth_rows FROM mod_claim_sim.payment_session_authorisations;
  SELECT amount_pence INTO wallet_amt FROM mod_claim_sim.wallet_ledger LIMIT 1;
  SELECT captured_amount_pence INTO capture_amt FROM mod_claim_sim.payment_captures LIMIT 1;

  IF (r1->>'code') IS DISTINCT FROM 'MODIFICATION_APPLIED' THEN
    RAISE EXCEPTION 'FAIL: first claim not applied (% )', r1;
  END IF;
  IF (r1->>'fare_delta_pence')::int IS DISTINCT FROM 311 THEN
    RAISE EXCEPTION 'FAIL: fare delta not exactly once 311';
  END IF;
  IF r2_code IS DISTINCT FROM 'ALREADY_APPLIED' THEN
    RAISE EXCEPTION 'FAIL: second claim expected ALREADY_APPLIED got %', r2_code;
  END IF;
  IF fare IS DISTINCT FROM 811 THEN
    RAISE EXCEPTION 'FAIL: fare not 811 after one apply';
  END IF;
  IF events IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL: expected one apply event, got %', events;
  END IF;
  IF auth_rows IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL: expected one ADDITIONAL_AUTHORISATION_CONFIRMED, got %', auth_rows;
  END IF;
  IF wallet_amt IS DISTINCT FROM 0 OR capture_amt IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'FAIL: wallet/capture mutated';
  END IF;
  IF dropoff IS DISTINCT FROM 'Elder Gate, Milton Keynes MK9 1LA' THEN
    RAISE EXCEPTION 'FAIL: destination not applied once';
  END IF;

  RAISE NOTICE 'SERIAL_IDEMPOTENCY_PASS first=% second=% fare=% events=% auth=%',
    r1->>'code', r2_code, fare, events, auth_rows;
END $$;

-- Completion gate: payment_pending unpaid increase must NOT block completion
-- (route/fare remain original). payment_confirmed still blocks until applied.
CREATE OR REPLACE FUNCTION mod_claim_sim.trip_has_unresolved_fare_increase_modification(p_trip_id uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM mod_claim_sim.trip_change_requests r
    WHERE r.trip_id = p_trip_id
      AND COALESCE(r.fare_delta_pence, 0) > 0
      AND (
        r.status = 'payment_confirmed'
        OR (
          r.status IN ('approved', 'applied')
          AND lower(COALESCE(r.payment_status, '')) IN ('required', 'pending')
        )
      )
  );
$$;

DO $$
DECLARE
  unresolved boolean;
  fare_before int;
  fare_after int;
BEGIN
  UPDATE mod_claim_sim.trip_change_requests
  SET status = 'payment_pending', payment_status = 'pending'
  WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  UPDATE mod_claim_sim.trips
  SET final_customer_fare_pence = 500, gross_fare_pence = 500, dropoff_address = 'MK4 4DD'
  WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  SELECT final_customer_fare_pence INTO fare_before FROM mod_claim_sim.trips
  WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  unresolved := mod_claim_sim.trip_has_unresolved_fare_increase_modification(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  );
  IF unresolved IS TRUE THEN
    RAISE EXCEPTION 'FAIL: payment_pending unpaid mod must not block completion';
  END IF;

  SELECT final_customer_fare_pence INTO fare_after FROM mod_claim_sim.trips
  WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  IF fare_before IS DISTINCT FROM 500 OR fare_after IS DISTINCT FROM 500 THEN
    RAISE EXCEPTION 'FAIL: completion gate mutated fare';
  END IF;

  -- payment_confirmed still unresolved until applied.
  UPDATE mod_claim_sim.trip_change_requests
  SET status = 'payment_confirmed', payment_status = 'confirmed'
  WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  unresolved := mod_claim_sim.trip_has_unresolved_fare_increase_modification(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  );
  IF unresolved IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: expected unresolved=true for payment_confirmed';
  END IF;

  RAISE NOTICE 'COMPLETION_GATE_PASS fare=% unresolved_pending=false unresolved_confirmed=true',
    fare_after;
END $$;

-- Leave schema in place for parallel.sh (dropped by that script).
SELECT 'ATOMIC_CLAIM_SIMULATION_SERIAL_PASS' AS verdict;
