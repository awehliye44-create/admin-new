-- Payment-first: stamp authoritative airport / commissionable split from the
-- consumed server_fare_quotes row onto trips created by finalize_paid_booking_session
-- (webhook path). Mirrors CTAP authoritativeAirportBookingPersistSSOT.
-- Never invents airport amounts. Fail-closed hold when quote airport > 0 but
-- stamp fails.

CREATE OR REPLACE FUNCTION public.apply_consumed_server_fare_airport_split_to_trip(
  p_trip_id uuid,
  p_payment_session_id uuid,
  p_user_id uuid,
  p_vehicle_type_id uuid,
  p_service_area_id uuid,
  p_payable_pence integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_quote_id uuid;
  v_sfq RECORD;
  v_airport int := 0;
  v_trip_fare int := 0;
  v_gross int := 0;
  v_payable int := GREATEST(0, COALESCE(p_payable_pence, 0));
  v_breakdown jsonb;
  v_existing int;
BEGIN
  IF p_trip_id IS NULL OR p_payment_session_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_ids');
  END IF;

  SELECT airport_charge_pence INTO v_existing
  FROM public.trips WHERE id = p_trip_id;
  IF COALESCE(v_existing, 0) > 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'reason', 'already_stamped',
      'airport_charge_pence', v_existing
    );
  END IF;

  -- Prefer fare_snapshot / booking quote linkage on the payment session.
  SELECT NULLIF(ps.fare_snapshot->>'server_fare_quote_id', '')::uuid
    INTO v_quote_id
  FROM public.payment_sessions ps
  WHERE ps.id = p_payment_session_id;

  IF v_quote_id IS NULL THEN
    SELECT bpq.server_fare_quote_id INTO v_quote_id
    FROM public.booking_payment_quotes bpq
    WHERE bpq.consumed_payment_session_id = p_payment_session_id
    ORDER BY bpq.updated_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_quote_id IS NULL THEN
    SELECT bpq.server_fare_quote_id INTO v_quote_id
    FROM public.booking_payment_quotes bpq
    JOIN public.payment_sessions ps ON ps.id = p_payment_session_id
    WHERE bpq.client_action_id = ps.client_action_id
    ORDER BY bpq.updated_at DESC NULLS LAST
    LIMIT 1;
  END IF;

  IF v_quote_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'quote_missing_fail_open', 'airport_charge_pence', 0);
  END IF;

  SELECT
    sfq.id,
    sfq.user_id,
    sfq.vehicle_type_id,
    sfq.service_area_id,
    sfq.gross_fare_pence,
    COALESCE(sfq.airport_charge_pence, 0) AS airport_charge_pence,
    sfq.pricing_evidence,
    sfq.pricing_mode,
    sfq.fare_source
  INTO v_sfq
  FROM public.server_fare_quotes sfq
  WHERE sfq.id = v_quote_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'quote_row_missing', 'hold', true);
  END IF;

  v_airport := GREATEST(0, COALESCE(v_sfq.airport_charge_pence, 0));
  v_gross := GREATEST(0, COALESCE(v_sfq.gross_fare_pence, 0));

  -- Binding checks — never trust a mismatched quote.
  IF p_user_id IS NOT NULL AND v_sfq.user_id IS DISTINCT FROM p_user_id THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'user_mismatch', 'hold', v_airport > 0,
      'quote_airport_pence', v_airport
    );
  END IF;
  IF p_vehicle_type_id IS NOT NULL AND v_sfq.vehicle_type_id IS DISTINCT FROM p_vehicle_type_id THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'vehicle_mismatch', 'hold', v_airport > 0,
      'quote_airport_pence', v_airport
    );
  END IF;
  IF p_service_area_id IS NOT NULL AND v_sfq.service_area_id IS DISTINCT FROM p_service_area_id THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'service_area_mismatch', 'hold', v_airport > 0,
      'quote_airport_pence', v_airport
    );
  END IF;

  IF v_airport > 0 AND v_payable > 0 AND v_airport > v_payable THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'airport_exceeds_payable', 'hold', true,
      'quote_airport_pence', v_airport
    );
  END IF;

  -- Journey fare from evidence when present; else gross − airport.
  IF v_sfq.pricing_evidence ? 'trip_fare_pence'
     AND NULLIF(v_sfq.pricing_evidence->>'trip_fare_pence','') IS NOT NULL THEN
    v_trip_fare := GREATEST(0, (v_sfq.pricing_evidence->>'trip_fare_pence')::int);
  ELSIF v_sfq.pricing_evidence ? 'trip_fare'
     AND NULLIF(v_sfq.pricing_evidence->>'trip_fare','') IS NOT NULL THEN
    v_trip_fare := GREATEST(0, round((v_sfq.pricing_evidence->>'trip_fare')::numeric * 100)::int);
  ELSE
    v_trip_fare := GREATEST(0, v_gross - v_airport);
  END IF;

  v_breakdown := jsonb_build_object(
    'airportCharge', (v_airport::numeric / 100.0),
    'airport_charge', (v_airport::numeric / 100.0),
    'airport_charge_pence', v_airport,
    'tripFare', (v_trip_fare::numeric / 100.0),
    'trip_fare', (v_trip_fare::numeric / 100.0),
    'trip_fare_pence', v_trip_fare,
    'finalFare', (v_gross::numeric / 100.0),
    'totalFare', (v_gross::numeric / 100.0),
    'final_fare_pence', v_gross,
    'gross_fare_pence', v_gross,
    'pricing_mode', v_sfq.pricing_mode,
    'fare_source', v_sfq.fare_source,
    'server_fare_quote_id', v_sfq.id,
    'matched_route_id', v_sfq.pricing_evidence->>'matched_route_id',
    'zone_applied', v_sfq.pricing_evidence->>'zone_applied'
  );

  UPDATE public.trips
     SET airport_charge_pence = v_airport,
         commissionable_fare_pence = v_trip_fare,
         fare_breakdown = COALESCE(fare_breakdown, '{}'::jsonb) || v_breakdown,
         fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb) || jsonb_build_object(
           'airport_charge_pence', v_airport,
           'commissionable_fare_pence', v_trip_fare,
           'server_fare_quote_id', v_sfq.id
         ),
         updated_at = now()
   WHERE id = p_trip_id;

  IF v_airport > 0 THEN
    -- Confirm stamp
    SELECT airport_charge_pence INTO v_existing FROM public.trips WHERE id = p_trip_id;
    IF COALESCE(v_existing, 0) IS DISTINCT FROM v_airport THEN
      UPDATE public.trips
         SET broadcast_enabled = false,
             scheduled_hold_reason = 'airport_pricing',
             updated_at = now()
       WHERE id = p_trip_id;
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'persist_readback_failed', 'hold', true,
        'quote_airport_pence', v_airport
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'reason', CASE WHEN v_airport > 0 THEN 'airport_persisted' ELSE 'airport_absent' END,
    'airport_charge_pence', v_airport,
    'commissionable_fare_pence', v_trip_fare,
    'server_fare_quote_id', v_sfq.id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_consumed_server_fare_airport_split_to_trip(uuid, uuid, uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_consumed_server_fare_airport_split_to_trip(uuid, uuid, uuid, uuid, uuid, integer) TO service_role;

-- Patch finalize_paid_booking_session: after successful INSERT, apply airport split
-- in the same transaction before returning. Hold when required airport cannot stamp.
CREATE OR REPLACE FUNCTION public.finalize_paid_booking_session(p_payment_session_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ps RECORD;
  v_draft jsonb;
  v_trip_id uuid;
  v_existing_trip uuid;
  v_method text;
  v_fare RECORD;
  v_passenger_id uuid;
  v_provider_state text;
  v_live_trip uuid;
  v_buffer_pence int;
  v_stops jsonb;
  v_same_trip uuid;
  v_is_scheduled boolean := false;
  v_scheduled_at timestamptz;
  v_duration_minutes int;
  v_required_until timestamptz;
  v_scheduled_convert_at timestamptz;
  v_airport_result jsonb;
  v_user_id uuid;
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

  IF lower(COALESCE(v_ps.hold_release_state, '')) = 'releasing' THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: hold_release_in_progress' USING ERRCODE='P0001';
  END IF;

  IF v_ps.status::text IN (
    'payment_orphaned', 'orphan_authorisation', 'cancelled', 'failed',
    'RECOVERY_CANCELLED', 'RECOVERY_DECLINED', 'RECOVERY_EXPIRED', 'released'
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_ALREADY_HAS_ACTIVE_TRIP: session_status=%', v_ps.status
      USING ERRCODE='P0001';
  END IF;

  v_provider_state := UPPER(COALESCE(v_ps.provider_state,''));
  IF v_provider_state NOT IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=%', v_ps.provider_state USING ERRCODE='P0001';
  END IF;

  IF COALESCE(v_ps.authorised_amount_pence,0) <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised_amount_pence=[REDACTED]' USING ERRCODE='P0001';
  END IF;

  v_draft := COALESCE(NULLIF(v_ps.booking_snapshot, '{}'::jsonb), NULLIF(v_ps.fare_snapshot, '{}'::jsonb), '{}'::jsonb);
  IF v_draft = '{}'::jsonb THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: booking_snapshot missing' USING ERRCODE='P0001';
  END IF;

  IF v_ps.service_area_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: service_area mismatch' USING ERRCODE='P0001';
  END IF;

  IF v_ps.customer_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: customer mismatch' USING ERRCODE='P0001';
  END IF;

  SELECT * INTO v_fare
  FROM public.resolve_booking_customer_payable_pence(
    v_ps.booking_snapshot,
    v_ps.fare_snapshot,
    v_ps.estimated_total_pence,
    v_ps.authorised_amount_pence
  );

  IF v_fare.customer_payable_pence IS NULL OR v_fare.customer_payable_pence <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: final fare missing' USING ERRCODE='P0001';
  END IF;

  IF COALESCE(v_ps.authorised_amount_pence,0) < v_fare.customer_payable_pence THEN
    RAISE EXCEPTION
      'PAYMENT_GATE_NOT_SATISFIED: PAYMENT_AUTHORISATION_INSUFFICIENT authorised=[REDACTED] required=%',
      v_fare.customer_payable_pence
      USING ERRCODE='P0001';
  END IF;

  v_buffer_pence := COALESCE(
    NULLIF(v_draft->>'buffer_pence','')::int,
    NULLIF(v_ps.fare_snapshot->>'buffer_pence','')::int,
    v_ps.buffer_pence,
    0
  );

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'address', COALESCE(
          NULLIF(trim(e->>'address'), ''),
          NULLIF(trim(e->>'formatted_address'), ''),
          NULLIF(trim(e->>'name'), '')
        ),
        'lat', COALESCE(NULLIF(e->>'lat','')::numeric, NULLIF(e->>'latitude','')::numeric),
        'lng', COALESCE(NULLIF(e->>'lng','')::numeric, NULLIF(e->>'longitude','')::numeric)
      )
      ORDER BY ord
    ),
    '[]'::jsonb
  )
  INTO v_stops
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(v_draft->'stops') = 'array' THEN v_draft->'stops' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS t(e, ord)
  WHERE COALESCE(NULLIF(e->>'lat','')::numeric, NULLIF(e->>'latitude','')::numeric) IS NOT NULL
    AND COALESCE(NULLIF(e->>'lng','')::numeric, NULLIF(e->>'longitude','')::numeric) IS NOT NULL;

  v_stops := COALESCE(v_stops, '[]'::jsonb);

  v_method := UPPER(COALESCE(v_draft->>'payment_method', v_ps.payment_method, 'CARD'));
  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: unsupported payment_method %', v_method USING ERRCODE='P0001';
  END IF;

  SELECT id INTO v_existing_trip FROM public.trips WHERE payment_session_id = v_ps.id LIMIT 1;
  IF v_existing_trip IS NOT NULL THEN
    UPDATE public.payment_sessions
       SET trip_id = v_existing_trip, status = 'trip_created', updated_at = now(),
           failure_reason = CASE
             WHEN UPPER(COALESCE(provider_state,'')) IN ('AUTHORISED','AUTHORIZED','COMPLETED')
               AND failure_reason IN ('REVOLUT_CANCELLED','REVOLUT_FAILED')
             THEN NULL
             ELSE failure_reason
           END
     WHERE id = v_ps.id;
    RETURN v_existing_trip;
  END IF;

  v_passenger_id := COALESCE(NULLIF(v_draft->>'passenger_id','')::uuid, v_ps.customer_id);
  IF v_passenger_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: passenger_id missing' USING ERRCODE='P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_passenger_id::text, 0));

  IF v_ps.client_action_id IS NOT NULL AND v_ps.provider_order_id IS NOT NULL THEN
    SELECT t.id INTO v_same_trip FROM public.trips t
     WHERE t.payment_session_id = v_ps.id
       AND t.client_action_id = v_ps.client_action_id
       AND t.payment_provider = v_ps.payment_provider
       AND t.provider_order_id = v_ps.provider_order_id
       AND t.passenger_id = v_passenger_id
     LIMIT 1;
    IF v_same_trip IS NOT NULL THEN
      UPDATE public.payment_sessions
         SET trip_id = v_same_trip, status = 'trip_created', updated_at = now(),
             failure_reason = CASE
               WHEN UPPER(COALESCE(provider_state,'')) IN ('AUTHORISED','AUTHORIZED','COMPLETED')
                 AND failure_reason IN ('REVOLUT_CANCELLED','REVOLUT_FAILED')
               THEN NULL
               ELSE failure_reason
             END
       WHERE id = v_ps.id AND trip_id IS NULL;
      RETURN v_same_trip;
    END IF;
  END IF;

  v_live_trip := public.passenger_has_live_immediate_trip(v_passenger_id, NULL);
  IF v_live_trip IS NOT NULL THEN
    RAISE EXCEPTION 'CUSTOMER_ALREADY_HAS_ACTIVE_TRIP:%', v_live_trip
      USING ERRCODE='P0001';
  END IF;

  v_is_scheduled := COALESCE(
    NULLIF(v_draft->>'is_scheduled','')::boolean,
    LOWER(COALESCE(v_draft->>'when','')) = 'scheduled',
    false
  );
  v_scheduled_at := NULLIF(v_draft->>'scheduled_at','')::timestamptz;
  v_duration_minutes := COALESCE(
    NULLIF(v_draft->>'estimated_duration_minutes','')::int,
    NULLIF(v_draft->>'estimated_duration','')::int,
    30
  );
  IF v_is_scheduled AND v_scheduled_at IS NOT NULL THEN
    v_required_until := public.required_capture_coverage_until(
      v_scheduled_at,
      v_duration_minutes,
      360
    );
    IF v_ps.capture_deadline IS NULL THEN
      RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: CAPTURE_DEADLINE_MISSING'
        USING ERRCODE='P0001';
    END IF;
    IF v_required_until IS NOT NULL AND v_ps.capture_deadline < v_required_until THEN
      RAISE EXCEPTION
        'PAYMENT_GATE_NOT_SATISFIED: CAPTURE_DEADLINE_INSUFFICIENT deadline=% required_until=%',
        v_ps.capture_deadline, v_required_until
        USING ERRCODE='P0001';
    END IF;
    SELECT a.scheduled_convert_at
      INTO v_scheduled_convert_at
    FROM public.compute_scheduled_dispatch_anchors(v_scheduled_at, now()) a;
  END IF;

  INSERT INTO public.trips (
    passenger_id, passenger_name, passenger_phone,
    pickup_address, pickup_latitude, pickup_longitude,
    dropoff_address, dropoff_latitude, dropoff_longitude,
    stops, total_stops,
    vehicle_type_id, estimated_fare, estimated_total_pence, final_customer_fare_pence,
    gross_fare_pence, offer_discount_pence, discount_pence,
    locked_base_fare_pence, authorised_amount_pence, preauth_buffer_pence,
    estimated_distance_km, estimated_duration_minutes,
    special_instructions, is_scheduled, scheduled_at,
    payment_method, payment_type, trip_type, status,
    dispatch_mode, scheduled_status, scheduled_broadcast_at, scheduled_convert_at, scheduled_hold_reason,
    currency_code, service_area_id, booking_source,
    payment_session_id, payment_provider, provider_order_id, payment_status, payment_state,
    client_action_id
  ) VALUES (
    v_passenger_id,
    COALESCE(v_draft->>'passenger_name', ''),
    COALESCE(v_draft->>'passenger_phone', ''),
    COALESCE(v_draft->'pickup'->>'address', v_draft->>'pickup_address', ''),
    COALESCE(NULLIF(v_draft->'pickup'->>'lat','')::numeric, NULLIF(v_draft->'pickup'->>'latitude','')::numeric, NULLIF(v_draft->>'pickup_latitude','')::numeric),
    COALESCE(NULLIF(v_draft->'pickup'->>'lng','')::numeric, NULLIF(v_draft->'pickup'->>'longitude','')::numeric, NULLIF(v_draft->>'pickup_longitude','')::numeric),
    COALESCE(v_draft->'dropoff'->>'address', v_draft->>'dropoff_address', ''),
    COALESCE(NULLIF(v_draft->'dropoff'->>'lat','')::numeric, NULLIF(v_draft->'dropoff'->>'latitude','')::numeric, NULLIF(v_draft->>'dropoff_latitude','')::numeric),
    COALESCE(NULLIF(v_draft->'dropoff'->>'lng','')::numeric, NULLIF(v_draft->'dropoff'->>'longitude','')::numeric, NULLIF(v_draft->>'dropoff_longitude','')::numeric),
    v_stops,
    2 + jsonb_array_length(v_stops),
    NULLIF(v_draft->>'vehicle_type_id','')::uuid,
    v_fare.customer_payable_pence::numeric / 100.0,
    v_fare.customer_payable_pence,
    v_fare.customer_payable_pence,
    NULLIF(v_fare.gross_fare_pence, 0),
    COALESCE(v_fare.discount_pence, 0),
    COALESCE(v_fare.discount_pence, 0),
    v_fare.customer_payable_pence,
    v_ps.authorised_amount_pence,
    v_buffer_pence,
    COALESCE(NULLIF(v_draft->>'estimated_distance_km','')::numeric, NULLIF(v_draft->>'estimated_distance','')::numeric),
    COALESCE(NULLIF(v_draft->>'estimated_duration_minutes','')::int, NULLIF(v_draft->>'estimated_duration','')::int),
    COALESCE(v_draft->>'special_instructions',''),
    v_is_scheduled,
    v_scheduled_at,
    v_method, v_method,
    CASE WHEN v_is_scheduled THEN 'scheduled' ELSE 'instant' END,
    CASE WHEN v_is_scheduled THEN 'scheduled' ELSE 'searching' END,
    CASE WHEN v_is_scheduled THEN 'scheduled' ELSE 'instant' END,
    CASE WHEN v_is_scheduled THEN 'admin_held'::text ELSE NULL::text END,
    NULL::timestamptz,
    CASE WHEN v_is_scheduled THEN v_scheduled_convert_at ELSE NULL::timestamptz END,
    CASE WHEN v_is_scheduled THEN 'publication_pending'::text ELSE NULL::text END,
    LOWER(v_ps.currency),
    v_ps.service_area_id,
    COALESCE(v_draft->>'booking_source','customer_app'),
    v_ps.id,
    v_ps.payment_provider,
    v_ps.provider_order_id,
    'authorized',
    'booking_created',
    v_ps.client_action_id
  ) RETURNING id INTO v_trip_id;

  PERFORM public.ensure_trip_stops_for_assignment(v_trip_id);

  -- Authoritative airport stamp (same transaction as create).
  v_user_id := COALESCE(v_ps.user_id, NULLIF(v_ps.fare_snapshot->>'customer_user_id','')::uuid);
  v_airport_result := public.apply_consumed_server_fare_airport_split_to_trip(
    v_trip_id,
    v_ps.id,
    v_user_id,
    NULLIF(v_draft->>'vehicle_type_id','')::uuid,
    v_ps.service_area_id,
    v_fare.customer_payable_pence
  );
  IF COALESCE((v_airport_result->>'hold')::boolean, false) THEN
    UPDATE public.trips
       SET broadcast_enabled = false,
           scheduled_hold_reason = 'airport_pricing',
           updated_at = now()
     WHERE id = v_trip_id;
  END IF;

  UPDATE public.payment_sessions
     SET trip_id = v_trip_id,
         status = 'trip_created',
         booking_snapshot = CASE WHEN booking_snapshot = '{}'::jsonb THEN v_draft ELSE booking_snapshot END,
         updated_at = now(),
         failure_reason = CASE
           WHEN UPPER(COALESCE(provider_state,'')) IN ('AUTHORISED','AUTHORIZED','COMPLETED')
             AND failure_reason IN ('REVOLUT_CANCELLED','REVOLUT_FAILED')
           THEN NULL
           ELSE failure_reason
         END,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'finalized_by', 'finalize_paid_booking_session',
           'finalized_at', now(),
           'gross_fare_pence', v_fare.gross_fare_pence,
           'discount_pence', v_fare.discount_pence,
           'customer_payable_pence', v_fare.customer_payable_pence,
           'airport_split', v_airport_result
         ) || CASE WHEN v_is_scheduled THEN jsonb_build_object(
           'scheduled_capture_coverage_required', true,
           'scheduled_capture_coverage_verified', true,
           'scheduled_capture_coverage_verified_at', now(),
           'required_capture_until', v_required_until
         ) ELSE '{}'::jsonb END
   WHERE id = v_ps.id;

  RETURN v_trip_id;
