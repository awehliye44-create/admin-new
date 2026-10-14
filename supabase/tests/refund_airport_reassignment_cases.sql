-- Cases against the production refund and eligibility functions.

INSERT INTO public.drivers (id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd');

-- 1. Same provider refund id applied twice.
INSERT INTO public.trips (
  id, driver_id, status, payment_status, financial_model, payment_method,
  capture_amount_pence, commission_pence, driver_net_pence, airport_charge_pence,
  final_fare_pence, currency, completed_at
) VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'completed', 'captured', 'PLATFORM_COLLECTED', 'card',
  1250, 250, 1000, 0, 1250, 'GBP', now() - interval '2 days'
);
INSERT INTO public.payment_sessions (
  id, trip_id, purpose, payment_provider, status, captured_amount_pence, currency, captured_at
) VALUES (
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'RIDE_BOOKING', 'revolut', 'captured', 1250, 'gbp', now() - interval '2 days'
);
INSERT INTO public.payments (trip_id, driver_id, amount_pence, captured_amount_pence, status)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1250, 1250, 'captured');
INSERT INTO public.trip_finance (trip_id, driver_id, financial_status)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'CAPTURED');
INSERT INTO public.driver_wallet_ledger (driver_id, related_trip_id, type, amount_pence)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'TRIP_EARNING_NET', 1000);

-- 2. Airport fee is part of the credited earning and of the reversal.
INSERT INTO public.trips (
  id, driver_id, status, payment_status, financial_model, payment_method,
  capture_amount_pence, commission_pence, driver_net_pence, airport_charge_pence,
  final_fare_pence, currency, completed_at
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  'completed', 'captured', 'PLATFORM_COLLECTED', 'card',
  1200, 0, 1000, 200, 1200, 'GBP', now() - interval '2 days'
);
INSERT INTO public.payment_sessions (
  id, trip_id, purpose, payment_provider, status, captured_amount_pence, currency, captured_at, metadata
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'RIDE_BOOKING', 'revolut', 'captured', 1200, 'gbp', now() - interval '2 days',
  jsonb_build_object('first_captured_at', (now() - interval '2 days')::text)
);
INSERT INTO public.payments (trip_id, driver_id, amount_pence, captured_amount_pence, status)
VALUES ('11111111-1111-1111-1111-111111111111', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 1200, 1200, 'captured');
INSERT INTO public.trip_finance (trip_id, driver_id, financial_status)
VALUES ('11111111-1111-1111-1111-111111111111', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'CAPTURED');
INSERT INTO public.driver_wallet_ledger (driver_id, related_trip_id, type, amount_pence, created_at)
VALUES (
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  '11111111-1111-1111-1111-111111111111',
  'TRIP_EARNING_NET', 1200, now() - interval '2 days'
);

-- 3. Trip driver was cleared; the earning stays on the previous driver.
INSERT INTO public.trips (
  id, driver_id, previous_driver_id, status, payment_status, financial_model, payment_method,
  capture_amount_pence, commission_pence, driver_net_pence, airport_charge_pence,
  final_fare_pence, currency, completed_at
) VALUES (
  '33333333-3333-3333-3333-333333333333',
  NULL,
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'completed', 'captured', 'PLATFORM_COLLECTED', 'card',
  1250, 250, 1000, 0, 1250, 'GBP', now() - interval '2 days'
);
INSERT INTO public.payment_sessions (
  id, trip_id, purpose, payment_provider, status, captured_amount_pence, currency, captured_at
) VALUES (
  '44444444-4444-4444-4444-444444444444',
  '33333333-3333-3333-3333-333333333333',
  'RIDE_BOOKING', 'revolut', 'captured', 1250, 'gbp', now() - interval '2 days'
);
INSERT INTO public.payments (trip_id, amount_pence, captured_amount_pence, status)
VALUES ('33333333-3333-3333-3333-333333333333', 1250, 1250, 'captured');
INSERT INTO public.trip_finance (trip_id, financial_status)
VALUES ('33333333-3333-3333-3333-333333333333', 'CAPTURED');
INSERT INTO public.driver_wallet_ledger (driver_id, related_trip_id, type, amount_pence)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'TRIP_EARNING_NET', 1000);

DO $$
DECLARE
  v jsonb;
  v_rows integer;
  v_debit integer;
  v_driver uuid;
  v_eligible bigint;
BEGIN
  v := public.apply_confirmed_provider_refund_atomic(
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'revolut', 'pg-ref-once', 1250, 1250,
    NULL, NULL, NULL, 'admin_refund', false
  );
  IF v->>'status' IS DISTINCT FROM 'applied' OR (v->>'inserted_debit_pence')::int IS DISTINCT FROM 1000 THEN
    RAISE EXCEPTION 'first refund failed: %', v;
  END IF;

  v := public.apply_confirmed_provider_refund_atomic(
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'revolut', 'pg-ref-once', 1250, 1250,
    NULL, NULL, NULL, 'admin_refund', false
  );
  IF v->>'status' IS DISTINCT FROM 'already_applied' THEN
    RAISE EXCEPTION 'retry was not already applied: %', v;
  END IF;
  SELECT count(*) INTO v_rows FROM public.payment_session_refunds
  WHERE provider_refund_id = 'pg-ref-once';
  SELECT count(*) INTO v_debit FROM public.driver_wallet_ledger
  WHERE provider_refund_id = 'pg-ref-once' AND type = 'REFUND_DEBIT';
  IF v_rows IS DISTINCT FROM 1 OR v_debit IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'duplicate refund rows child=% debit=%', v_rows, v_debit;
  END IF;

  SELECT eligible_earnings_pence INTO v_eligible
  FROM public.driver_wallet_eligibility_balances('dddddddd-dddd-dddd-dddd-dddddddddddd');
  -- Airport trip credit is 1200 (1000 net + 200 airport). The partial refund above
  -- is a different trip and does not remove this credit.
  IF v_eligible IS DISTINCT FROM 1200 THEN
    RAISE EXCEPTION 'airport earning not eligible: %', v_eligible;
  END IF;

  v := public.apply_confirmed_provider_refund_atomic(
    '11111111-1111-1111-1111-111111111111', 'revolut', 'pg-ref-airport', 1200, 1200,
    NULL, NULL, NULL, 'admin_refund', false
  );
  IF (v->>'inserted_debit_pence')::int IS DISTINCT FROM 1200 THEN
    RAISE EXCEPTION 'airport reversal was not the credited amount: %', v;
  END IF;

  v := public.apply_confirmed_provider_refund_atomic(
    '33333333-3333-3333-3333-333333333333', 'revolut', 'pg-ref-reassign', 1250, 1250,
    NULL, NULL, NULL, 'admin_refund', false
  );
  SELECT driver_id, abs(amount_pence) INTO v_driver, v_debit
  FROM public.driver_wallet_ledger
  WHERE provider_refund_id = 'pg-ref-reassign' AND type = 'REFUND_DEBIT';
  IF v_driver IS DISTINCT FROM 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' OR v_debit IS DISTINCT FROM 1000 THEN
    RAISE EXCEPTION 'reassignment debit went to the wrong driver: % % result %', v_driver, v_debit, v;
  END IF;

  RAISE NOTICE 'refund, airport and reassignment: PASS';
END;
$$;
