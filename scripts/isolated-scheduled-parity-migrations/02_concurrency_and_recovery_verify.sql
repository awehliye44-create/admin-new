-- Isolated CTAP/webhook concurrency + capture coverage + recovery safety.
-- Assumes 20270218130000/30100/30200 already applied.

CREATE TEMP TABLE IF NOT EXISTS _parity_results (
  case_name text PRIMARY KEY,
  ok boolean NOT NULL,
  detail text
);

DO $$
DECLARE
  v_cust uuid;
  v_user uuid;
  v_sa uuid;
  v_ps_a uuid := '33333333-3333-3333-3333-333333333301';
  v_ps_b uuid := '33333333-3333-3333-3333-333333333302';
  v_ps_c uuid := '33333333-3333-3333-3333-333333333303';
  v_ps_d uuid := '33333333-3333-3333-3333-333333333304';
  v_ps_e uuid := '33333333-3333-3333-3333-333333333305';
  v_ps_inst uuid := '33333333-3333-3333-3333-333333333399';
  v_trip uuid;
  v_trip2 uuid;
  v_driver uuid;
  v_row public.trips%ROWTYPE;
  v_err text;
  v_sess public.payment_sessions%ROWTYPE;
  v_deadline timestamptz := now() + interval '3 days';
BEGIN
  SELECT id INTO v_sa FROM public.service_areas WHERE trip_id_prefix IS NOT NULL LIMIT 1;
  IF v_sa IS NULL THEN
    RAISE EXCEPTION 'no service_area with trip_id_prefix for fixture';
  END IF;
  SELECT id, user_id INTO v_cust, v_user FROM public.customers WHERE user_id IS NOT NULL LIMIT 1;
  IF v_cust IS NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'no customers row with user_id for fixture';
  END IF;

  -- Clean prior fixture sessions/trips if re-run.
  DELETE FROM public.trips WHERE payment_session_id IN (v_ps_a, v_ps_b, v_ps_c, v_ps_d, v_ps_e, v_ps_inst)
     OR id = '44444444-4444-4444-4444-444444444401';
  DELETE FROM public.payment_sessions WHERE id IN (v_ps_a, v_ps_b, v_ps_c, v_ps_d, v_ps_e, v_ps_inst);

  -- Distinct scheduled_at per case to avoid customer overlap trigger.
  INSERT INTO public.payment_sessions (
    id, customer_id, user_id, status, provider_state, authorised_amount_pence,
    service_area_id, payment_method, payment_provider, provider_order_id,
    client_action_id, idempotency_key, booking_snapshot, capture_deadline, currency
  ) VALUES
  (v_ps_a, v_cust, v_user, 'authorised_hold', 'AUTHORISED', 800, v_sa, 'APPLE_PAY', 'revolut', 'ord-a', 'caa', 'idemp-a',
    jsonb_build_object('when','scheduled','is_scheduled',true,'scheduled_at',(now()+interval '26 hours')::text,'estimated_duration_minutes',20,'payment_method','APPLE_PAY','passenger_id',v_cust::text,'booking_source','choose_ride','pickup',jsonb_build_object('address','A','lat',52.04,'lng',-0.76),'dropoff',jsonb_build_object('address','B','lat',52.05,'lng',-0.75),'customer_payable_pence',500,'gross_fare_pence',500),
    v_deadline, 'gbp'),
  (v_ps_b, v_cust, v_user, 'authorised_hold', 'AUTHORISED', 800, v_sa, 'APPLE_PAY', 'revolut', 'ord-b', 'cab', 'idemp-b',
    jsonb_build_object('when','scheduled','is_scheduled',true,'scheduled_at',(now()+interval '30 hours')::text,'estimated_duration_minutes',20,'payment_method','APPLE_PAY','passenger_id',v_cust::text,'booking_source','choose_ride','pickup',jsonb_build_object('address','A','lat',52.04,'lng',-0.76),'dropoff',jsonb_build_object('address','B','lat',52.05,'lng',-0.75),'customer_payable_pence',500,'gross_fare_pence',500),
    v_deadline, 'gbp'),
  (v_ps_c, v_cust, v_user, 'authorised_hold', 'AUTHORISED', 800, v_sa, 'APPLE_PAY', 'revolut', 'ord-c', 'cac', 'idemp-c',
    jsonb_build_object('when','scheduled','is_scheduled',true,'scheduled_at',(now()+interval '34 hours')::text,'estimated_duration_minutes',20,'payment_method','APPLE_PAY','passenger_id',v_cust::text,'booking_source','choose_ride','pickup',jsonb_build_object('address','A','lat',52.04,'lng',-0.76),'dropoff',jsonb_build_object('address','B','lat',52.05,'lng',-0.75),'customer_payable_pence',500,'gross_fare_pence',500),
    NULL, 'gbp'),
  (v_ps_d, v_cust, v_user, 'authorised_hold', 'AUTHORISED', 800, v_sa, 'APPLE_PAY', 'revolut', 'ord-d', 'cad', 'idemp-d',
    jsonb_build_object('when','scheduled','is_scheduled',true,'scheduled_at',(now()+interval '38 hours')::text,'estimated_duration_minutes',20,'payment_method','APPLE_PAY','passenger_id',v_cust::text,'booking_source','choose_ride','pickup',jsonb_build_object('address','A','lat',52.04,'lng',-0.76),'dropoff',jsonb_build_object('address','B','lat',52.05,'lng',-0.75),'customer_payable_pence',500,'gross_fare_pence',500),
    now() + interval '10 minutes', 'gbp'),
  (v_ps_e, v_cust, v_user, 'authorised_hold', 'AUTHORISED', 800, v_sa, 'APPLE_PAY', 'revolut', 'ord-e', 'cae', 'idemp-e',
    jsonb_build_object('when','scheduled','is_scheduled',true,'scheduled_at',(now()+interval '42 hours')::text,'estimated_duration_minutes',20,'payment_method','APPLE_PAY','passenger_id',v_cust::text,'booking_source','choose_ride','pickup',jsonb_build_object('address','A','lat',52.04,'lng',-0.76),'dropoff',jsonb_build_object('address','B','lat',52.05,'lng',-0.75),'customer_payable_pence',500,'gross_fare_pence',500),
    v_deadline, 'gbp');

  -- 1) Webhook-wins: finalize creates held scheduled trip
  v_trip := public.finalize_paid_booking_session(v_ps_a);
  SELECT * INTO v_row FROM public.trips WHERE id = v_trip;
  INSERT INTO _parity_results VALUES (
    'webhook_wins_create',
    v_row.scheduled_status = 'admin_held'
      AND v_row.scheduled_broadcast_at IS NULL
      AND v_row.scheduled_hold_reason = 'publication_pending'
      AND v_row.payment_session_id = v_ps_a,
    format('status=%s broadcast=%s hold=%s', v_row.scheduled_status, v_row.scheduled_broadcast_at, v_row.scheduled_hold_reason)
  );

  -- 2) Duplicate webhook: same session returns same trip, no second row
  v_trip2 := public.finalize_paid_booking_session(v_ps_a);
  INSERT INTO _parity_results VALUES (
    'duplicate_webhook_adoption',
    v_trip2 = v_trip
      AND (SELECT count(*) FROM public.trips WHERE payment_session_id = v_ps_a) = 1,
    format('trip=%s same=%s', v_trip, v_trip2 = v_trip)
  );

  -- 3) CTAP-wins then webhook adopts: insert trip first, then finalize
  INSERT INTO public.trips (
    id, passenger_id, status, is_scheduled, scheduled_at, trip_type, dispatch_mode,
    booking_source, payment_session_id, payment_provider, provider_order_id,
    client_action_id, service_area_id, scheduled_status, scheduled_hold_reason,
    scheduled_broadcast_at, payment_method,
    pickup_address, pickup_latitude, pickup_longitude,
    dropoff_address, dropoff_latitude, dropoff_longitude
  ) VALUES (
    '44444444-4444-4444-4444-444444444401', v_cust, 'scheduled', true, now() + interval '30 hours', 'scheduled', 'scheduled',
    'choose_ride', v_ps_b, 'revolut', 'ord-b', 'cab', v_sa, 'admin_held', 'publication_pending', NULL,
    'APPLE_PAY', 'Pickup A', 52.04, -0.76, 'Dropoff B', 52.05, -0.75
  );
  v_trip := public.finalize_paid_booking_session(v_ps_b);
  SELECT * INTO v_sess FROM public.payment_sessions WHERE id = v_ps_b;
  INSERT INTO _parity_results VALUES (
    'ctap_wins_webhook_adopts',
    v_trip = '44444444-4444-4444-4444-444444444401'::uuid
      AND v_sess.trip_id = v_trip
      AND v_sess.status = 'trip_created'
      AND (SELECT count(*) FROM public.trips WHERE payment_session_id = v_ps_b) = 1,
    format('adopted=%s sess_trip=%s', v_trip, v_sess.trip_id)
  );

  -- 4) Missing capture deadline blocks finalize (no trip, session not released)
  BEGIN
    PERFORM public.finalize_paid_booking_session(v_ps_c);
    INSERT INTO _parity_results VALUES ('missing_capture_deadline', false, 'expected raise');
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    SELECT * INTO v_sess FROM public.payment_sessions WHERE id = v_ps_c;
    INSERT INTO _parity_results VALUES (
      'missing_capture_deadline',
      position('CAPTURE_DEADLINE_MISSING' in v_err) > 0
        AND v_sess.trip_id IS NULL
        AND v_sess.status = 'authorised_hold'
        AND v_sess.released_at IS NULL,
      v_err
    );
  END;

  -- 5) Insufficient coverage blocks finalize (deadline before required_until)
  BEGIN
    PERFORM public.finalize_paid_booking_session(v_ps_d);
    INSERT INTO _parity_results VALUES ('insufficient_capture_coverage', false, 'expected raise');
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    SELECT * INTO v_sess FROM public.payment_sessions WHERE id = v_ps_d;
    INSERT INTO _parity_results VALUES (
      'insufficient_capture_coverage',
      position('CAPTURE_DEADLINE_INSUFFICIENT' in v_err) > 0
        AND v_sess.trip_id IS NULL
        AND v_sess.status = 'authorised_hold',
      v_err
    );
  END;

  -- 6) Valid coverage create + lifecycle held (auto-publish is Edge; SQL leaves held)
  v_trip := public.finalize_paid_booking_session(v_ps_e);
  SELECT * INTO v_row FROM public.trips WHERE id = v_trip;
  SELECT * INTO v_sess FROM public.payment_sessions WHERE id = v_ps_e;
  INSERT INTO _parity_results VALUES (
    'valid_coverage_held_ready_for_auto_publish',
    v_row.scheduled_status = 'admin_held'
      AND v_row.scheduled_hold_reason = 'publication_pending'
      AND v_row.scheduled_broadcast_at IS NULL
      AND v_sess.status = 'trip_created'
      AND v_sess.released_at IS NULL
      AND (v_sess.metadata ? 'scheduled_capture_coverage_verified'),
    format('hold=%s meta_verified=%s', v_row.scheduled_hold_reason, v_sess.metadata ? 'scheduled_capture_coverage_verified')
  );

  -- 7) Instant webhook-first path unaffected (no scheduled hold)
  INSERT INTO public.payment_sessions (
    id, customer_id, user_id, status, provider_state, authorised_amount_pence,
    service_area_id, payment_method, payment_provider, provider_order_id,
    client_action_id, idempotency_key, booking_snapshot, capture_deadline, currency
  ) VALUES (
    v_ps_inst, v_cust, v_user, 'authorised_hold', 'AUTHORISED', 800, v_sa, 'CARD', 'revolut', 'ord-inst', 'cain', 'idemp-inst',
    jsonb_build_object(
      'when', 'now',
      'is_scheduled', false,
      'payment_method', 'CARD',
      'passenger_id', v_cust::text,
      'pickup', jsonb_build_object('address','A','lat',52.04,'lng',-0.76),
      'dropoff', jsonb_build_object('address','B','lat',52.05,'lng',-0.75),
      'customer_payable_pence', 500,
      'gross_fare_pence', 500
    ),
    NULL, 'gbp'
  );
  v_trip := public.finalize_paid_booking_session(v_ps_inst);
  SELECT * INTO v_row FROM public.trips WHERE id = v_trip;
  INSERT INTO _parity_results VALUES (
    'instant_webhook_unaffected',
    v_row.is_scheduled IS NOT TRUE
      AND COALESCE(v_row.scheduled_status, '') = ''
      AND v_row.scheduled_hold_reason IS NULL
      AND v_row.status = 'searching',
    format('status=%s scheduled_status=%s', v_row.status, v_row.scheduled_status)
  );

  -- 8) Lifecycle INSERT: payment_gate hold preserved (recovery must not clear)
  INSERT INTO public.payment_sessions (
    id, customer_id, user_id, client_action_id, idempotency_key, status, provider_state,
    authorised_amount_pence, service_area_id, payment_method, currency
  ) VALUES (
    '33333333-3333-3333-3333-333333333390', v_cust, v_user, 'hold-caa', 'hold-idemp',
    'authorised_hold', 'AUTHORISED', 800, v_sa, 'APPLE_PAY', 'gbp'
  ) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.trips (
    passenger_id, status, is_scheduled, scheduled_at, trip_type, booking_source,
    scheduled_hold_reason, payment_method, service_area_id, payment_session_id,
    pickup_address, pickup_latitude, pickup_longitude,
    dropoff_address, dropoff_latitude, dropoff_longitude
  ) VALUES (
    v_cust, 'scheduled', true, now() + interval '90 hours', 'scheduled', 'choose_ride', 'payment_gate',
    'APPLE_PAY', v_sa, '33333333-3333-3333-3333-333333333390',
    'Pickup A', 52.04, -0.76, 'Dropoff B', 52.05, -0.75
  ) RETURNING * INTO v_row;
  INSERT INTO _parity_results VALUES (
    'recovery_preserves_payment_gate_hold',
    v_row.scheduled_hold_reason = 'payment_gate'
      AND v_row.scheduled_status = 'admin_held'
      AND v_row.scheduled_broadcast_at IS NULL,
    format('hold=%s status=%s', v_row.scheduled_hold_reason, v_row.scheduled_status)
  );

  -- 9) Retirement RPC still callable / blocks make_available_now
  INSERT INTO _parity_results VALUES (
    'retired_manual_make_available',
    (
      public.admin_scheduled_emergency_mutate(
        'make_available_now',
        v_trip,
        v_cust,
        'ops reason long enough',
        '{}'::jsonb,
        '{}'::jsonb
      )->>'error'
    ) = 'RETIRED_MANUAL_SCHEDULED_CONTROL',
    'ok'
  );

  -- 10) Concurrent assignment cannot be overwritten by lifecycle held stamp on UPDATE
  -- (simulate assigned marketplace row — recovery CAS requires null driver)
  SELECT id INTO v_driver FROM public.drivers LIMIT 1;
  IF v_driver IS NULL THEN
    INSERT INTO _parity_results VALUES (
      'assigned_row_not_reset_to_held_on_update', false, 'no drivers fixture'
    );
  ELSE
    UPDATE public.trips
       SET confirmed_driver_id = v_driver,
           scheduled_status = 'scheduled',
           scheduled_hold_reason = NULL,
           scheduled_broadcast_at = now() + interval '20 minutes'
     WHERE id = (SELECT id FROM public.trips WHERE payment_session_id = v_ps_e LIMIT 1)
    RETURNING * INTO v_row;
    INSERT INTO _parity_results VALUES (
      'assigned_row_not_reset_to_held_on_update',
      v_row.confirmed_driver_id IS NOT NULL
        AND v_row.scheduled_status = 'scheduled',
      format('driver=%s status=%s', v_row.confirmed_driver_id, v_row.scheduled_status)
    );
  END IF;
END;
$$;

SELECT case_name, ok, detail FROM _parity_results ORDER BY case_name;

DO $$
DECLARE
  v_fail int;
BEGIN
  SELECT count(*) INTO v_fail FROM _parity_results WHERE NOT ok;
  IF v_fail > 0 THEN
    RAISE EXCEPTION 'CONCURRENCY_VERIFY_FAILED failing_cases=%', v_fail;
  END IF;
  RAISE NOTICE 'CONCURRENCY_AND_RECOVERY_VERIFY_OK';
END;
$$;
