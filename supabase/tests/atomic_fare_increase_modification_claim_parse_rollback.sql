-- Parse + dry-run harness for the draft atomic claim migration.
-- Creates minimal stubs, applies draft SQL (inlined essentials), ROLLBACK.
-- Never touches production. Never COMMITs schema changes.

\set ON_ERROR_STOP on

BEGIN;

CREATE SCHEMA IF NOT EXISTS atomic_claim_parse;
SET LOCAL search_path TO atomic_claim_parse, public;

CREATE TABLE atomic_claim_parse.trips (
  id uuid PRIMARY KEY,
  status text,
  final_customer_fare_pence integer,
  gross_fare_pence integer
);

CREATE TABLE atomic_claim_parse.trip_change_requests (
  id uuid PRIMARY KEY,
  trip_id uuid REFERENCES atomic_claim_parse.trips(id),
  status text,
  payment_status text,
  original_fare_pence integer,
  new_fare_pence integer,
  fare_delta_pence integer,
  payment_confirmed_at timestamptz,
  rejection_reason text,
  updated_at timestamptz
);

CREATE TABLE atomic_claim_parse.payment_sessions (
  id uuid PRIMARY KEY,
  trip_id uuid,
  provider_order_id text,
  purpose text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE atomic_claim_parse.payment_session_authorisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_session_id uuid,
  payment_provider text,
  provider_order_id text,
  authorised_amount_pence integer,
  authorised_at timestamptz,
  status text,
  source text,
  trip_change_request_id uuid,
  requested_target_total_pence integer,
  provider_confirmed_total_pence integer,
  cumulative_total_authorised_pence integer,
  idempotency_key text,
  metadata jsonb,
  verified_at timestamptz
);

CREATE TABLE atomic_claim_parse.trip_modification_apply_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL,
  trip_change_request_id uuid NOT NULL UNIQUE,
  event_type text NOT NULL,
  fare_delta_pence integer NOT NULL DEFAULT 0,
  new_fare_pence integer,
  authorised_total_pence integer,
  created_at timestamptz DEFAULT now()
);

-- Stub advance used by claim body.
CREATE OR REPLACE FUNCTION atomic_claim_parse.advance_trip_change_after_payment(p_request_id uuid)
RETURNS atomic_claim_parse.trip_change_requests
LANGUAGE plpgsql AS $$
DECLARE r atomic_claim_parse.trip_change_requests%ROWTYPE;
BEGIN
  UPDATE atomic_claim_parse.trip_change_requests
  SET status = 'applied', updated_at = now()
  WHERE id = p_request_id
  RETURNING * INTO r;
  RETURN r;
END;
$$;

CREATE UNIQUE INDEX uq_psa_additional_auth_confirmed_per_modification
  ON atomic_claim_parse.payment_session_authorisations (trip_change_request_id)
  WHERE trip_change_request_id IS NOT NULL
    AND status = 'ADDITIONAL_AUTHORISATION_CONFIRMED';

CREATE UNIQUE INDEX uq_psa_idempotency_key_not_null
  ON atomic_claim_parse.payment_session_authorisations (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION atomic_claim_parse.trip_has_unresolved_fare_increase_modification(
  p_trip_id uuid
) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM atomic_claim_parse.trip_change_requests r
    WHERE r.trip_id = p_trip_id
      AND COALESCE(r.fare_delta_pence, 0) > 0
      AND r.status IN ('payment_required', 'payment_pending', 'payment_confirmed')
  );
$$;

