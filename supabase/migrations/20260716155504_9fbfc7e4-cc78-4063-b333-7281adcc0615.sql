CREATE OR REPLACE FUNCTION public.finalize_paid_booking_session(p_payment_session_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ps RECORD;
  v_draft jsonb;
  v_trip_id uuid;
  v_existing_trip uuid;
  v_method text;
  v_final_fare_pence int;
  v_buffer_pence int;
  v_requested_hold_pence int;
  v_required_initial_authorisation_pence int;
  v_passenger_id uuid;
BEGIN
  IF p_payment_session_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session_id required' USING ERRCODE='P0001';
  END IF;

  SELECT * INTO v_ps FROM public.payment_sessions WHERE id = p_payment_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session not found' USING ERRCODE='P0001';
  END IF;

  IF v_ps.trip_id IS NOT NULL THEN
    RETURN v_ps.trip_id;
  END IF;

  IF UPPER(COALESCE(v_ps.provider_state,'')) NOT IN ('AUTHORISED','COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=%', v_ps.provider_state USING ERRCODE='P0001';
  END IF;

  IF v_ps.status::text IN ('cancelled','failed','payment_orphaned','orphan_authorisation','pending_payment','authorising') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session status=%', v_ps.status USING ERRCODE='P0001';
  END IF;

  IF COALESCE(v_ps.authorised_amount_pence,0) <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised_amount_pence=%', v_ps.authorised_amount_pence USING ERRCODE='P0001';
  END IF;

  -- Canonical draft snapshot is booking_snapshot. During the Revolut cutover,
  -- some mobile sessions wrote the same immutable booking facts into fare_snapshot
  -- while leaving booking_snapshot empty. This fallback is intentionally bounded
  -- to pre-trip sessions only and still validates provider state/amount/customer.
  v_draft := COALESCE(NULLIF(v_ps.booking_snapshot, '{}'::jsonb), NULLIF(v_ps.fare_snapshot, '{}'::jsonb), '{}'::jsonb);
  IF v_draft = '{}'::jsonb THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: booking_snapshot missing' USING ERRCODE='P0001';
  END IF;

  IF LOWER(COALESCE(v_ps.currency,'')) <> LOWER(COALESCE(v_draft->>'currency_code', v_ps.currency, '')) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: currency mismatch' USING ERRCODE='P0001';
  END IF;

  IF v_ps.service_area_id IS NULL
     OR (v_draft ? 'service_area_id' AND v_draft->>'service_area_id' <> v_ps.service_area_id::text) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: service_area mismatch' USING ERRCODE='P0001';
  END IF;

  IF v_ps.customer_id IS NULL
     OR (v_draft ? 'customer_id' AND v_draft->>'customer_id' <> v_ps.customer_id::text) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: customer mismatch' USING ERRCODE='P0001';
  END IF;

  v_final_fare_pence := COALESCE(
    NULLIF(v_draft->>'final_fare_pence','')::int,
    NULLIF(v_draft->>'estimated_total_pence','')::int,
    v_ps.estimated_total_pence
  );
  v_buffer_pence := COALESCE(
    NULLIF(v_draft->>'buffer_pence','')::int,
    v_ps.buffer_pence,
    0
  );
  v_requested_hold_pence := COALESCE(
    NULLIF(v_draft->>'authorised_amount_pence','')::int,
    v_ps.total_authorised_amount_pence,
    CASE WHEN v_final_fare_pence IS NOT NULL THEN v_final_fare_pence + v_buffer_pence ELSE NULL END
  );
  v_required_initial_authorisation_pence := COALESCE(v_requested_hold_pence, v_final_fare_pence);

  IF v_final_fare_pence IS NULL OR v_final_fare_pence <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: final fare missing' USING ERRCODE='P0001';
  END IF;

  -- Pre-authorisation aware validation: the hold may exceed the final fare by
  -- the canonical buffer, but must not be below the requested initial hold.
  IF COALESCE(v_ps.authorised_amount_pence,0) < COALESCE(v_required_initial_authorisation_pence, v_final_fare_pence) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised amount below required hold (authorised=%, required=%)',
      v_ps.authorised_amount_pence, v_required_initial_authorisation_pence USING ERRCODE='P0001';
  END IF;

  IF v_requested_hold_pence IS NOT NULL AND COALESCE(v_ps.authorised_amount_pence,0) <> v_requested_hold_pence THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised amount does not match requested hold (authorised=%, requested=%)',
      v_ps.authorised_amount_pence, v_requested_hold_pence USING ERRCODE='P0001';
  END IF;

  v_method := UPPER(COALESCE(v_draft->>'payment_method', v_ps.payment_method, 'CARD'));
  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: unsupported payment_method %', v_method USING ERRCODE='P0001';
  END IF;

  SELECT id INTO v_existing_trip FROM public.trips WHERE payment_session_id = v_ps.id LIMIT 1;
  IF v_existing_trip IS NOT NULL THEN
    UPDATE public.payment_sessions
       SET trip_id = v_existing_trip,
           status = 'trip_created',
           updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('finalize_idempotent_existing_trip', true)
     WHERE id = v_ps.id;
    RETURN v_existing_trip;
  END IF;

  v_passenger_id := COALESCE(NULLIF(v_draft->>'passenger_id','')::uuid, v_ps.customer_id);
  IF v_passenger_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: passenger_id missing' USING ERRCODE='P0001';
  END IF;

  INSERT INTO public.trips (
    passenger_id, passenger_name, passenger_phone,
    pickup_address, pickup_latitude, pickup_longitude,
    dropoff_address, dropoff_latitude, dropoff_longitude,
    vehicle_type_id, estimated_fare, estimated_total_pence, final_customer_fare_pence,
    authorised_amount_pence, preauth_buffer_pence,
    estimated_distance_km, estimated_duration_minutes,
    special_instructions, is_scheduled, scheduled_at,
    payment_method, payment_type, trip_type, status,
    currency_code, service_area_id, booking_source,
    payment_session_id, payment_provider, provider_order_id, payment_status,
    client_action_id
  ) VALUES (
    v_passenger_id,
    COALESCE(v_draft->>'passenger_name', ''),
    COALESCE(v_draft->>'passenger_phone', ''),
    COALESCE(v_draft->>'pickup_address', ''),
    NULLIF(v_draft->>'pickup_latitude','')::numeric,
    NULLIF(v_draft->>'pickup_longitude','')::numeric,
    COALESCE(v_draft->>'dropoff_address', ''),
    NULLIF(v_draft->>'dropoff_latitude','')::numeric,
    NULLIF(v_draft->>'dropoff_longitude','')::numeric,
    NULLIF(v_draft->>'vehicle_type_id','')::uuid,
    v_final_fare_pence::numeric / 100.0,
    v_final_fare_pence,
    v_final_fare_pence,
    v_ps.authorised_amount_pence,
    v_buffer_pence,
    NULLIF(v_draft->>'estimated_distance_km','')::numeric,
    NULLIF(v_draft->>'estimated_duration_minutes','')::int,
    COALESCE(v_draft->>'special_instructions',''),
    COALESCE(NULLIF(v_draft->>'is_scheduled','')::boolean,false),
    NULLIF(v_draft->>'scheduled_at','')::timestamptz,
    v_method, v_method,
    CASE WHEN COALESCE(NULLIF(v_draft->>'is_scheduled','')::boolean,false) THEN 'scheduled' ELSE 'immediate' END,
    'searching',
    LOWER(v_ps.currency),
    v_ps.service_area_id,
    COALESCE(v_draft->>'booking_source','customer_app'),
    v_ps.id,
    v_ps.payment_provider,
    v_ps.provider_order_id,
    'authorized',
    v_ps.client_action_id
  ) RETURNING id INTO v_trip_id;

  UPDATE public.payment_sessions
     SET trip_id = v_trip_id,
         status = 'trip_created',
         booking_snapshot = CASE WHEN booking_snapshot = '{}'::jsonb THEN v_draft ELSE booking_snapshot END,
         updated_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'finalized_by', 'finalize_paid_booking_session',
           'finalized_at', now(),
           'final_fare_pence', v_final_fare_pence,
           'preauth_buffer_pence', v_buffer_pence,
           'requested_hold_pence', v_requested_hold_pence,
           'required_initial_authorisation_pence', v_required_initial_authorisation_pence
         )
   WHERE id = v_ps.id;

  INSERT INTO public.audit_logs (event_type, trip_id, details, created_at)
  VALUES ('DIGITAL_TRIP_FINALIZED', v_trip_id,
    jsonb_build_object(
      'payment_session_id', v_ps.id,
      'provider_state', v_ps.provider_state,
      'authorised_amount_pence', v_ps.authorised_amount_pence,
      'final_fare_pence', v_final_fare_pence,
      'preauth_buffer_pence', v_buffer_pence,
      'requested_hold_pence', v_requested_hold_pence,
      'provider_order_id', v_ps.provider_order_id
    ),
    now());

  RETURN v_trip_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.finalize_paid_booking_session(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.recover_authorised_paid_booking_sessions(p_limit int DEFAULT 25)
RETURNS TABLE(payment_session_id uuid, provider_order_id text, result text, trip_id uuid, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ps RECORD;
  v_trip_id uuid;
  v_error text;
BEGIN
  FOR v_ps IN
    SELECT id, provider_order_id, recovery_attempt_count
      FROM public.payment_sessions
     WHERE payment_provider = 'revolut'
       AND purpose = 'RIDE_BOOKING'
       AND trip_id IS NULL
       AND UPPER(COALESCE(provider_state,'')) IN ('AUTHORISED','COMPLETED')
       AND status::text NOT IN ('cancelled','failed','payment_orphaned','orphan_authorisation')
       AND COALESCE(booking_snapshot, '{}'::jsonb) <> '{}'::jsonb
       AND recovery_attempt_count < 5
     ORDER BY created_at ASC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 25), 100))
  LOOP
    BEGIN
      UPDATE public.payment_sessions
         SET recovery_attempt_count = recovery_attempt_count + 1,
             last_recovery_attempt_at = now(),
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('last_auto_recovery_started_at', now())
       WHERE id = v_ps.id;

      v_trip_id := public.finalize_paid_booking_session(v_ps.id);

      INSERT INTO public.admin_payment_audit (action, provider, provider_payment_id, trip_id, metadata)
      VALUES ('authorised_session_auto_recovered', 'revolut', v_ps.provider_order_id, v_trip_id,
        jsonb_build_object('payment_session_id', v_ps.id, 'recovery_attempt', v_ps.recovery_attempt_count + 1, 'result', 'trip_created'));

      payment_session_id := v_ps.id;
      provider_order_id := v_ps.provider_order_id;
      result := 'trip_created';
      trip_id := v_trip_id;
      error := NULL;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      v_error := SQLERRM;
      UPDATE public.payment_sessions
         SET recovery_attempt_count = recovery_attempt_count + 1,
             last_recovery_attempt_at = now(),
             metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('last_auto_recovery_error', v_error, 'last_auto_recovery_error_at', now())
       WHERE id = v_ps.id;

      INSERT INTO public.admin_payment_audit (action, provider, provider_payment_id, trip_id, metadata)
      VALUES ('authorised_session_auto_recovery_failed', 'revolut', v_ps.provider_order_id, NULL,
        jsonb_build_object('payment_session_id', v_ps.id, 'recovery_attempt', v_ps.recovery_attempt_count + 1, 'error', v_error));

      payment_session_id := v_ps.id;
      provider_order_id := v_ps.provider_order_id;
      result := 'failed';
      trip_id := NULL;
      error := v_error;
      RETURN NEXT;
    END;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recover_authorised_paid_booking_sessions(int) TO service_role;

