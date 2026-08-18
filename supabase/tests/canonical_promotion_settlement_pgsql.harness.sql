-- Throwaway Postgres harness for canonical promotion settlement (Step 2A.1).
-- Requires: public.trips, public.ride_offers, resolve_driver_tier_commission_percent stub.

\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.resolve_driver_tier_commission_percent(p_driver_id uuid, p_service_area_id uuid)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 15::numeric;
$$;

DO $assert$
DECLARE
  v_missing text;
BEGIN
  IF to_regclass('public.trips') IS NULL OR to_regclass('public.ride_offers') IS NULL THEN
    RAISE EXCEPTION 'harness schema missing — run setup first';
  END IF;
END;
$assert$;

-- E: promoted trip 500/20/15%
DO $test_e$
DECLARE
  v_trip_id uuid := '11111111-1111-4111-8111-111111111111';
  v_offer_id uuid := '22222222-2222-4222-8222-222222222222';
  v_t public.trips;
BEGIN
  INSERT INTO public.trips (
    id, discount_source, offer_discount_pence, locked_base_fare_pence, gross_fare_pence,
    final_fare_pence, final_customer_fare_pence, fare_snapshot_json, airport_charge_pence
  ) VALUES (
    v_trip_id, 'global_offer', 20, 500, 500, 480, 480,
    '{"original_fare_pence":500,"gross_fare_pence":500}'::jsonb, 0
  );
  INSERT INTO public.ride_offers (
    id, trip_id, effective_commission_percent, dispatch_wave, dispatch_round,
    wave_commission_reduction_percent, offered_driver_net_pence
  ) VALUES (v_offer_id, v_trip_id, 15, 1, 1, 0, 425);

  PERFORM public.snapshot_accepted_wave_commission(v_trip_id, v_offer_id);
  SELECT * INTO v_t FROM public.trips WHERE id = v_trip_id;

  IF v_t.commissionable_fare_pence <> 500 THEN
    RAISE EXCEPTION 'E commissionable expected 500 got %', v_t.commissionable_fare_pence;
  END IF;
  IF v_t.commission_pence <> 75 THEN
    RAISE EXCEPTION 'E commission expected 75 got %', v_t.commission_pence;
  END IF;
  IF v_t.driver_net_pence <> 425 THEN
    RAISE EXCEPTION 'E driver_net expected 425 got %', v_t.driver_net_pence;
  END IF;
  IF (v_t.fare_snapshot_json->>'commission_after_promotion_pence')::int <> 55 THEN
    RAISE EXCEPTION 'E after-promo expected 55 got %', v_t.fare_snapshot_json->>'commission_after_promotion_pence';
  END IF;
  RAISE NOTICE 'PASS E — promoted trip 500/20/15%%';
END;
$test_e$;

-- A: missing evidence must rollback without stamps
DO $test_a$
DECLARE
  v_trip_id uuid := '33333333-3333-4333-8333-333333333333';
  v_offer_id uuid := '44444444-4444-4444-8444-444444444444';
  v_t public.trips;
  v_err text;
BEGIN
  INSERT INTO public.trips (
    id, discount_source, offer_discount_pence, final_fare_pence, final_customer_fare_pence,
    fare_snapshot_json, airport_charge_pence
  ) VALUES (
    v_trip_id, 'global_offer', 20, 480, 480, '{}'::jsonb, 0
  );
  INSERT INTO public.ride_offers (
    id, trip_id, effective_commission_percent, dispatch_wave, dispatch_round
  ) VALUES (v_offer_id, v_trip_id, 15, 1, 1);

  BEGIN
    PERFORM public.snapshot_accepted_wave_commission(v_trip_id, v_offer_id);
    RAISE EXCEPTION 'A expected PRE_PROMOTION_FARE_EVIDENCE_MISSING';
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      v_err := SQLERRM;
      IF v_err NOT LIKE '%PRE_PROMOTION_FARE_EVIDENCE_MISSING%' THEN
        RAISE EXCEPTION 'A wrong error: %', v_err;
      END IF;
  END;

  SELECT * INTO v_t FROM public.trips WHERE id = v_trip_id;
  IF v_t.commissionable_fare_pence IS NOT NULL OR v_t.commission_pence IS NOT NULL OR v_t.driver_net_pence IS NOT NULL THEN
    RAISE EXCEPTION 'A settlement stamps must remain NULL after rollback';
  END IF;
  RAISE NOTICE 'PASS A — missing evidence fail-closed';
END;
$test_a$;

-- B: negotiated fare supersedes promotion
DO $test_b$
DECLARE
  v_trip_id uuid := '55555555-5555-4555-8555-555555555555';
  v_offer_id uuid := '66666666-6666-4666-8666-666666666666';
  v_driver_id uuid := '77777777-7777-4777-8777-777777777777';
  v_result jsonb;
