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

  v_live_trip := public.passenger_has_live_immediate_trip(v_passenger_id, NULL);
  IF v_live_trip IS NOT NULL THEN
    RAISE EXCEPTION 'CUSTOMER_ALREADY_HAS_ACTIVE_TRIP:%', v_live_trip
      USING ERRCODE='P0001';
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
    COALESCE(NULLIF(v_draft->>'is_scheduled','')::boolean, LOWER(COALESCE(v_draft->>'when','')) = 'scheduled', false),
    NULLIF(v_draft->>'scheduled_at','')::timestamptz,
    v_method, v_method,
    CASE WHEN COALESCE(NULLIF(v_draft->>'is_scheduled','')::boolean, LOWER(COALESCE(v_draft->>'when','')) = 'scheduled', false)
      THEN 'scheduled' ELSE 'instant' END,
    'searching',
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
           'customer_payable_pence', v_fare.customer_payable_pence
         )
   WHERE id = v_ps.id;

  RETURN v_trip_id;
EXCEPTION
  WHEN unique_violation THEN
    v_live_trip := public.passenger_has_live_immediate_trip(v_passenger_id, NULL);
    UPDATE public.payment_sessions
       SET status = 'payment_orphaned',
           updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'orphan_reason', 'CUSTOMER_ALREADY_HAS_ACTIVE_TRIP',
             'existing_trip_id', v_live_trip,
             'orphaned_at', now(),
             'orphaned_by', 'finalize_paid_booking_session_unique_violation',
             'release_recommended', true,
             'never_capture', true
           )
     WHERE id = p_payment_session_id
       AND trip_id IS NULL;
    RAISE EXCEPTION 'CUSTOMER_ALREADY_HAS_ACTIVE_TRIP:%', COALESCE(v_live_trip::text, 'unknown')
      USING ERRCODE='P0001';
END;
$function$;

WITH lost AS (
  SELECT
    t.id AS trip_id,
    (
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
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(ps.booking_snapshot->'stops') = 'array'
          THEN ps.booking_snapshot->'stops' ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS t2(e, ord)
      WHERE COALESCE(NULLIF(e->>'lat','')::numeric, NULLIF(e->>'latitude','')::numeric) IS NOT NULL
        AND COALESCE(NULLIF(e->>'lng','')::numeric, NULLIF(e->>'longitude','')::numeric) IS NOT NULL
    ) AS stops
  FROM public.trips t
  JOIN public.payment_sessions ps ON ps.id = t.payment_session_id
  WHERE COALESCE(jsonb_array_length(to_jsonb(t.stops)), 0) = 0
)
UPDATE public.trips t
SET stops = lost.stops,
    total_stops = GREATEST(COALESCE(t.total_stops, 0), 2 + jsonb_array_length(lost.stops)),
    updated_at = now()
FROM lost
WHERE t.id = lost.trip_id
  AND jsonb_array_length(lost.stops) > 0;