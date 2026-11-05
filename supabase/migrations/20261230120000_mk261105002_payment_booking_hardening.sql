-- MK-261105-002: payment/booking hardening
-- 1) claim_payment_session_tripless_release — FOR UPDATE claim before voiding holds
-- 2) finalize_paid_booking_session refuses hold_release_state=releasing
-- 3) customer_payment_failure_notices + list/acknowledge RPCs
-- 4) enforce_digital_payment_gate always re-checks current session auth

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Claim tripless hold release (atomic vs finalize)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_payment_session_tripless_release(
  p_session_id uuid,
  p_reason text DEFAULT NULL,
  p_source text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ps public.payment_sessions%ROWTYPE;
  v_now timestamptz := now();
  v_hold text;
BEGIN
  IF p_session_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'missing_session_id');
  END IF;

  SELECT * INTO v_ps
  FROM public.payment_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  IF v_ps.trip_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'has_trip',
      'trip_id', v_ps.trip_id
    );
  END IF;

  IF v_ps.released_at IS NOT NULL OR v_ps.captured_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'already_terminal',
      'idempotent', true,
      'hold_release_state', v_ps.hold_release_state
    );
  END IF;

  v_hold := lower(COALESCE(v_ps.hold_release_state, ''));
  IF v_hold IN ('released', 'captured') THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'already_terminal',
      'idempotent', true,
      'hold_release_state', v_ps.hold_release_state
    );
  END IF;

  IF v_hold = 'releasing' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'claim_held',
      'idempotent', true,
      'hold_release_state', 'releasing'
    );
  END IF;

  UPDATE public.payment_sessions
  SET
    hold_release_state = 'releasing',
    release_attempt_count = COALESCE(release_attempt_count, 0) + 1,
    updated_at = v_now,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'tripless_release_claimed_at', v_now,
      'tripless_release_reason', NULLIF(trim(COALESCE(p_reason, '')), ''),
      'tripless_release_source', NULLIF(trim(COALESCE(p_source, '')), '')
    )
  WHERE id = p_session_id
    AND trip_id IS NULL
    AND released_at IS NULL
    AND captured_at IS NULL
    AND lower(COALESCE(hold_release_state, '')) IS DISTINCT FROM 'releasing';

  IF NOT FOUND THEN
    -- Lost race to finalize or concurrent claim — re-read.
    SELECT * INTO v_ps FROM public.payment_sessions WHERE id = p_session_id;
    IF v_ps.trip_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'has_trip', 'trip_id', v_ps.trip_id);
    END IF;
    IF lower(COALESCE(v_ps.hold_release_state, '')) = 'releasing' THEN
      RETURN jsonb_build_object(
        'ok', true,
        'code', 'claim_held',
        'idempotent', true,
        'hold_release_state', 'releasing'
      );
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'claim_failed');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'claimed',
    'idempotent', false,
    'hold_release_state', 'releasing'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_payment_session_tripless_release(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_payment_session_tripless_release(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.claim_payment_session_tripless_release(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_session_tripless_release(uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.claim_payment_session_tripless_release(uuid, text, text) IS
  'MK-261105-002: FOR UPDATE claim to void a tripless authorised hold. Returns has_trip if finalize won.';

-- ---------------------------------------------------------------------------
-- 2. Finalize refuses releasing claim
-- ---------------------------------------------------------------------------
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

  -- MK-261105-002: refuse finalize while tripless release has claimed the session.
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

  -- A trip committed concurrently for THIS booking (create-trip-after-payment insert)
  -- is adopted only when every canonical identifier matches. Any other live trip
  -- still fails closed below.
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
    -- A trip committed concurrently for THIS booking (create-trip-after-payment insert)
    -- is adopted only when every canonical identifier matches. Any other live trip
    -- still fails closed below.
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

-- ---------------------------------------------------------------------------
-- 3. Customer payment-failure acknowledgement notices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_payment_failure_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_id uuid NOT NULL REFERENCES public.customers (id),
  client_action_id uuid,
  trip_id uuid,
  payment_session_id uuid,
  provider_order_id text,
  kind text NOT NULL CHECK (kind IN ('booking_not_created', 'booking_cancelled_payment')),
  title text NOT NULL,
  message text NOT NULL,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  push_dispatched_at timestamptz,
  customer_acknowledged_at timestamptz,
  CONSTRAINT customer_payment_failure_notices_dedupe_key_key UNIQUE (dedupe_key)
);

CREATE INDEX IF NOT EXISTS customer_payment_failure_notices_passenger_pending_idx
  ON public.customer_payment_failure_notices (passenger_id)
  WHERE customer_acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS customer_payment_failure_notices_trip_id_idx
  ON public.customer_payment_failure_notices (trip_id)
  WHERE trip_id IS NOT NULL;

ALTER TABLE public.customer_payment_failure_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_payment_failure_notices FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.customer_payment_failure_notices FROM PUBLIC;
REVOKE ALL ON TABLE public.customer_payment_failure_notices FROM anon;
REVOKE ALL ON TABLE public.customer_payment_failure_notices FROM authenticated;
GRANT ALL ON TABLE public.customer_payment_failure_notices TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_customer_payment_failure_notice(
  p_passenger_id uuid,
  p_kind text,
  p_title text,
  p_message text,
  p_dedupe_key text,
  p_client_action_id uuid DEFAULT NULL,
  p_trip_id uuid DEFAULT NULL,
  p_payment_session_id uuid DEFAULT NULL,
  p_provider_order_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_passenger_id IS NULL OR NULLIF(trim(p_kind), '') IS NULL
     OR NULLIF(trim(p_dedupe_key), '') IS NULL THEN
    RAISE EXCEPTION 'invalid_notice_args' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.customer_payment_failure_notices (
    passenger_id, kind, title, message, dedupe_key,
    client_action_id, trip_id, payment_session_id, provider_order_id
  ) VALUES (
    p_passenger_id, p_kind, p_title, p_message, p_dedupe_key,
    p_client_action_id, p_trip_id, p_payment_session_id, NULLIF(trim(COALESCE(p_provider_order_id, '')), '')
  )
  ON CONFLICT (dedupe_key) DO UPDATE
    SET title = EXCLUDED.title,
        message = EXCLUDED.message
    -- Never reopen an acknowledged notice on webhook retry.
    WHERE public.customer_payment_failure_notices.customer_acknowledged_at IS NULL
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id
    FROM public.customer_payment_failure_notices
    WHERE dedupe_key = p_dedupe_key;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_customer_payment_failure_notice(uuid, text, text, text, text, uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_customer_payment_failure_notice(uuid, text, text, text, text, uuid, uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_customer_payment_failure_notice(uuid, text, text, text, text, uuid, uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_customer_payment_failure_notice(uuid, text, text, text, text, uuid, uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.list_pending_customer_payment_failure_notices()
RETURNS TABLE (
  id uuid,
  kind text,
  title text,
  message text,
  trip_id uuid,
  client_action_id uuid,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT n.id, n.kind, n.title, n.message, n.trip_id, n.client_action_id, n.created_at
  FROM public.customer_payment_failure_notices n
  JOIN public.customers c ON c.id = n.passenger_id
  WHERE n.customer_acknowledged_at IS NULL
    AND c.user_id = auth.uid()
  ORDER BY n.created_at ASC;
$$;

REVOKE ALL ON FUNCTION public.list_pending_customer_payment_failure_notices() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_pending_customer_payment_failure_notices() FROM anon;
GRANT EXECUTE ON FUNCTION public.list_pending_customer_payment_failure_notices() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_pending_customer_payment_failure_notices() TO service_role;

CREATE OR REPLACE FUNCTION public.acknowledge_customer_payment_failure_notice(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.customer_payment_failure_notices notice
  SET customer_acknowledged_at = COALESCE(notice.customer_acknowledged_at, now())
  FROM public.customers c
  WHERE notice.id = p_id
    AND notice.passenger_id = c.id
    AND c.user_id = auth.uid();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.acknowledge_customer_payment_failure_notice(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acknowledge_customer_payment_failure_notice(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_customer_payment_failure_notice(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_customer_payment_failure_notice(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Payment gate: always re-check current session (no OLD gated skip)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_digital_payment_gate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_method text := UPPER(COALESCE(NEW.payment_method, ''));
  v_new_status text := LOWER(COALESCE(NEW.status, ''));
  v_gated_states text[] := ARRAY[
    'searching','searching_new_driver','broadcasting',
    'offered','offering','negotiating','driver_notified',
    'awaiting_driver_response','accepted','confirmed',
    'driver_assigned','assigned','queued',
    'en_route','en_route_to_pickup','driver_en_route','enroute_to_pickup',
    'driver_arriving','arrived','arrived_pickup','arrived_at_pickup',
    'at_pickup','pickup_waiting','waiting','waiting_at_pickup',
    'in_progress','started','on_trip','ongoing','trip_started','completed',
    'scheduled'
  ];
  v_ps RECORD;
  v_fm text := UPPER(COALESCE(NEW.financial_model, ''));
BEGIN
  -- Driver-collected commission wallet: no platform hold.
  IF v_fm = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RETURN NEW;
  END IF;

  IF v_method NOT IN ('CARD','APPLE_PAY','GOOGLE_PAY') THEN
    RETURN NEW;
  END IF;

  IF NOT (v_new_status = ANY(v_gated_states)) THEN
    RETURN NEW;
  END IF;

  -- MK-261105-002: always re-validate current session auth (do not skip when OLD was gated).

  IF NEW.payment_session_id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: digital-payment trip requires payment_session_id (trip=%, method=%)',
      NEW.id, v_method USING ERRCODE = 'check_violation';
  END IF;

  SELECT id, status, provider_state, currency, authorised_amount_pence, hold_release_state
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = NEW.payment_session_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session % not found', NEW.payment_session_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF UPPER(COALESCE(v_ps.provider_state,'')) NOT IN ('AUTHORISED','AUTHORIZED','COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=% for session % (trip=%)',
      v_ps.provider_state, v_ps.id, NEW.id USING ERRCODE = 'check_violation';
  END IF;

  IF v_ps.status IN (
    'cancelled','canceled','failed','expired','abandoned','payment_orphaned','released'
  ) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session status=% (trip=%)', v_ps.status, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF lower(COALESCE(v_ps.hold_release_state, '')) IN ('released', 'releasing') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: hold_release_state=% (trip=%)',
      v_ps.hold_release_state, NEW.id USING ERRCODE = 'check_violation';
  END IF;

  IF LOWER(COALESCE(v_ps.currency,'')) <> LOWER(COALESCE(NEW.currency, v_ps.currency, '')) THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: currency mismatch session=% trip=%',
      v_ps.currency, NEW.currency USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(v_ps.authorised_amount_pence,0) <= 0 THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: authorised_amount_pence=% for session %',
      v_ps.authorised_amount_pence, v_ps.id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_digital_payment_gate() IS
  'MK-261105-002: digital-payment trips cannot enter/stay dispatch-visible without a currently authorised payment_sessions row (always re-checked).';

COMMIT;
