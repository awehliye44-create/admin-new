-- P0 #1: Payment authorisation amount gate + booking fare lineage (gross/discount/payable)
-- Evidence: MK-260810-011 — session hold 788p, trip final_customer 875p (discount dropped).
--
-- Root cause: finalize_paid_booking_session preferred booking_snapshot, which lacked
-- final_fare_pence / estimated_total_pence and fell through to gross_fare_pence (875).
-- Gate compared authorised vs hold request (788), not vs inserted customer payable.
--
-- Also: assert_payment_gate did not require authorised >= locked customer payable.

CREATE OR REPLACE FUNCTION public.resolve_booking_customer_payable_pence(
  p_booking_snapshot jsonb,
  p_fare_snapshot jsonb,
  p_session_estimated_total_pence integer,
  p_session_authorised_amount_pence integer
)
RETURNS TABLE (
  gross_fare_pence integer,
  discount_pence integer,
  customer_payable_pence integer
)
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_book jsonb := COALESCE(p_booking_snapshot, '{}'::jsonb);
  v_fare jsonb := COALESCE(p_fare_snapshot, '{}'::jsonb);
  v_gross integer;
  v_discount integer;
  v_payable integer;
BEGIN
  v_gross := COALESCE(
    NULLIF(v_fare->>'gross_fare_pence','')::int,
    NULLIF(v_book->>'gross_fare_pence','')::int,
    NULLIF(v_fare->>'original_estimated_fare_pence','')::int,
    NULLIF(v_book->>'original_estimated_fare_pence','')::int,
    0
  );

  v_discount := GREATEST(
    0,
    COALESCE(
      NULLIF(v_fare->>'offer_discount_pence','')::int,
      NULLIF(v_fare->>'discount_amount_pence','')::int,
      NULLIF(v_book->>'discount_amount_pence','')::int,
      NULLIF(v_book->>'offer_discount_pence','')::int,
      NULLIF(v_book->>'voucher_discount_pence','')::int,
      0
    )
  );

  -- Prefer explicit net payable keys from fare_snapshot (authoritative preauth amount).
  v_payable := COALESCE(
    NULLIF(v_fare->>'final_fare_pence','')::int,
    NULLIF(v_fare->>'estimated_total_pence','')::int,
    NULLIF(v_fare->>'authorised_amount_pence','')::int,
    NULLIF(v_fare->>'final_estimated_fare_pence','')::int,
    NULLIF(v_book->>'final_estimated_fare_pence','')::int,
    NULLIF(v_book->>'final_fare_pence','')::int,
    NULLIF(v_book->>'estimated_total_pence','')::int,
    NULLIF(v_book->>'final_payable_pence','')::int,
    NULLIF(v_book->>'authorised_amount_pence','')::int,
    p_session_estimated_total_pence,
    p_session_authorised_amount_pence,
    CASE WHEN v_gross > 0 THEN GREATEST(0, v_gross - v_discount) ELSE NULL END
  );

  -- If we only resolved gross and discount was present, never keep gross as payable.
  IF v_payable IS NOT NULL
     AND v_gross > 0
     AND v_discount > 0
     AND v_payable = v_gross
     AND (v_fare ? 'final_fare_pence' OR v_fare ? 'estimated_total_pence'
          OR v_book ? 'final_estimated_fare_pence' OR p_session_authorised_amount_pence IS NOT NULL)
  THEN
    v_payable := COALESCE(
      NULLIF(v_fare->>'final_fare_pence','')::int,
      NULLIF(v_fare->>'estimated_total_pence','')::int,
      NULLIF(v_book->>'final_estimated_fare_pence','')::int,
      p_session_estimated_total_pence,
      p_session_authorised_amount_pence,
      GREATEST(0, v_gross - v_discount)
    );
  END IF;

  IF v_gross <= 0 AND v_payable IS NOT NULL AND v_payable > 0 THEN
    v_gross := v_payable + v_discount;
  END IF;

  IF v_discount <= 0 AND v_gross > 0 AND v_payable IS NOT NULL AND v_payable < v_gross THEN
    v_discount := v_gross - v_payable;
  END IF;

  gross_fare_pence := GREATEST(0, COALESCE(v_gross, 0));
  discount_pence := GREATEST(0, COALESCE(v_discount, 0));
  customer_payable_pence := GREATEST(0, COALESCE(v_payable, 0));
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.resolve_booking_customer_payable_pence(jsonb, jsonb, integer, integer) IS
  'SSOT: gross / discount / customer-payable pence from payment session snapshots. Never treat gross as payable when a net/discount exists.';

