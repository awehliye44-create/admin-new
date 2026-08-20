-- Step 8.2A.4 — PostgreSQL atomic refund RPC integration tests (throwaway DB).
-- Applied after bootstrap + migration 20260930150000.

BEGIN;

INSERT INTO public.drivers (id, user_id)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', gen_random_uuid());

INSERT INTO public.trips (
  id, driver_id, status, payment_status, financial_model,
  capture_amount_pence, commission_pence, driver_net_pence,
  final_fare_pence, final_customer_fare_pence
) VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'completed', 'captured', 'PLATFORM_COLLECTED',
  1250, 250, 1000, 1250, 1250
);

INSERT INTO public.payment_sessions (
  id, trip_id, purpose, payment_provider, status,
  captured_amount_pence, authorised_amount_pence, currency
) VALUES (
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'RIDE_BOOKING', 'revolut', 'captured',
  1250, 1250, 'gbp'
);

INSERT INTO public.payments (id, trip_id, driver_id, amount_pence, captured_amount_pence, status)
VALUES (gen_random_uuid(), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1250, 1250, 'captured');

INSERT INTO public.trip_finance (id, trip_id, driver_id, financial_status)
VALUES (gen_random_uuid(), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CAPTURED');

INSERT INTO public.driver_wallet_ledger (driver_id, related_trip_id, type, amount_pence)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'TRIP_EARNING_NET', 1000);

DO $$
DECLARE
  v_result jsonb;
  v_child_count integer;
  v_debit_sum integer;
BEGIN
  -- Prove broad unique_trip_ledger_entry removed: second REFUND_DEBIT with lineage allowed.
  v_result := public.apply_confirmed_provider_refund_atomic(
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'revolut', 'pg-ref-a', 250, 250,
    NULL, NULL, NULL, 'admin_refund', false
  );
  IF (v_result->>'status') <> 'applied' THEN
    RAISE EXCEPTION 'case1 failed: %', v_result;
  END IF;

  v_result := public.apply_confirmed_provider_refund_atomic(
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'revolut', 'pg-ref-b', 375, 625,
    NULL, NULL, NULL, 'admin_refund', false
  );
  IF (v_result->>'status') <> 'applied' THEN
    RAISE EXCEPTION 'case2 failed: %', v_result;
  END IF;

  SELECT count(*) INTO v_child_count FROM public.payment_session_refunds;
  SELECT coalesce(sum(abs(amount_pence)),0) INTO v_debit_sum
  FROM public.driver_wallet_ledger WHERE type='REFUND_DEBIT';

  IF v_child_count <> 2 OR v_debit_sum <> 500 THEN
    RAISE EXCEPTION 'multi partial failed child=% debit=%', v_child_count, v_debit_sum;
  END IF;

  v_result := public.apply_confirmed_provider_refund_atomic(
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'revolut', 'pg-ref-a', 250, 625,
    NULL, NULL, NULL, 'admin_refund', false
  );
  IF (v_result->>'status') <> 'already_applied' THEN
    RAISE EXCEPTION 'idempotent retry failed: %', v_result;
  END IF;

  RAISE NOTICE 'apply_confirmed_provider_refund_atomic PostgreSQL harness: PASS';
END $$;

ROLLBACK;
