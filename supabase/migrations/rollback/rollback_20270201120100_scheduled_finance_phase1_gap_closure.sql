-- Rollback for 20270201120100 (explicit approval only).
-- Restores accept_scheduled_ride + activate_paid_corporate_trip to pre-Phase1
-- production definitions (captured 2026-11-12 from thazislrdkjpvvghtvzo).
-- Restores assert_payment_gate to the 120000 (capture-coverage) body so a
-- partial rollback that keeps 120000 remains coherent.
-- Drops scheduled advance-window trigger introduced by 120100.
-- Does NOT change max_advance_days (approved policy remains 5).
-- Does NOT drop payment-first trigger (see 120200 optional rollback).

BEGIN;

DROP TRIGGER IF EXISTS trg_trips_enforce_scheduled_advance_window ON public.trips;
DROP FUNCTION IF EXISTS public.trips_enforce_scheduled_advance_window();

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
  v_required_until timestamptz;
  v_enforced boolean := false;
  v_is_scheduled boolean := false;
BEGIN
  SELECT id, payment_method, payment_session_id, currency_code, financial_model,
         final_customer_fare_pence, estimated_total_pence, locked_base_fare_pence,
         authorised_amount_pence, is_scheduled, scheduled_at, estimated_duration_minutes,
         status, started_at
    INTO v_trip
    FROM public.trips
   WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: trip % not found', p_trip_id USING ERRCODE='P0001';
  END IF;

  -- Never cancel / fail mid-journey coverage from this gate — in-progress uses recovery_required.
  IF v_trip.started_at IS NOT NULL
     OR UPPER(COALESCE(v_trip.status, '')) IN (
       'IN_PROGRESS', 'IN_TRIP', 'STARTED', 'ARRIVED', 'WAITING', 'ON_TRIP'
     ) THEN
    -- Still require amount gate for PLATFORM_COLLECTED card, but skip capture-horizon cancel semantics.
    NULL;
  END IF;

  IF v_trip.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RETURN;
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
         currency, released_at, captured_at, trip_id, metadata,
         capture_deadline
    INTO v_ps
    FROM public.payment_sessions
   WHERE id = v_trip.payment_session_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session missing' USING ERRCODE='P0001';
  END IF;

  IF v_ps.trip_id IS NOT NULL AND v_ps.trip_id <> p_trip_id THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: payment_session bound to different trip'
      USING ERRCODE='P0001';
  END IF;

  IF v_ps.status::text IN (
    'payment_orphaned','orphan_authorisation'
  ) OR COALESCE(v_ps.metadata->>'never_capture','') = 'true' THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: session orphaned/superseded'
      USING ERRCODE='P0001';
  END IF;

  v_provider_state := UPPER(COALESCE(v_ps.provider_state,''));
  IF v_provider_state NOT IN ('AUTHORISED', 'AUTHORIZED', 'COMPLETED') THEN
    RAISE EXCEPTION 'PAYMENT_GATE_NOT_SATISFIED: provider_state=%', v_ps.provider_state
      USING ERRCODE='P0001';
  END IF;

  IF v_ps.status::text IN (
    'cancelled','failed','released',
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

  -- Scheduled capture-deadline coverage (pre-start only).
  v_is_scheduled := COALESCE(v_trip.is_scheduled, false) OR v_trip.scheduled_at IS NOT NULL;
  IF v_is_scheduled
     AND v_trip.started_at IS NULL
     AND UPPER(COALESCE(v_trip.status, '')) NOT IN (
       'IN_PROGRESS', 'IN_TRIP', 'STARTED', 'ARRIVED', 'WAITING', 'ON_TRIP',
       'COMPLETED', 'CANCELLED', 'CANCELED', 'NO_SHOW', 'EXPIRED'
     )
  THEN
    SELECT COALESCE(scheduled_capture_coverage_enforced, false)
      INTO v_enforced
      FROM public.global_dispatch_settings
     WHERE singleton = true;

    v_required_until := public.required_capture_coverage_until(
      v_trip.scheduled_at,
      v_trip.estimated_duration_minutes,
      360
    );

    IF v_ps.capture_deadline IS NOT NULL AND v_required_until IS NOT NULL THEN
      IF v_ps.capture_deadline < v_required_until THEN
        RAISE EXCEPTION
          'PAYMENT_GATE_NOT_SATISFIED: CAPTURE_DEADLINE_INSUFFICIENT deadline=% required_until=%',
          v_ps.capture_deadline, v_required_until
          USING ERRCODE='P0001';
      END IF;
    ELSIF v_enforced AND v_ps.capture_deadline IS NULL THEN
      RAISE EXCEPTION
        'PAYMENT_GATE_NOT_SATISFIED: CAPTURE_DEADLINE_MISSING'
        USING ERRCODE='P0001';
    END IF;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.accept_scheduled_ride(p_trip_id uuid, p_driver_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_auth_driver uuid := public.current_driver_id();
  v_driver_id uuid;
  v_trip RECORD;
  v_locked boolean;
  v_sa uuid;
  v_end timestamptz;
  v_eval jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_AUTHENTICATED', 'message', 'Sign in required');
  END IF;

  IF v_auth_driver IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_NOT_FOUND', 'message', 'Driver profile not linked');
  END IF;

  v_driver_id := v_auth_driver;
  IF p_driver_id IS NOT NULL AND p_driver_id <> v_auth_driver THEN
    RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN', 'message', 'Cannot accept for another driver');
  END IF;

  -- Live document eligibility (Europe/London calendar) — same SSOT as accept-offer.
  -- Blocks expired / missing / rejected / pending required docs from new accepts.
  IF NOT public.check_driver_documents_approved(v_driver_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DOCUMENTS_NOT_APPROVED',
      'message', 'One or more of your documents has expired or is not approved. Renew them before accepting scheduled rides.'
    );
  END IF;

  -- Driver-scoped lock serialises concurrent accepts for the same driver
  -- (prevents racing two overlapping scheduled jobs through acceptance).
  PERFORM pg_advisory_xact_lock(hashtext('driver_sched_accept:' || v_driver_id::text));

  v_locked := pg_try_advisory_xact_lock(hashtext(p_trip_id::text));
  IF NOT v_locked THEN
    RETURN jsonb_build_object('success', false, 'error', 'LOCK_CONTENTION', 'message', 'Another driver is accepting this ride');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND', 'message', 'Trip not found');
  END IF;

  IF v_trip.driver_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_ALREADY_TAKEN', 'message', 'This ride has already been taken by another driver');
  END IF;

  IF v_trip.confirmed_driver_id IS NOT NULL AND v_trip.confirmed_driver_id <> v_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_ALREADY_TAKEN', 'message', 'Another driver has already reserved this ride');
  END IF;

  IF public.driver_is_excluded_from_trip(p_trip_id, v_driver_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DRIVER_EXCLUDED',
      'message', 'Driver is excluded from this trip'
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.scheduled_offer_attempts
    WHERE trip_id = p_trip_id
      AND driver_id = v_driver_id
      AND status IN ('declined', 'timeout', 'cancelled')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_EXCLUDED', 'message', 'You previously declined or timed out on this ride');
  END IF;

  IF NOT public.scheduled_marketplace_is_open(
    v_trip.dispatch_mode,
    v_trip.scheduled_status,
    v_trip.status,
    v_trip.scheduled_at,
    v_trip.scheduled_broadcast_at,
    v_trip.created_at,
    v_trip.driver_id,
    v_trip.confirmed_driver_id,
    now()
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'This job is no longer available');
  END IF;

  SELECT d.service_area_id INTO v_sa FROM public.drivers d WHERE d.id = v_driver_id;
  IF v_trip.service_area_id IS NOT NULL
     AND v_trip.service_area_id IS DISTINCT FROM v_sa
     AND NOT EXISTS (
       SELECT 1 FROM public.driver_service_areas dsa
       WHERE dsa.driver_id = v_driver_id AND dsa.service_area_id = v_trip.service_area_id
     )
  THEN
    RETURN jsonb_build_object('success', false, 'error', 'SERVICE_AREA', 'message', 'This job is outside your service area');
  END IF;

  -- Canonical overlap gate (scheduled ↔ scheduled / live).
  IF v_trip.scheduled_at IS NOT NULL THEN
    v_end := public.trip_schedule_estimated_end(
      v_trip.scheduled_at,
      COALESCE(v_trip.estimated_duration_minutes, 30)
    );
    v_eval := public.evaluate_trip_schedule_conflict(
      'driver',
      v_driver_id,
      v_trip.scheduled_at,
      v_end,
      COALESCE(v_trip.service_area_id, v_sa),
      p_trip_id,
      'scheduled'
    );
    IF COALESCE((v_eval->>'conflict')::boolean, false) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'SCHEDULED_TRIP_OVERLAP',
        'message', 'You already have a booking that conflicts with this time.',
        'conflicting_trip_id', v_eval->>'conflicting_trip_id',
        'buffer_minutes', (v_eval->>'buffer_minutes')::integer
      );
    END IF;
  END IF;

  UPDATE public.trips
  SET
    confirmed_driver_id = v_driver_id,
    status = 'accepted',
    scheduled_status = 'driver_assigned',
    scheduled_accepted_at = now(),
    current_offer_driver_id = NULL,
    current_offer_expires_at = NULL,
    updated_at = now()
  WHERE id = p_trip_id;

  INSERT INTO public.scheduled_offer_attempts
    (trip_id, driver_id, status, responded_at, response_time_seconds)
  VALUES
    (p_trip_id, v_driver_id, 'accepted', now(), 0)
  ON CONFLICT (trip_id, driver_id, broadcast_round)
  DO UPDATE SET status = 'accepted', responded_at = now();

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', p_trip_id,
    'message', 'Scheduled ride reserved successfully'
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.activate_paid_corporate_trip(p_trip_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trip not found';
  END IF;

  IF v_trip.corporate_account_id IS NULL
     OR NOT public.has_corporate_access(auth.uid(), v_trip.corporate_account_id) THEN
    RAISE EXCEPTION 'Not authorised for this trip';
  END IF;

  IF v_trip.status <> 'pending_payment' THEN
    RETURN; -- already activated or terminal; nothing to do
  END IF;

  IF v_trip.provider_order_id IS NULL THEN
    RAISE EXCEPTION 'Trip has no payment order';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payment_sessions ps
    WHERE ps.provider_order_id = v_trip.provider_order_id
      AND ps.status IN ('pending_payment', 'failed', 'cancelled', 'authorising')
  ) THEN
    RAISE EXCEPTION 'Payment is not authorised';
  END IF;

  UPDATE public.trips
     SET status = CASE WHEN COALESCE(is_scheduled, false) THEN 'scheduled' ELSE 'pending' END,
         payment_state = 'booking_created',
         updated_at = now()
   WHERE id = p_trip_id;

  IF NOT COALESCE(v_trip.is_scheduled, false) THEN
    BEGIN
      PERFORM public.dispatch_trip_offers(p_trip_id, 'corporate_payment_authorised');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[activate_paid_corporate_trip] dispatch failed for %: % (%)', p_trip_id, SQLERRM, SQLSTATE;
    END;
  END IF;
END;
$function$
;

COMMIT;