CREATE OR REPLACE FUNCTION public.alert_unresolved_authorised_paid_bookings()
RETURNS TABLE(payment_session_id uuid, provider_order_id text, age_minutes numeric, recovery_attempt_count int, last_error text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    ps.id,
    ps.provider_order_id,
    ROUND(EXTRACT(EPOCH FROM (now() - COALESCE(ps.authorised_at, ps.updated_at, ps.created_at))) / 60.0, 2) AS age_minutes,
    ps.recovery_attempt_count,
    ps.metadata->>'last_auto_recovery_error' AS last_error
  FROM public.payment_sessions ps
  WHERE ps.payment_provider = 'revolut'
    AND ps.purpose = 'RIDE_BOOKING'
    AND ps.trip_id IS NULL
    AND UPPER(COALESCE(ps.provider_state,'')) IN ('AUTHORISED','COMPLETED')
    AND ps.status::text NOT IN ('cancelled','failed','payment_orphaned','orphan_authorisation')
    AND (
      ps.recovery_attempt_count >= 5
      OR now() - COALESCE(ps.authorised_at, ps.updated_at, ps.created_at) > interval '2 minutes'
    )
  ORDER BY age_minutes DESC;
$$;

GRANT EXECUTE ON FUNCTION public.alert_unresolved_authorised_paid_bookings() TO service_role;