-- P0 SQL contract tests (run via: supabase db query --linked -f ...)
-- Covers: B, D, E, F, L — one live immediate trip per passenger + scheduled coexistence.

DO $$
DECLARE
  v_sa uuid;
  v_customer uuid;
  v_user uuid;
  v_ps1 uuid;
  v_ps2 uuid;
  v_trip1 uuid;
  v_trip2 uuid;
  v_sched uuid;
  v_live uuid;
  v_err text;
  v_extra int;
BEGIN
  SELECT id INTO v_sa FROM public.service_areas WHERE is_active = true LIMIT 1;
  IF v_sa IS NULL THEN
    RAISE EXCEPTION 'P0_SQL_TEST_SETUP: no active service_area';
  END IF;

  -- Prefer a customer with zero live immediate trips.
  SELECT c.id, c.user_id INTO v_customer, v_user
  FROM public.customers c
  WHERE c.user_id IS NOT NULL
    AND public.passenger_has_live_immediate_trip(c.id, NULL) IS NULL
  LIMIT 1;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'P0_SQL_TEST_SETUP: no idle customer';
  END IF;

  -- L: scheduled trip must NOT block immediate unique index / live check
  INSERT INTO public.trips (
    passenger_id, pickup_address, dropoff_address,
    payment_method, payment_type, trip_type, status,
    currency_code, service_area_id, booking_source,
    is_scheduled, scheduled_at, estimated_fare
  ) VALUES (
    v_customer, 'P0-SCHED-PICKUP', 'P0-SCHED-DROPOFF',
    'WALLET', 'WALLET', 'scheduled', 'scheduled',
    'gbp', v_sa, 'p0_sql_contract',
    true, now() + interval '2 days', 10
  ) RETURNING id INTO v_sched;

  IF public.passenger_has_live_immediate_trip(v_customer, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'P0_SQL_L_FAIL: scheduled trip incorrectly counted as live immediate';
  END IF;

  INSERT INTO public.payment_sessions (
    user_id, customer_id, service_area_id, currency,
    estimated_total_pence, authorised_amount_pence, total_authorised_amount_pence, buffer_pence,
    payment_method, status, payment_provider, provider_state,
    provider_order_id, purpose, client_action_id, idempotency_key,
    booking_snapshot, authorised_at
  ) VALUES (
    v_user, v_customer, v_sa, 'GBP',
    800, 800, 800, 0,
    'CARD', 'payment_authorised', 'revolut', 'AUTHORISED',
    'p0_test_ord_' || gen_random_uuid()::text, 'RIDE_BOOKING', gen_random_uuid(), gen_random_uuid()::text,
    jsonb_build_object(
      'passenger_id', v_customer,
      'passenger_name', 'P0 Test',
      'passenger_phone', '',
      'pickup', jsonb_build_object('address', 'A', 'lat', 52.04, 'lng', -0.76),
      'dropoff', jsonb_build_object('address', 'B', 'lat', 52.05, 'lng', -0.75),
      'final_fare_pence', 800,
      'estimated_total_pence', 800,
      'payment_method', 'CARD',
      'when', 'now'
    ),
    now()
  ) RETURNING id INTO v_ps1;

  v_trip1 := public.finalize_paid_booking_session(v_ps1);
  IF v_trip1 IS NULL THEN
    RAISE EXCEPTION 'P0_SQL_B_FAIL: first finalize returned null';
  END IF;

  -- B: same session finalised twice → same trip
  IF public.finalize_paid_booking_session(v_ps1) IS DISTINCT FROM v_trip1 THEN
    RAISE EXCEPTION 'P0_SQL_B_FAIL: duplicate finalize returned different trip';
  END IF;

  INSERT INTO public.payment_sessions (
    user_id, customer_id, service_area_id, currency,
    estimated_total_pence, authorised_amount_pence, total_authorised_amount_pence, buffer_pence,
    payment_method, status, payment_provider, provider_state,
    provider_order_id, purpose, client_action_id, idempotency_key,
    booking_snapshot, authorised_at
  ) VALUES (
    v_user, v_customer, v_sa, 'GBP',
    800, 800, 800, 0,
    'CARD', 'payment_authorised', 'revolut', 'AUTHORISED',
    'p0_test_ord_' || gen_random_uuid()::text, 'RIDE_BOOKING', gen_random_uuid(), gen_random_uuid()::text,
    jsonb_build_object(
      'passenger_id', v_customer,
      'passenger_name', 'P0 Test',
      'passenger_phone', '',
      'pickup', jsonb_build_object('address', 'A2', 'lat', 52.04, 'lng', -0.76),
      'dropoff', jsonb_build_object('address', 'B2', 'lat', 52.05, 'lng', -0.75),
      'final_fare_pence', 800,
      'estimated_total_pence', 800,
      'payment_method', 'CARD',
      'when', 'now'
    ),
    now()
  ) RETURNING id INTO v_ps2;

  -- D: late authorised session must NOT create second trip
  BEGIN
    v_trip2 := public.finalize_paid_booking_session(v_ps2);
    RAISE EXCEPTION 'P0_SQL_D_FAIL: second finalize succeeded trip=%', v_trip2;
  EXCEPTION
    WHEN others THEN
      v_err := SQLERRM;
      IF position('CUSTOMER_ALREADY_HAS_ACTIVE_TRIP' in v_err) = 0 THEN
        RAISE EXCEPTION 'P0_SQL_D_FAIL: expected CUSTOMER_ALREADY_HAS_ACTIVE_TRIP got %', v_err;
      END IF;
  END;

  -- F: caller persists orphan (webhook/CTAP pattern) — no trip on session 2
  UPDATE public.payment_sessions
     SET status = 'payment_orphaned',
         updated_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'orphan_reason', 'CUSTOMER_ALREADY_HAS_ACTIVE_TRIP',
           'existing_trip_id', v_trip1,
           'never_capture', true
         )
   WHERE id = v_ps2
     AND trip_id IS NULL;

  IF (SELECT trip_id FROM public.payment_sessions WHERE id = v_ps2) IS NOT NULL THEN
    RAISE EXCEPTION 'P0_SQL_F_FAIL: orphaned session unexpectedly linked to trip';
  END IF;
  IF (SELECT status::text FROM public.payment_sessions WHERE id = v_ps2) <> 'payment_orphaned' THEN
    RAISE EXCEPTION 'P0_SQL_F_FAIL: expected payment_orphaned got %',
      (SELECT status::text FROM public.payment_sessions WHERE id = v_ps2);
  END IF;

  SELECT count(*) INTO v_extra
  FROM public.trips t
  WHERE t.passenger_id = v_customer
    AND t.booking_source = 'customer_app'  -- finalize default
    AND t.id <> v_trip1
    AND t.created_at > now() - interval '2 minutes';
  IF v_extra > 0 THEN
    RAISE EXCEPTION 'P0_SQL_D_FAIL: second live trip was created (extra=%)', v_extra;
  END IF;

  v_live := public.passenger_has_live_immediate_trip(v_customer, NULL);
  IF v_live IS DISTINCT FROM v_trip1 THEN
    RAISE EXCEPTION 'P0_SQL_E_FAIL: live trip mismatch expected=% got=%', v_trip1, v_live;
  END IF;

  -- Cleanup test rows only
  DELETE FROM public.trips WHERE id IN (v_trip1, v_sched);
  DELETE FROM public.payment_sessions WHERE id IN (v_ps1, v_ps2);

  RAISE NOTICE 'P0_SQL_CONTRACT_OK B/D/E/F/L';
END $$;
