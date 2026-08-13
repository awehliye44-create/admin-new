-- P0: one passenger → at most one live IMMEDIATE trip.
-- Late ORDER_AUTHORISED on an older payment session must not create a second trip
-- while a non-terminal immediate trip already exists.
--
-- Scheduled coexistence: rows with is_scheduled / trip_type=scheduled / status
-- scheduled|scheduled_committed are excluded from the unique index.
--
-- Do not db push blindly — apply this file via linked SQL when history is drifted.

CREATE OR REPLACE FUNCTION public.passenger_has_live_immediate_trip(
  p_passenger_id uuid,
  p_exclude_trip_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip_id uuid;
BEGIN
  IF p_passenger_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT t.id
    INTO v_trip_id
  FROM public.trips t
  WHERE t.passenger_id = p_passenger_id
    AND (p_exclude_trip_id IS NULL OR t.id <> p_exclude_trip_id)
    AND COALESCE(t.is_scheduled, false) = false
    AND lower(COALESCE(t.trip_type, 'instant')) NOT IN ('scheduled')
    AND lower(btrim(COALESCE(t.status, ''))) NOT IN (
      'scheduled',
      'scheduled_committed',
      -- RESTORE_TERMINAL_TRIP_STATUSES (shared/activeTripRestoreSSOT.ts)
      'completed',
      'cancelled',
      'canceled',
      'customer_cancelled',
      'customer_canceled',
      'passenger_cancelled',
      'passenger_canceled',
      'expired',
      'expired_no_driver',
      'no_driver',
      'no_show',
      'no-show',
      'failed',
      'declined',
      'refunded',
      'released'
    )
  ORDER BY t.created_at DESC NULLS LAST
  LIMIT 1;

  RETURN v_trip_id;
END;
$function$;

COMMENT ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) IS
  'P0 duplicate-trip guard: returns existing non-terminal IMMEDIATE trip id for passenger, else null. Excludes scheduled rides.';

GRANT EXECUTE ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) TO authenticated, service_role;

