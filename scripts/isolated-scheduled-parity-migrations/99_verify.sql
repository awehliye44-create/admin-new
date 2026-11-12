-- Behavioural verification after applying migrations on isolated fixture.

DO $$
DECLARE
  v_fn text;
  v_trip_id uuid;
  v_session uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_customer uuid;
  v_user uuid;
  v_sa uuid;
  v_row public.trips%ROWTYPE;
  v_err text;
BEGIN
  SELECT id INTO v_sa FROM public.service_areas WHERE trip_id_prefix IS NOT NULL LIMIT 1;
  IF v_sa IS NULL THEN
    RAISE EXCEPTION 'no service_area with trip_id_prefix for fixture';
  END IF;
  SELECT id, user_id INTO v_customer, v_user FROM public.customers WHERE user_id IS NOT NULL LIMIT 1;
  IF v_customer IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'no customer with user_id for fixture';
  END IF;
  -- 1) Lifecycle function replaced with publication_pending INSERT path.
  SELECT pg_get_functiondef('public.enforce_scheduled_trip_lifecycle()'::regprocedure)
    INTO v_fn;
  IF position('publication_pending' in v_fn) = 0 THEN
    RAISE EXCEPTION 'lifecycle missing publication_pending';
  END IF;
  IF position('NEW.scheduled_broadcast_at := NULL' in v_fn) = 0 THEN
    RAISE EXCEPTION 'lifecycle missing null broadcast on INSERT hold';
  END IF;

  -- 2) Finalize enforces capture deadline + held create.
  SELECT pg_get_functiondef(
    'public.finalize_paid_booking_session(uuid)'::regprocedure
  ) INTO v_fn;
  IF position('CAPTURE_DEADLINE_MISSING' in v_fn) = 0 THEN
    RAISE EXCEPTION 'finalize missing CAPTURE_DEADLINE_MISSING';
  END IF;
  IF position('publication_pending' in v_fn) = 0 THEN
    RAISE EXCEPTION 'finalize missing publication_pending insert';
  END IF;
  IF position('admin_held' in v_fn) = 0 THEN
    RAISE EXCEPTION 'finalize missing admin_held';
  END IF;

  -- 3) Retirement patch present.
  SELECT pg_get_functiondef(
    'public.admin_scheduled_emergency_mutate(text,uuid,uuid,text,jsonb,jsonb)'::regprocedure
  ) INTO v_fn;
  IF position('RETIRED_MANUAL_SCHEDULED_CONTROL' in v_fn) = 0 THEN
    RAISE EXCEPTION 'admin mutate missing RETIRED_MANUAL_SCHEDULED_CONTROL';
  END IF;

  -- 4) INSERT trigger: routine create → held + null broadcast + publication_pending.
  INSERT INTO public.payment_sessions (
    id, customer_id, user_id, client_action_id, idempotency_key, status, provider_state,
    authorised_amount_pence, service_area_id, payment_method, currency
  ) VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', v_customer, v_user, 'verify-caa-1', 'verify-idemp-1',
    'authorised_hold', 'AUTHORISED', 800, v_sa, 'APPLE_PAY', 'gbp'
  ) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.trips (
    passenger_id, status, is_scheduled, scheduled_at, trip_type,
    booking_source, dispatch_mode, payment_method, service_area_id, payment_session_id,
    pickup_address, pickup_latitude, pickup_longitude,
    dropoff_address, dropoff_latitude, dropoff_longitude
  ) VALUES (
    v_customer, 'searching', true, now() + interval '2 hours', 'scheduled',
    'choose_ride', 'scheduled', 'APPLE_PAY', v_sa, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'Pickup A', 52.04, -0.76, 'Dropoff B', 52.05, -0.75
  ) RETURNING * INTO v_row;

  IF v_row.scheduled_status IS DISTINCT FROM 'admin_held' THEN
    RAISE EXCEPTION 'lifecycle INSERT scheduled_status=%', v_row.scheduled_status;
  END IF;
  IF v_row.scheduled_broadcast_at IS NOT NULL THEN
    RAISE EXCEPTION 'lifecycle INSERT broadcast_at should be null, got %', v_row.scheduled_broadcast_at;
  END IF;
  IF v_row.scheduled_hold_reason IS DISTINCT FROM 'publication_pending' THEN
    RAISE EXCEPTION 'lifecycle INSERT hold=%', v_row.scheduled_hold_reason;
  END IF;
  IF v_row.scheduled_convert_at IS NULL THEN
    RAISE EXCEPTION 'lifecycle INSERT convert_at missing';
  END IF;
  -- Clear fixture trip so overlap trigger does not block the next case.
  DELETE FROM public.trips WHERE id = v_row.id;

  -- 5) Exceptional hold preserved (payment_gate).
  INSERT INTO public.payment_sessions (
    id, customer_id, user_id, client_action_id, idempotency_key, status, provider_state,
    authorised_amount_pence, service_area_id, payment_method, currency
  ) VALUES (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', v_customer, v_user, 'verify-caa-2', 'verify-idemp-2',
    'authorised_hold', 'AUTHORISED', 800, v_sa, 'APPLE_PAY', 'gbp'
  ) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.trips (
    passenger_id, status, is_scheduled, scheduled_at, trip_type,
    booking_source, scheduled_hold_reason, payment_method, service_area_id, payment_session_id,
    pickup_address, pickup_latitude, pickup_longitude,
    dropoff_address, dropoff_latitude, dropoff_longitude
  ) VALUES (
    v_customer, 'scheduled', true, now() + interval '48 hours', 'scheduled',
    'choose_ride', 'payment_gate', 'APPLE_PAY', v_sa, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    'Pickup A', 52.04, -0.76, 'Dropoff B', 52.05, -0.75
  ) RETURNING * INTO v_row;
  IF v_row.scheduled_hold_reason IS DISTINCT FROM 'payment_gate' THEN
    RAISE EXCEPTION 'payment_gate hold not preserved: %', v_row.scheduled_hold_reason;
  END IF;
  IF v_row.scheduled_broadcast_at IS NOT NULL THEN
    RAISE EXCEPTION 'payment_gate should keep null broadcast';
  END IF;

  -- 6) Finalize refuses missing capture_deadline (never invent).
  INSERT INTO public.payment_sessions (
    id, customer_id, user_id, client_action_id, idempotency_key, status, provider_state,
    authorised_amount_pence, service_area_id, payment_method, booking_snapshot, capture_deadline
  ) VALUES (
    v_session, v_customer, v_user, 'verify-finalize-1', 'verify-finalize-idemp-1',
    'authorised_hold', 'AUTHORISED', 800, v_sa, 'APPLE_PAY',
    jsonb_build_object(
      'when', 'scheduled',
      'is_scheduled', true,
      'scheduled_at', (now() + interval '4 hours')::text,
      'estimated_duration_minutes', 20,
      'payment_method', 'APPLE_PAY',
      'passenger_id', v_customer::text,
      'pickup', jsonb_build_object('address','A','lat',52.04,'lng',-0.76),
      'dropoff', jsonb_build_object('address','B','lat',52.05,'lng',-0.75),
      'customer_payable_pence', 500
    ),
    NULL
  );

  BEGIN
    PERFORM public.finalize_paid_booking_session(v_session);
    RAISE EXCEPTION 'finalize should have raised CAPTURE_DEADLINE_MISSING';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF position('CAPTURE_DEADLINE_MISSING' in v_err) = 0 THEN
      RAISE EXCEPTION 'unexpected finalize error: %', v_err;
    END IF;
  END;

  -- 7) Finalize with provider deadline → held trip, null broadcast, coverage metadata.
  UPDATE public.payment_sessions
     SET capture_deadline = now() + interval '2 days',
         capture_deadline_source = 'provider_retrieve',
         trip_id = NULL
   WHERE id = v_session;

  v_trip_id := public.finalize_paid_booking_session(v_session);
  SELECT * INTO v_row FROM public.trips WHERE id = v_trip_id;
  IF v_row.scheduled_status IS DISTINCT FROM 'admin_held' THEN
    RAISE EXCEPTION 'finalize trip scheduled_status=%', v_row.scheduled_status;
  END IF;
  IF v_row.scheduled_broadcast_at IS NOT NULL THEN
    RAISE EXCEPTION 'finalize trip broadcast_at should be null';
  END IF;
  IF v_row.scheduled_hold_reason IS DISTINCT FROM 'publication_pending' THEN
    RAISE EXCEPTION 'finalize trip hold=%', v_row.scheduled_hold_reason;
  END IF;

  -- 8) Existing trip adoption (CTAP-wins / duplicate webhook).
  IF public.finalize_paid_booking_session(v_session) IS DISTINCT FROM v_trip_id THEN
    RAISE EXCEPTION 'finalize did not adopt existing trip';
  END IF;

  -- 9) Retired manual control blocked.
  IF (
    public.admin_scheduled_emergency_mutate(
      'make_available_now', v_trip_id, v_customer, 'ops reason long enough',
      '{}'::jsonb, '{}'::jsonb
    )->>'error'
  ) IS DISTINCT FROM 'RETIRED_MANUAL_SCHEDULED_CONTROL' THEN
    RAISE EXCEPTION 'make_available_now not retired';
  END IF;

  RAISE NOTICE 'isolated scheduled parity migrations VERIFY_OK';
END;
$$;
