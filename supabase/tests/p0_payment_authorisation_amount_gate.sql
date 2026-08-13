-- Contract tests for P0 payment authorisation amount gate / fare lineage.
-- Run after migration 20260919120000 is applied.

BEGIN;

DO $$
DECLARE
  v_fare RECORD;
  v_ok boolean;
BEGIN
  -- 4-6: discount persists; gross != payable
  SELECT * INTO v_fare FROM public.resolve_booking_customer_payable_pence(
    jsonb_build_object(
      'gross_fare_pence', 875,
      'discount_amount_pence', 87,
      'final_estimated_fare_pence', 788
    ),
    jsonb_build_object(
      'gross_fare_pence', 875,
      'offer_discount_pence', 87,
      'final_fare_pence', 788,
      'estimated_total_pence', 788,
      'authorised_amount_pence', 788
    ),
    788,
    788
  );
  IF v_fare.gross_fare_pence <> 875 THEN
    RAISE EXCEPTION 'TEST FAIL: gross expected 875 got %', v_fare.gross_fare_pence;
  END IF;
  IF v_fare.discount_pence <> 87 THEN
    RAISE EXCEPTION 'TEST FAIL: discount expected 87 got %', v_fare.discount_pence;
  END IF;
  IF v_fare.customer_payable_pence <> 788 THEN
    RAISE EXCEPTION 'TEST FAIL: payable expected 788 got %', v_fare.customer_payable_pence;
  END IF;

  -- booking_snapshot alone (no final_fare_pence) must not fall through to gross
  SELECT * INTO v_fare FROM public.resolve_booking_customer_payable_pence(
    jsonb_build_object('gross_fare_pence', 875, 'discount_amount_pence', 87),
    '{}'::jsonb,
    NULL,
    788
  );
  IF v_fare.customer_payable_pence <> 788 THEN
    RAISE EXCEPTION 'TEST FAIL: booking-only payable expected 788 got %', v_fare.customer_payable_pence;
  END IF;

  -- 6: valid discount must not look like shortfall vs authorised
  IF v_fare.customer_payable_pence <> 788 THEN
    RAISE EXCEPTION 'TEST FAIL: discount path looks like shortfall';
  END IF;

  RAISE NOTICE 'p0_payment_authorisation_amount_gate lineage tests PASS';
END $$;

-- Dispatch SSOT must contain amount gate
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.dispatch_trip_offers(uuid,text)'::regprocedure) INTO v_def;
  IF position('assert_payment_gate(p_trip_id)' in v_def) = 0 THEN
    RAISE EXCEPTION 'TEST FAIL: dispatch_trip_offers missing assert_payment_gate';
  END IF;
  IF position('PAYMENT_AUTHORISATION_INSUFFICIENT' in v_def) = 0 THEN
    RAISE EXCEPTION 'TEST FAIL: dispatch_trip_offers missing PAYMENT_AUTHORISATION_INSUFFICIENT code';
  END IF;
  RAISE NOTICE 'p0 dispatch gate presence PASS';
END $$;

-- Accept must re-assert amount gate after fare lock
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.accept_ride_offer(uuid,uuid,boolean)'::regprocedure) INTO v_def;
  IF position('assert_payment_gate(v_offer.trip_id)' in v_def) = 0 THEN
    RAISE EXCEPTION 'TEST FAIL: accept_ride_offer missing post-fare assert_payment_gate';
  END IF;
  RAISE NOTICE 'p0 accept reassert gate PASS';
END $$;

ROLLBACK;