EXCEPTION
  WHEN unique_violation THEN
    IF v_ps.client_action_id IS NOT NULL AND v_ps.provider_order_id IS NOT NULL THEN
      SELECT t.id INTO v_same_trip FROM public.trips t
       WHERE t.payment_session_id = v_ps.id
         AND t.client_action_id = v_ps.client_action_id
         AND t.payment_provider = v_ps.payment_provider
         AND t.provider_order_id = v_ps.provider_order_id
         AND t.passenger_id = v_passenger_id
       LIMIT 1;
      IF v_same_trip IS NOT NULL THEN
        UPDATE public.payment_sessions
           SET trip_id = v_same_trip, status = 'trip_created', updated_at = now(),
               failure_reason = CASE
                 WHEN UPPER(COALESCE(provider_state,'')) IN ('AUTHORISED','AUTHORIZED','COMPLETED')
                   AND failure_reason IN ('REVOLUT_CANCELLED','REVOLUT_FAILED')
                 THEN NULL
                 ELSE failure_reason
               END
         WHERE id = v_ps.id AND trip_id IS NULL;
        RETURN v_same_trip;
      END IF;
    END IF;
    SELECT id INTO v_existing_trip FROM public.trips WHERE payment_session_id = v_ps.id LIMIT 1;
    IF v_existing_trip IS NOT NULL THEN
      UPDATE public.payment_sessions
         SET trip_id = v_existing_trip, status = 'trip_created', updated_at = now()
       WHERE id = v_ps.id AND trip_id IS NULL;
      RETURN v_existing_trip;
    END IF;
    RAISE EXCEPTION 'CUSTOMER_ALREADY_HAS_ACTIVE_TRIP: unique_violation'
      USING ERRCODE='P0001';
END;
$function$;
