-- Isolated execution: authoritative airport split helper + finalize_paid_booking_session.
-- Target: local Docker only. Never production.
-- Rolls fixture rows back via DELETE at end (keeps function definitions).

DO $$
DECLARE
  v_sa uuid;
  v_customer uuid;
  v_user uuid;
  v_vehicle uuid;
  v_quote uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
  v_quote_zero uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2';
  v_route uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb0';
  v_route_zero uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbf';
  v_ps_airport uuid := 'cccccccc-cccc-cccc-cccc-ccccccccccc1';
  v_ps_zero uuid := 'cccccccc-cccc-cccc-cccc-ccccccccccc2';
  v_ps_instant uuid := 'cccccccc-cccc-cccc-cccc-ccccccccccc3';
  v_ps_capture uuid := 'cccccccc-cccc-cccc-cccc-ccccccccccc4';
  v_ps_ctap uuid := 'cccccccc-cccc-cccc-cccc-ccccccccccc5';
  v_trip uuid;
  v_trip2 uuid;
  v_result jsonb;
  v_airport int;
  v_comm int;
  v_auth int;
  v_hold text;
  v_fn text;
  v_err text;
  v_meta jsonb;
BEGIN
  SELECT id INTO v_sa FROM public.service_areas WHERE trip_id_prefix IS NOT NULL LIMIT 1;
  IF v_sa IS NULL THEN RAISE EXCEPTION 'fixture: no service_area'; END IF;
  SELECT id, user_id INTO v_customer, v_user FROM public.customers WHERE user_id IS NOT NULL LIMIT 1;
  IF v_customer IS NULL OR v_user IS NULL THEN RAISE EXCEPTION 'fixture: no customer'; END IF;
  -- Clear any local live immediate / scheduled holds for this passenger so fixtures can insert.
  UPDATE public.trips
     SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()),
         scheduled_status = CASE WHEN is_scheduled THEN 'cancelled' ELSE scheduled_status END
   WHERE passenger_id = v_customer
     AND cancelled_at IS NULL
     AND completed_at IS NULL
     AND lower(coalesce(status,'')) IN (
       'searching','broadcasting','assigned','scheduled','in_progress','arrived','en_route','driver_en_route'
     );
  SELECT id INTO v_vehicle FROM public.vehicle_types LIMIT 1;
  IF v_vehicle IS NULL THEN
    INSERT INTO public.vehicle_types (id, name, slug, is_active, display_order)
    VALUES ('dddddddd-dddd-dddd-dddd-ddddddddddd1', 'ISO Airport Test', 'iso-airport-test', true, 999)
    RETURNING id INTO v_vehicle;
  END IF;

  -- Protections still present in finalize after patch.
  SELECT pg_get_functiondef('public.finalize_paid_booking_session(uuid)'::regprocedure) INTO v_fn;
  IF position('CAPTURE_DEADLINE_MISSING' in v_fn) = 0 THEN
    RAISE EXCEPTION 'finalize lost CAPTURE_DEADLINE_MISSING';
  END IF;
  IF position('CAPTURE_DEADLINE_INSUFFICIENT' in v_fn) = 0 THEN
    RAISE EXCEPTION 'finalize lost CAPTURE_DEADLINE_INSUFFICIENT';
  END IF;
  IF position('hold_release_in_progress' in v_fn) = 0 THEN
    RAISE EXCEPTION 'finalize lost hold_release_in_progress guard';
  END IF;
  IF position('apply_consumed_server_fare_airport_split_to_trip' in v_fn) = 0 THEN
    RAISE EXCEPTION 'finalize missing airport split apply';
  END IF;
  IF position('publication_pending' in v_fn) = 0 THEN
    RAISE EXCEPTION 'finalize lost publication_pending';
  END IF;

  INSERT INTO public.route_quote_artifacts (
    id, user_id, route_key, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
    stops, distance_meters, duration_seconds, distance_km, duration_min,
    provider, service_area_id, schema_version, created_at, expires_at
  ) VALUES (
    v_route, v_user, 'iso-airport-route', 52.04, -0.76, 52.05, -0.75,
    '[]'::jsonb, 12500, 1500, 12.5, 25,
    'mapbox_directions', v_sa, 1, now(), now() + interval '1 day'
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.route_quote_artifacts (
    id, user_id, route_key, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
    stops, distance_meters, duration_seconds, distance_km, duration_min,
    provider, service_area_id, schema_version, created_at, expires_at
  ) VALUES (
    v_route_zero, v_user, 'iso-zero-route', 52.04, -0.76, 52.05, -0.75,
    '[]'::jsonb, 5000, 720, 5, 12,
    'mapbox_directions', v_sa, 1, now(), now() + interval '1 day'
  ) ON CONFLICT (id) DO NOTHING;

  -- Server fare quotes: airport 900 / gross 4200 and zero-airport.
  INSERT INTO public.server_fare_quotes (
    id, user_id, route_quote_id, route_key, service_area_id, vehicle_type_id, currency,
    distance_km, duration_min, gross_fare_pence, airport_charge_pence,
    surge_multiplier, fare_source, pricing_mode, pricing_evidence,
    pricing_hash, schema_version, created_at, expires_at
  ) VALUES (
    v_quote, v_user, v_route, 'iso-airport-route', v_sa, v_vehicle, 'GBP',
    12.5, 25, 4200, 900,
    1, 'route_fixed', 'ROUTE_PRICING',
    jsonb_build_object('trip_fare_pence', 3300, 'matched_route_id', 'route-test'),
    'iso-airport-hash-1', 1, now(), now() + interval '1 day'
  ) ON CONFLICT (id) DO UPDATE SET
    airport_charge_pence = EXCLUDED.airport_charge_pence,
    gross_fare_pence = EXCLUDED.gross_fare_pence,
    pricing_evidence = EXCLUDED.pricing_evidence,
    vehicle_type_id = EXCLUDED.vehicle_type_id,
    service_area_id = EXCLUDED.service_area_id,
    user_id = EXCLUDED.user_id;

  INSERT INTO public.server_fare_quotes (
    id, user_id, route_quote_id, route_key, service_area_id, vehicle_type_id, currency,
    distance_km, duration_min, gross_fare_pence, airport_charge_pence,
    surge_multiplier, fare_source, pricing_mode, pricing_evidence,
    pricing_hash, schema_version, created_at, expires_at
  ) VALUES (
    v_quote_zero, v_user, v_route_zero, 'iso-zero-route', v_sa, v_vehicle, 'GBP',
    5, 12, 1500, 0,
    1, 'distance_time', 'NORMAL_DISTANCE_TIME',
    jsonb_build_object('trip_fare_pence', 1500),
    'iso-airport-hash-0', 1, now(), now() + interval '1 day'
  ) ON CONFLICT (id) DO UPDATE SET
    airport_charge_pence = 0,
    gross_fare_pence = 1500;

  -- 1) Helper alone on a manually inserted CTAP-shaped trip (airport required).
  INSERT INTO public.payment_sessions (
    id, customer_id, user_id, client_action_id, idempotency_key, status, provider_state,
    authorised_amount_pence, service_area_id, payment_method, currency,
    fare_snapshot, booking_snapshot, capture_deadline
  ) VALUES (
    v_ps_ctap, v_customer, v_user, 'iso-caa-ctap', 'iso-idemp-ctap',
    'authorised_hold', 'AUTHORISED', 4200, v_sa, 'CARD', 'gbp',
    jsonb_build_object(
      'server_fare_quote_id', v_quote::text,
      'customer_payable_pence', 4200,
      'gross_fare_pence', 4200
    ),
    jsonb_build_object(
      'when', 'now', 'is_scheduled', false, 'payment_method', 'CARD',
      'passenger_id', v_customer::text,
      'vehicle_type_id', v_vehicle::text,
      'customer_payable_pence', 4200,
      'pickup', jsonb_build_object('address','Pickup','lat',52.04,'lng',-0.76),
      'dropoff', jsonb_build_object('address','Drop','lat',52.05,'lng',-0.75)
    ),
    now() + interval '2 days'
  ) ON CONFLICT (id) DO UPDATE SET trip_id = NULL, status = 'authorised_hold', provider_state = 'AUTHORISED';

  INSERT INTO public.trips (
    passenger_id, status, is_scheduled, trip_type, booking_source, payment_method,
    service_area_id, payment_session_id, vehicle_type_id,
    estimated_total_pence, final_customer_fare_pence, authorised_amount_pence,
    airport_charge_pence, commissionable_fare_pence,
    pickup_address, pickup_latitude, pickup_longitude,
    dropoff_address, dropoff_latitude, dropoff_longitude,
    broadcast_enabled
  ) VALUES (
    v_customer, 'searching', false, 'instant', 'choose_ride', 'CARD',
    v_sa, v_ps_ctap, v_vehicle,
    4200, 4200, 4200,
    0, NULL,
    'Pickup', 52.04, -0.76, 'Drop', 52.05, -0.75,
    true
  ) RETURNING id INTO v_trip;

  UPDATE public.payment_sessions SET trip_id = v_trip WHERE id = v_ps_ctap;

  v_result := public.apply_consumed_server_fare_airport_split_to_trip(
    v_trip, v_ps_ctap, v_user, v_vehicle, v_sa, 4200
  );
  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'CTAP-path helper failed: %', v_result;
  END IF;
  IF (v_result->>'airport_charge_pence')::int IS DISTINCT FROM 900 THEN
    RAISE EXCEPTION 'CTAP-path airport=%', v_result;
  END IF;
  IF (v_result->>'commissionable_fare_pence')::int IS DISTINCT FROM 3300 THEN
    RAISE EXCEPTION 'CTAP-path commissionable=%', v_result;
  END IF;

  SELECT airport_charge_pence, commissionable_fare_pence, authorised_amount_pence,
         broadcast_enabled::text
    INTO v_airport, v_comm, v_auth, v_hold
  FROM public.trips WHERE id = v_trip;
  IF v_airport IS DISTINCT FROM 900 OR v_comm IS DISTINCT FROM 3300 THEN
    RAISE EXCEPTION 'CTAP trip persist mismatch airport=% comm=%', v_airport, v_comm;
  END IF;
  IF v_auth IS DISTINCT FROM 4200 THEN
    RAISE EXCEPTION 'CTAP path mutated authorisation to %', v_auth;
  END IF;
  -- Financial stamp before dispatchable: airport present while still searching.
  IF v_airport <> 900 THEN
    RAISE EXCEPTION 'airport not stamped before dispatchable';
  END IF;

  -- Idempotent re-apply (already_stamped).
  v_result := public.apply_consumed_server_fare_airport_split_to_trip(
    v_trip, v_ps_ctap, v_user, v_vehicle, v_sa, 4200
  );
  IF (v_result->>'reason') IS DISTINCT FROM 'already_stamped' THEN
    RAISE EXCEPTION 'expected already_stamped, got %', v_result;
  END IF;

  -- 2) finalize webhook path with airport quote (scheduled).
  INSERT INTO public.payment_sessions (
    id, customer_id, user_id, client_action_id, idempotency_key, status, provider_state,
    authorised_amount_pence, service_area_id, payment_method, currency,
    fare_snapshot, booking_snapshot, capture_deadline, trip_id
  ) VALUES (
    v_ps_airport, v_customer, v_user, 'iso-caa-air', 'iso-idemp-air',
    'authorised_hold', 'AUTHORISED', 4200, v_sa, 'APPLE_PAY', 'gbp',
    jsonb_build_object(
      'server_fare_quote_id', v_quote::text,
      'customer_payable_pence', 4200,
      'gross_fare_pence', 4200,
      'buffer_pence', 0
    ),
    jsonb_build_object(
      'when', 'scheduled', 'is_scheduled', true,
      'scheduled_at', (now() + interval '6 hours')::text,
      'estimated_duration_minutes', 25,
      'payment_method', 'APPLE_PAY',
      'passenger_id', v_customer::text,
      'vehicle_type_id', v_vehicle::text,
      'customer_payable_pence', 4200,
      'pickup', jsonb_build_object('address','Airport Pickup','lat',52.04,'lng',-0.76),
      'dropoff', jsonb_build_object('address','Town','lat',52.05,'lng',-0.75)
    ),
    now() + interval '3 days',
    NULL
  ) ON CONFLICT (id) DO UPDATE SET
    trip_id = NULL, status = 'authorised_hold', provider_state = 'AUTHORISED',
    authorised_amount_pence = 4200,
    fare_snapshot = EXCLUDED.fare_snapshot,
    booking_snapshot = EXCLUDED.booking_snapshot,
    capture_deadline = EXCLUDED.capture_deadline;

  -- Clear any prior live immediate trip for this passenger so finalize can proceed.
  UPDATE public.trips SET status = 'cancelled', cancelled_at = now()
   WHERE passenger_id = v_customer AND id = v_trip AND status = 'searching';

  v_trip := public.finalize_paid_booking_session(v_ps_airport);
  SELECT airport_charge_pence, commissionable_fare_pence, authorised_amount_pence,
         scheduled_hold_reason, estimated_total_pence
    INTO v_airport, v_comm, v_auth, v_hold, v_result
  FROM public.trips WHERE id = v_trip;
  IF v_airport IS DISTINCT FROM 900 OR v_comm IS DISTINCT FROM 3300 THEN
    RAISE EXCEPTION 'finalize airport persist failed airport=% comm=%', v_airport, v_comm;
  END IF;
  IF v_auth IS DISTINCT FROM 4200 THEN
    RAISE EXCEPTION 'finalize mutated auth %', v_auth;
  END IF;

  SELECT metadata->'airport_split' INTO v_meta FROM public.payment_sessions WHERE id = v_ps_airport;
  IF COALESCE((v_meta->>'airport_charge_pence')::int, 0) IS DISTINCT FROM 900 THEN
    RAISE EXCEPTION 'finalize metadata airport_split missing: %', v_meta;
  END IF;

  -- Concurrent / webhook adopt: second finalize returns same trip.
  v_trip2 := public.finalize_paid_booking_session(v_ps_airport);
  IF v_trip2 IS DISTINCT FROM v_trip THEN
    RAISE EXCEPTION 'finalize concurrency created duplicate trip % vs %', v_trip, v_trip2;
  END IF;

  -- 3) Zero airport — unaffected path (no hold, airport 0).
  INSERT INTO public.payment_sessions (
    id, customer_id, user_id, client_action_id, idempotency_key, status, provider_state,
    authorised_amount_pence, service_area_id, payment_method, currency,
    fare_snapshot, booking_snapshot, capture_deadline, trip_id
  ) VALUES (
    v_ps_zero, v_customer, v_user, 'iso-caa-zero', 'iso-idemp-zero',
    'authorised_hold', 'AUTHORISED', 1500, v_sa, 'CARD', 'gbp',
    jsonb_build_object('server_fare_quote_id', v_quote_zero::text, 'customer_payable_pence', 1500),
    jsonb_build_object(
      'when', 'scheduled', 'is_scheduled', true,
      'scheduled_at', (now() + interval '8 hours')::text,
      'estimated_duration_minutes', 15,
      'payment_method', 'CARD',
      'passenger_id', v_customer::text,
      'vehicle_type_id', v_vehicle::text,
      'customer_payable_pence', 1500,
      'pickup', jsonb_build_object('address','A','lat',52.04,'lng',-0.76),
      'dropoff', jsonb_build_object('address','B','lat',52.05,'lng',-0.75)
    ),
    now() + interval '3 days',
    NULL
  ) ON CONFLICT (id) DO UPDATE SET trip_id = NULL, status = 'authorised_hold', provider_state = 'AUTHORISED';

  -- Cancel prior scheduled for passenger overlap if needed
  UPDATE public.trips SET status = 'cancelled', cancelled_at = now()
   WHERE id = v_trip AND status IN ('scheduled','searching');

  v_trip := public.finalize_paid_booking_session(v_ps_zero);
  SELECT airport_charge_pence, commissionable_fare_pence, scheduled_hold_reason
    INTO v_airport, v_comm, v_hold
  FROM public.trips WHERE id = v_trip;
  IF COALESCE(v_airport, 0) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'zero-airport trip got airport=%', v_airport;
  END IF;
  IF v_hold = 'airport_pricing' THEN
    RAISE EXCEPTION 'zero-airport incorrectly held';
  END IF;

  -- 4) Capture deadline still enforced (non-airport).
  INSERT INTO public.payment_sessions (
    id, customer_id, user_id, client_action_id, idempotency_key, status, provider_state,
    authorised_amount_pence, service_area_id, payment_method, currency,
    fare_snapshot, booking_snapshot, capture_deadline, trip_id
  ) VALUES (
    v_ps_capture, v_customer, v_user, 'iso-caa-cap', 'iso-idemp-cap',
    'authorised_hold', 'AUTHORISED', 1500, v_sa, 'CARD', 'gbp',
    jsonb_build_object('server_fare_quote_id', v_quote_zero::text, 'customer_payable_pence', 1500),
    jsonb_build_object(
      'when', 'scheduled', 'is_scheduled', true,
      'scheduled_at', (now() + interval '10 hours')::text,
      'estimated_duration_minutes', 20,
      'payment_method', 'CARD',
      'passenger_id', v_customer::text,
      'vehicle_type_id', v_vehicle::text,
      'customer_payable_pence', 1500,
      'pickup', jsonb_build_object('address','A','lat',52.04,'lng',-0.76),
      'dropoff', jsonb_build_object('address','B','lat',52.05,'lng',-0.75)
    ),
    NULL,
    NULL
  ) ON CONFLICT (id) DO UPDATE SET trip_id = NULL, capture_deadline = NULL, status = 'authorised_hold';

  BEGIN
    PERFORM public.finalize_paid_booking_session(v_ps_capture);
    RAISE EXCEPTION 'expected CAPTURE_DEADLINE_MISSING';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF position('CAPTURE_DEADLINE_MISSING' in v_err) = 0 THEN
      RAISE EXCEPTION 'unexpected capture error: %', v_err;
    END IF;
  END;

  -- 5) Instant finalize with airport — stamp before searching dispatchable.
  UPDATE public.trips SET status = 'cancelled', cancelled_at = now()
   WHERE passenger_id = v_customer AND status IN ('searching','scheduled')
     AND payment_session_id IN (v_ps_ctap, v_ps_airport, v_ps_zero);

  INSERT INTO public.payment_sessions (
    id, customer_id, user_id, client_action_id, idempotency_key, status, provider_state,
    authorised_amount_pence, service_area_id, payment_method, currency,
    fare_snapshot, booking_snapshot, capture_deadline, trip_id
  ) VALUES (
    v_ps_instant, v_customer, v_user, 'iso-caa-inst', 'iso-idemp-inst',
    'authorised_hold', 'AUTHORISED', 4200, v_sa, 'CARD', 'gbp',
    jsonb_build_object('server_fare_quote_id', v_quote::text, 'customer_payable_pence', 4200),
    jsonb_build_object(
      'when', 'now', 'is_scheduled', false,
      'payment_method', 'CARD',
      'passenger_id', v_customer::text,
      'vehicle_type_id', v_vehicle::text,
      'customer_payable_pence', 4200,
      'pickup', jsonb_build_object('address','A','lat',52.04,'lng',-0.76),
      'dropoff', jsonb_build_object('address','B','lat',52.05,'lng',-0.75)
    ),
    now() + interval '1 day',
    NULL
  ) ON CONFLICT (id) DO UPDATE SET trip_id = NULL, status = 'authorised_hold', provider_state = 'AUTHORISED';

  v_trip := public.finalize_paid_booking_session(v_ps_instant);
  SELECT airport_charge_pence, commissionable_fare_pence, status
    INTO v_airport, v_comm, v_hold
  FROM public.trips WHERE id = v_trip;
  IF v_airport IS DISTINCT FROM 900 OR v_comm IS DISTINCT FROM 3300 THEN
    RAISE EXCEPTION 'instant airport persist failed %/%', v_airport, v_comm;
  END IF;
  IF v_hold IS DISTINCT FROM 'searching' THEN
    RAISE EXCEPTION 'instant status unexpected %', v_hold;
  END IF;

  -- Cleanup fixtures (keep functions).
  DELETE FROM public.trips WHERE payment_session_id IN (
    v_ps_airport, v_ps_zero, v_ps_instant, v_ps_capture, v_ps_ctap
  );
  DELETE FROM public.payment_sessions WHERE id IN (
    v_ps_airport, v_ps_zero, v_ps_instant, v_ps_capture, v_ps_ctap
  );
  DELETE FROM public.server_fare_quotes WHERE id IN (v_quote, v_quote_zero);
  DELETE FROM public.route_quote_artifacts WHERE id IN (v_route, v_route_zero);
  DELETE FROM public.vehicle_types WHERE id = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';

  RAISE NOTICE 'ISOLATED_AIRPORT_VERIFY_OK';
END;
$$;