CREATE OR REPLACE FUNCTION public.payment_authorisation_valid(p_trip_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_ps RECORD;
  v_method text;
  v_provider_state text;
  v_required integer;
  v_authorised integer;
BEGIN
  SELECT id, payment_method, payment_session_id, payment_provider,
         final_customer_fare_pence, estimated_total_pence, locked_base_fare_pence,
         authorised_amount_pence, gross_fare_pence, offer_discount_pence
    INTO v_trip
    FROM public.trips
   WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_method := UPPER(COALESCE(v_trip.payment_method,''));
  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RETURN true; -- non PLATFORM_COLLECTED card paths are out of scope for this gate
  END IF;

  IF v_trip.payment_session_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT id, status, provider_state, authorised_amount_pence, total_authorised_amount_pence,
         currency, released_at, captured_at, trip_id
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = v_trip.payment_session_id
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_ps.status::text IN (
    'cancelled','failed','payment_orphaned','orphan_authorisation',
    'released','RECOVERY_CANCELLED','RECOVERY_DECLINED','RECOVERY_EXPIRED'
  ) THEN
    RETURN false;
  END IF;

  IF v_ps.released_at IS NOT NULL AND v_ps.captured_at IS NULL THEN
    RETURN false;
  END IF;

  v_provider_state := UPPER(COALESCE(v_ps.provider_state,''));
  IF v_provider_state NOT IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED') THEN
    RETURN false;
  END IF;

  v_authorised := COALESCE(
    NULLIF(v_ps.total_authorised_amount_pence, 0),
    NULLIF(v_ps.authorised_amount_pence, 0),
    NULLIF(v_trip.authorised_amount_pence, 0),
    0
  );
  IF v_authorised <= 0 THEN
    RETURN false;
  END IF;

  v_required := COALESCE(
    NULLIF(v_trip.final_customer_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(v_trip.locked_base_fare_pence, 0),
    0
  );
  IF v_required <= 0 THEN
    RETURN false;
  END IF;

  RETURN v_authorised >= v_required;
END;
$function$;

COMMENT ON FUNCTION public.payment_authorisation_valid(uuid) IS
  'PLATFORM_COLLECTED card: true iff session hold is usable and authorised amount >= locked customer payable (pence).';

GRANT EXECUTE ON FUNCTION public.payment_authorisation_valid(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assert_payment_gate(p_trip_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_ps RECORD;
  v_method text;
  v_provider_state text;
  v_required integer;
  v_authorised integer;
BEGIN
  SELECT id, payment_method, payment_session_id, currency_code,
         final_customer_fare_pence, estimated_total_pence, locked_base_fare_pence,
         authorised_amount_pence
    INTO v_trip
    FROM public.trips
   WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: trip % not found', p_trip_id USING ERRCODE='P0001';
  END IF;

  v_method := UPPER(COALESCE(v_trip.payment_method,''));
  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RETURN;
  END IF;

  IF v_trip.payment_session_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: trip % has no payment_session_id', p_trip_id
      USING ERRCODE='P0001';
  END IF;

  SELECT id, status, provider_state, authorised_amount_pence, total_authorised_amount_pence,
         currency, released_at, captured_at
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = v_trip.payment_session_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session missing' USING ERRCODE='P0001';
  END IF;

  v_provider_state := UPPER(COALESCE(v_ps.provider_state,''));
  IF v_provider_state NOT IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=%', v_ps.provider_state
      USING ERRCODE='P0001';
  END IF;

  IF v_ps.status::text IN (
    'cancelled','failed','payment_orphaned','orphan_authorisation','released',
    'RECOVERY_CANCELLED','RECOVERY_DECLINED','RECOVERY_EXPIRED'
  ) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session status=%', v_ps.status
      USING ERRCODE='P0001';
  END IF;

  IF v_ps.released_at IS NOT NULL AND v_ps.captured_at IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: hold released without capture'
      USING ERRCODE='P0001';
  END IF;

  v_authorised := COALESCE(
    NULLIF(v_ps.total_authorised_amount_pence, 0),
    NULLIF(v_ps.authorised_amount_pence, 0),
    NULLIF(v_trip.authorised_amount_pence, 0),
    0
  );
  IF v_authorised <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised_amount_pence=%', v_authorised
      USING ERRCODE='P0001';
  END IF;

  v_required := COALESCE(
    NULLIF(v_trip.final_customer_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(v_trip.locked_base_fare_pence, 0),
    0
  );
  IF v_required <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: locked customer payable missing'
      USING ERRCODE='P0001';
  END IF;

  IF v_authorised < v_required THEN
    RAISE EXCEPTION
      'PAYMENT_GATE_NOT_SATISFIED: PAYMENT_AUTHORISATION_INSUFFICIENT authorised=% required=%',
      v_authorised, v_required
      USING ERRCODE='P0001';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.assert_payment_gate(uuid) IS
  'Dispatch/accept gate: PLATFORM_COLLECTED card trips require usable hold with authorised >= locked customer payable.';

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

  -- Amount gate uses customer payable (net), never gross-only.
  IF COALESCE(v_ps.authorised_amount_pence,0) < v_fare.customer_payable_pence THEN
    RAISE EXCEPTION
      'PAYMENT_GATE_NOT_SATISFIED: PAYMENT_AUTHORISATION_INSUFFICIENT authorised=% required=%',
      v_ps.authorised_amount_pence, v_fare.customer_payable_pence
      USING ERRCODE='P0001';
  END IF;

  v_buffer_pence := COALESCE(
    NULLIF(v_draft->>'buffer_pence','')::int,
    NULLIF(v_ps.fare_snapshot->>'buffer_pence','')::int,
    v_ps.buffer_pence,
    0
  );

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

  UPDATE public.payment_sessions
     SET trip_id = v_trip_id,
         status = 'trip_created',
         booking_snapshot = CASE WHEN booking_snapshot = '{}'::jsonb THEN v_draft ELSE booking_snapshot END,
         updated_at = now(),
         -- Clear stale incompatible failure reasons after successful usable auth.
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

COMMENT ON FUNCTION public.finalize_paid_booking_session(uuid) IS
  'Authoritative paid booking trip insert. Persists gross/discount/customer-payable separately. Requires authorised >= customer payable.';

-- ---------------------------------------------------------------------------
-- Inject amount gate into dispatch SSOT (uuid, text) without rewriting body.
-- Auto-dispatch trigger uses this overload; Edge schedule-dispatch also does.
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  v_def text;
  v_marker text :=
    E'  END IF;\n\n  SELECT * INTO v_g FROM public.global_dispatch_settings WHERE singleton = true LIMIT 1;';
  v_inject text :=
$inj$
  END IF;

  -- P0 #1: PLATFORM_COLLECTED card amount gate before any ride_offer insert.
  BEGIN
    PERFORM public.assert_payment_gate(p_trip_id);
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      RETURN jsonb_build_object(
        'trip_id', p_trip_id,
        'trip_code', v_trip.trip_code,
        'round', COALESCE(v_trip.current_broadcast_round, 0),
        'status', 'payment_gate_failed',
        'offers_created', 0,
        'offer_ids', '[]'::jsonb,
        'selected_driver_ids', '[]'::jsonb,
        'skipped_driver_ids', '[]'::jsonb,
        'candidate_count', 0,
        'eligible_count', 0,
        'wave_cap', NULL,
        'search_radius_meters', NULL,
        'reason', SQLERRM,
        'code', CASE
          WHEN SQLERRM ILIKE '%PAYMENT_AUTHORISATION_INSUFFICIENT%'
            THEN 'PAYMENT_AUTHORISATION_INSUFFICIENT'
          ELSE 'PAYMENT_GATE_NOT_SATISFIED'
        END
      );
  END;

  SELECT * INTO v_g FROM public.global_dispatch_settings WHERE singleton = true LIMIT 1;
$inj$;
BEGIN
  SELECT pg_get_functiondef('public.dispatch_trip_offers(uuid,text)'::regprocedure)
    INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'dispatch_trip_offers(uuid,text) missing';
  END IF;

  IF position('PAYMENT_AUTHORISATION_INSUFFICIENT' in v_def) > 0
     AND position('assert_payment_gate(p_trip_id)' in v_def) > 0 THEN
    RAISE NOTICE 'dispatch_trip_offers already has payment amount gate';
    RETURN;
  END IF;

  IF position(v_marker in v_def) = 0 THEN
    RAISE EXCEPTION 'dispatch_trip_offers patch marker not found — abort (no blind rewrite)';
  END IF;

  v_def := replace(v_def, v_marker, v_inject);
  EXECUTE v_def;
END;
$patch$;