BEGIN
  INSERT INTO public.trips (
    id, discount_source, offer_discount_pence, gross_fare_pence, locked_base_fare_pence,
    final_fare_pence, final_customer_fare_pence,
    fare_snapshot_json, airport_charge_pence, service_area_id
  ) VALUES (
    v_trip_id, 'global_offer', 20, 500, 500, 480, 480,
    '{"original_fare_pence":500,"gross_fare_pence":500}'::jsonb, 0, gen_random_uuid()
  );
  INSERT INTO public.ride_offers (
    id, trip_id, effective_commission_percent, dispatch_wave, dispatch_round
  ) VALUES (v_offer_id, v_trip_id, 15, 1, 1);

  v_result := public.commit_negotiation_fare(v_trip_id, 520, 'negotiated_offer', v_offer_id, v_driver_id);

  IF (v_result->>'applied_customer_promotion_pence')::int <> 0 THEN
    RAISE EXCEPTION 'B applied promo must be 0 got %', v_result->>'applied_customer_promotion_pence';
  END IF;
  IF (v_result->>'previous_locked_promotion_pence')::int <> 20 THEN
    RAISE EXCEPTION 'B audit prior promo expected 20 got %', v_result->>'previous_locked_promotion_pence';
  END IF;
  IF (v_result->>'commissionable_fare_pence')::int <> 520 THEN
    RAISE EXCEPTION 'B commissionable expected 520 got %', v_result->>'commissionable_fare_pence';
  END IF;
  IF (v_result->>'commission_pence')::int <> 78 THEN
    RAISE EXCEPTION 'B commission expected 78 got %', v_result->>'commission_pence';
  END IF;
  IF (v_result->>'driver_net_pence')::int <> 442 THEN
    RAISE EXCEPTION 'B driver_net expected 442 got %', v_result->>'driver_net_pence';
  END IF;
  IF v_result->>'promotion_application_status' <> 'SUPERSEDED_BY_NEGOTIATION' THEN
    RAISE EXCEPTION 'B promotion status wrong: %', v_result->>'promotion_application_status';
  END IF;
  RAISE NOTICE 'PASS B — negotiated fare supersedes promotion';
END;
$test_b$;

-- C: negotiated + modification (resolver only — committed payable includes mod)
DO $test_c$
DECLARE
  v_trip_id uuid := '88888888-8888-4888-8888-888888888888';
  v_t public.trips;
  v_commissionable integer;
BEGIN
  INSERT INTO public.trips (
    id, discount_source, offer_discount_pence, locked_offer_type,
    accepted_driver_offer_fare_pence, final_fare_pence, final_customer_fare_pence,
    customer_modification_charge_pence, fare_snapshot_json, airport_charge_pence
  ) VALUES (
    v_trip_id, 'global_offer', 20, 'negotiated_offer', 520, 620, 620, 100,
    '{"fare_source":"negotiated","negotiated_commissionable_fare_pence":520,"promotion_application_status":"SUPERSEDED_BY_NEGOTIATION"}'::jsonb,
    0
  );

  SELECT * INTO v_t FROM public.trips WHERE id = v_trip_id;
  v_commissionable := public.resolve_trip_negotiated_commissionable_fare_pence(v_t, NULL);

  IF v_commissionable <> 620 THEN
    RAISE EXCEPTION 'C commissionable expected 620 got %', v_commissionable;
  END IF;
  RAISE NOTICE 'PASS C — negotiated + modification';
END;
$test_c$;

-- D: concurrent-style idempotent snapshot (second call same stamps)
DO $test_d$
DECLARE
  v_trip_id uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  v_offer_id uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  v_t1 public.trips;
  v_t2 public.trips;
BEGIN
  INSERT INTO public.trips (
    id, discount_source, offer_discount_pence, locked_base_fare_pence,
    final_fare_pence, final_customer_fare_pence, fare_snapshot_json, airport_charge_pence
  ) VALUES (
    v_trip_id, 'global_offer', 20, 500, 480, 480,
    '{"original_fare_pence":500}'::jsonb, 0
  );
  INSERT INTO public.ride_offers (
    id, trip_id, effective_commission_percent, dispatch_wave, dispatch_round
  ) VALUES (v_offer_id, v_trip_id, 15, 1, 1);

  PERFORM public.snapshot_accepted_wave_commission(v_trip_id, v_offer_id);
  SELECT * INTO v_t1 FROM public.trips WHERE id = v_trip_id;
  PERFORM public.snapshot_accepted_wave_commission(v_trip_id, v_offer_id);
  SELECT * INTO v_t2 FROM public.trips WHERE id = v_trip_id;

  IF v_t1.commissionable_fare_pence <> v_t2.commissionable_fare_pence
     OR v_t1.commission_pence <> v_t2.commission_pence
     OR v_t1.driver_net_pence <> v_t2.driver_net_pence THEN
    RAISE EXCEPTION 'D idempotent snapshot mismatch';
  END IF;
  RAISE NOTICE 'PASS D — idempotent snapshot';
END;
$test_d$;

-- Signature / security checks
DO $meta$
DECLARE
  v_rec record;
BEGIN
  FOR v_rec IN
    SELECT p.proname,
           pg_get_function_identity_arguments(p.oid) AS args,
           p.prosecdef AS security_definer,
           p.provolatile AS volatility
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'commit_negotiation_fare',
        'snapshot_accepted_wave_commission',
        'snapshot_driver_tier_commission_on_trip',
        'resolve_trip_commissionable_fare_pence'
      )
  LOOP
    RAISE NOTICE 'META %(%): definer=% volatility=%', v_rec.proname, v_rec.args, v_rec.security_definer, v_rec.volatility;
  END LOOP;
END;
$meta$;

SELECT 'ALL_PG_TESTS_PASSED' AS status;