-- Atomic invariant: at most one live immediate trip per passenger.
-- Uses same terminal/scheduled exclusions as passenger_has_live_immediate_trip.
CREATE UNIQUE INDEX IF NOT EXISTS trips_one_live_immediate_per_passenger_uidx
  ON public.trips (passenger_id)
  WHERE COALESCE(is_scheduled, false) = false
    AND lower(COALESCE(trip_type, 'instant')) NOT IN ('scheduled')
    AND lower(btrim(COALESCE(status, ''))) NOT IN (
      'scheduled',
      'scheduled_committed',
      'completed',
      'cancelled',
      'canceled',
      'customer_cancelled',
      'customer_canceled',
      'passenger_cancelled',
      'passenger_canceled',
      'expired',
      'expired_no_driver',
      'no_driver',
      'no_show',
      'no-show',
      'failed',
      'declined',
      'refunded',
      'released'
    );

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
  v_final_fare_pence int;
  v_buffer_pence int;
  v_requested_hold_pence int;
  v_required_initial_authorisation_pence int;
  v_passenger_id uuid;
  v_provider_state text;
  v_live_trip uuid;
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

  -- Already orphaned / superseded — never create a trip from webhook retries.
  IF v_ps.status::text IN (
    'payment_orphaned', 'orphan_authorisation', 'cancelled', 'failed',
    'RECOVERY_CANCELLED', 'RECOVERY_DECLINED', 'RECOVERY_EXPIRED'
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_ALREADY_HAS_ACTIVE_TRIP: session_status=%', v_ps.status
      USING ERRCODE='P0001';
  END IF;

  v_provider_state := UPPER(COALESCE(v_ps.provider_state,''));
  IF v_provider_state NOT IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=%', v_ps.provider_state USING ERRCODE='P0001';
  END IF;

  IF COALESCE(v_ps.authorised_amount_pence,0) <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised_amount_pence=%', v_ps.authorised_amount_pence USING ERRCODE='P0001';
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

  v_final_fare_pence := COALESCE(
    NULLIF(v_draft->>'final_fare_pence','')::int,
    NULLIF(v_draft->>'estimated_total_pence','')::int,
    NULLIF(v_draft->>'final_payable_pence','')::int,
    NULLIF(v_draft->>'gross_fare_pence','')::int,
    v_ps.estimated_total_pence
  );
  v_buffer_pence := COALESCE(NULLIF(v_draft->>'buffer_pence','')::int, v_ps.buffer_pence, 0);
  v_requested_hold_pence := COALESCE(
    NULLIF(v_draft->>'authorised_amount_pence','')::int,
    v_ps.total_authorised_amount_pence,
    CASE WHEN v_final_fare_pence IS NOT NULL THEN v_final_fare_pence + v_buffer_pence ELSE NULL END
  );
  v_required_initial_authorisation_pence := COALESCE(v_requested_hold_pence, v_final_fare_pence);

  IF v_final_fare_pence IS NULL OR v_final_fare_pence <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: final fare missing' USING ERRCODE='P0001';
  END IF;

  IF COALESCE(v_ps.authorised_amount_pence,0) < COALESCE(v_required_initial_authorisation_pence, v_final_fare_pence) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised amount below required hold (authorised=%, required=%)',
      v_ps.authorised_amount_pence, v_required_initial_authorisation_pence USING ERRCODE='P0001';
  END IF;

  v_method := UPPER(COALESCE(v_draft->>'payment_method', v_ps.payment_method, 'CARD'));
  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: unsupported payment_method %', v_method USING ERRCODE='P0001';
  END IF;

  SELECT id INTO v_existing_trip FROM public.trips WHERE payment_session_id = v_ps.id LIMIT 1;
  IF v_existing_trip IS NOT NULL THEN
    UPDATE public.payment_sessions
       SET trip_id = v_existing_trip, status = 'trip_created', updated_at = now()
     WHERE id = v_ps.id;
    RETURN v_existing_trip;
  END IF;

  v_passenger_id := COALESCE(NULLIF(v_draft->>'passenger_id','')::uuid, v_ps.customer_id);
  IF v_passenger_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: passenger_id missing' USING ERRCODE='P0001';
  END IF;

  -- Serialise concurrent finalisers for the same passenger (transaction-scoped).
  PERFORM pg_advisory_xact_lock(hashtextextended(v_passenger_id::text, 0));

  v_live_trip := public.passenger_has_live_immediate_trip(v_passenger_id, NULL);
  IF v_live_trip IS NOT NULL THEN
    -- NOTE: any UPDATE here is rolled back when we RAISE (same txn). Callers
    -- (revolut-webhook, create-trip-after-payment) MUST persist payment_orphaned
    -- + never_capture + release on CUSTOMER_ALREADY_HAS_ACTIVE_TRIP.
    RAISE EXCEPTION 'CUSTOMER_ALREADY_HAS_ACTIVE_TRIP:%', v_live_trip
      USING ERRCODE='P0001';
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
    COALESCE(v_draft->'pickup'->>'address', v_draft->>'pickup_address', ''),
    COALESCE(NULLIF(v_draft->'pickup'->>'lat','')::numeric, NULLIF(v_draft->'pickup'->>'latitude','')::numeric, NULLIF(v_draft->>'pickup_latitude','')::numeric),
    COALESCE(NULLIF(v_draft->'pickup'->>'lng','')::numeric, NULLIF(v_draft->'pickup'->>'longitude','')::numeric, NULLIF(v_draft->>'pickup_longitude','')::numeric),
    COALESCE(v_draft->'dropoff'->>'address', v_draft->>'dropoff_address', ''),
    COALESCE(NULLIF(v_draft->'dropoff'->>'lat','')::numeric, NULLIF(v_draft->'dropoff'->>'latitude','')::numeric, NULLIF(v_draft->>'dropoff_latitude','')::numeric),
    COALESCE(NULLIF(v_draft->'dropoff'->>'lng','')::numeric, NULLIF(v_draft->'dropoff'->>'longitude','')::numeric, NULLIF(v_draft->>'dropoff_longitude','')::numeric),
    NULLIF(v_draft->>'vehicle_type_id','')::uuid,
    v_final_fare_pence::numeric / 100.0,
    v_final_fare_pence,
    v_final_fare_pence,
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
    v_ps.client_action_id
  ) RETURNING id INTO v_trip_id;

  UPDATE public.payment_sessions
     SET trip_id = v_trip_id,
         status = 'trip_created',
         booking_snapshot = CASE WHEN booking_snapshot = '{}'::jsonb THEN v_draft ELSE booking_snapshot END,
         updated_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'finalized_by', 'finalize_paid_booking_session',
           'finalized_at', now()
         )
   WHERE id = v_ps.id;

  RETURN v_trip_id;
EXCEPTION
  WHEN unique_violation THEN
    -- Race: concurrent insert hit trips_one_live_immediate_per_passenger_uidx
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

COMMENT ON FUNCTION public.finalize_paid_booking_session(uuid) IS
  'Authoritative paid booking trip insert. Idempotent per session. Refuses second live immediate trip for same passenger (P0 duplicate-trip lock).';

GRANT EXECUTE ON FUNCTION public.finalize_paid_booking_session(uuid) TO authenticated, service_role;

-- Temporary operational guard: never capture the two incident holds while remediating.
UPDATE public.payment_sessions
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
     'never_capture', true,
     'capture_blocked_reason', 'p0_duplicate_trip_incident_2026_08_10',
     'capture_blocked_at', now()
   ),
       updated_at = now()
 WHERE id IN (
   '1a72627b-4fe7-4f05-9cfb-bc52153f9703',
   '167a567e-3c6b-47f0-8943-457b0e12c748'
 );