CREATE OR REPLACE FUNCTION atomic_claim_parse.claim_and_apply_fare_increase_modification(
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
  v_trip atomic_claim_parse.trips%ROWTYPE;
  v_req atomic_claim_parse.trip_change_requests%ROWTYPE;
  v_advanced atomic_claim_parse.trip_change_requests%ROWTYPE;
  v_claimed int;
  v_current_fare int;
  v_required int;
  v_authorised int;
  v_session_id uuid;
  v_order_id text;
  v_event_inserted int := 0;
BEGIN
  v_required := GREATEST(0, COALESCE(p_required_authorised_total_pence, 0));
  v_authorised := GREATEST(0, COALESCE(p_authorised_total_pence, 0));

  SELECT * INTO v_trip FROM atomic_claim_parse.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STALE_MODIFICATION' USING ERRCODE = 'P0001'; END IF;

  SELECT * INTO v_req FROM atomic_claim_parse.trip_change_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'STALE_MODIFICATION' USING ERRCODE = 'P0001'; END IF;

  IF v_req.status = 'applied' THEN
    RETURN jsonb_build_object('ok', true, 'code', 'ALREADY_APPLIED');
  END IF;

  IF p_provider_confirmed IS NOT TRUE OR v_authorised < v_required OR v_required <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_NOT_CONFIRMED' USING ERRCODE = 'P0001';
  END IF;

  IF lower(COALESCE(v_trip.status, '')) IS DISTINCT FROM lower(trim(COALESCE(p_expected_trip_status, ''))) THEN
    RAISE EXCEPTION 'STALE_MODIFICATION' USING ERRCODE = 'P0001';
  END IF;

  v_current_fare := COALESCE(NULLIF(v_trip.final_customer_fare_pence, 0), NULLIF(v_trip.gross_fare_pence, 0), 0);
  IF v_current_fare IS DISTINCT FROM COALESCE(p_expected_original_fare_pence, -1) THEN
    RAISE EXCEPTION 'STALE_MODIFICATION' USING ERRCODE = 'P0001';
  END IF;

  UPDATE atomic_claim_parse.trip_change_requests
  SET payment_status = 'confirmed',
      payment_confirmed_at = COALESCE(payment_confirmed_at, now()),
      status = 'payment_confirmed',
      updated_at = now()
  WHERE id = p_request_id
    AND status IN ('payment_required', 'payment_pending', 'payment_confirmed')
    AND COALESCE(fare_delta_pence, 0) > 0
  RETURNING * INTO v_req;

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RAISE EXCEPTION 'STALE_MODIFICATION' USING ERRCODE = 'P0001';
  END IF;

  SELECT ps.id, ps.provider_order_id INTO v_session_id, v_order_id
  FROM atomic_claim_parse.payment_sessions ps
  WHERE ps.trip_id = p_trip_id
  ORDER BY ps.created_at DESC LIMIT 1;

  IF v_session_id IS NOT NULL THEN
    INSERT INTO atomic_claim_parse.payment_session_authorisations (
      payment_session_id, payment_provider, provider_order_id,
      authorised_amount_pence, authorised_at, status, source,
      trip_change_request_id, requested_target_total_pence,
      provider_confirmed_total_pence, cumulative_total_authorised_pence,
      idempotency_key, metadata, verified_at
    ) VALUES (
      v_session_id, 'revolut', COALESCE(v_order_id, 'ord'),
      v_authorised, now(), 'ADDITIONAL_AUTHORISATION_CONFIRMED',
      'fare_increase_modification', p_request_id, v_required,
      v_authorised, v_authorised,
      'mod_auth_confirmed:' || p_request_id::text || ':' || v_required::text,
      '{}'::jsonb, now()
    )
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT * INTO v_advanced FROM atomic_claim_parse.advance_trip_change_after_payment(p_request_id);

  UPDATE atomic_claim_parse.trips
  SET final_customer_fare_pence = v_req.new_fare_pence,
      gross_fare_pence = v_req.new_fare_pence
  WHERE id = p_trip_id
    AND final_customer_fare_pence = p_expected_original_fare_pence;

  INSERT INTO atomic_claim_parse.trip_modification_apply_events (
    trip_id, trip_change_request_id, event_type, fare_delta_pence, new_fare_pence, authorised_total_pence
  ) VALUES (
    p_trip_id, p_request_id, 'MODIFICATION_APPLIED',
    COALESCE(v_req.fare_delta_pence, 0), v_req.new_fare_pence, v_authorised
  )
  ON CONFLICT (trip_change_request_id) DO NOTHING;

  GET DIAGNOSTICS v_event_inserted = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'MODIFICATION_APPLIED',
    'fare_delta_pence', COALESCE(v_req.fare_delta_pence, 0),
    'apply_event_inserted', v_event_inserted > 0
  );
END;
$$;

INSERT INTO atomic_claim_parse.trips VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'in_progress', 500, 500
);
INSERT INTO atomic_claim_parse.trip_change_requests VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'payment_pending', 'pending', 500, 811, 311, NULL, NULL, now()
);
INSERT INTO atomic_claim_parse.payment_sessions VALUES (
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'ord_test', NULL, now()
);

SELECT atomic_claim_parse.claim_and_apply_fare_increase_modification(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  500, 'in_progress', 811, true, 811
) AS first_claim;

SELECT atomic_claim_parse.claim_and_apply_fare_increase_modification(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  500, 'in_progress', 811, true, 811
) AS second_claim;

DO $$
BEGIN
  IF (SELECT count(*) FROM atomic_claim_parse.trip_modification_apply_events) <> 1 THEN
    RAISE EXCEPTION 'parse harness: expected 1 event';
  END IF;
  IF (SELECT count(*) FROM atomic_claim_parse.payment_session_authorisations
      WHERE status = 'ADDITIONAL_AUTHORISATION_CONFIRMED') <> 1 THEN
    RAISE EXCEPTION 'parse harness: expected 1 auth confirm';
  END IF;
  IF (SELECT final_customer_fare_pence FROM atomic_claim_parse.trips
      WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') <> 811 THEN
    RAISE EXCEPTION 'parse harness: fare not applied once';
  END IF;
  IF atomic_claim_parse.trip_has_unresolved_fare_increase_modification(
       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') IS TRUE THEN
    RAISE EXCEPTION 'parse harness: applied request still unresolved';
  END IF;
  RAISE NOTICE 'PARSE_HARNESS_INVARIANTS_OK';
END $$;

ROLLBACK;

SELECT 'ATOMIC_CLAIM_PARSE_ROLLBACK_PASS' AS verdict;
