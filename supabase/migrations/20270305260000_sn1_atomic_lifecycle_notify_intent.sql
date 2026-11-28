-- SN1 gap-close: authoritative lifecycle transition + notify intent in one txn
-- (or same-txn triggers). Reconciliation recovers any historical misses.
-- Does not send FCM/APNs — pending rows only.

CREATE OR REPLACE FUNCTION public.sn1_insert_pending_lifecycle_notify(
  p_notification_id text,
  p_trip_id uuid,
  p_passenger_id uuid,
  p_event text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid;
  v_now timestamptz := now();
BEGIN
  IF p_notification_id IS NULL OR p_trip_id IS NULL OR p_passenger_id IS NULL OR p_event IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.customer_trip_notification_deliveries (
    notification_id,
    trip_id,
    passenger_id,
    event,
    status,
    attempts,
    metadata,
    created_at,
    updated_at
  ) VALUES (
    p_notification_id,
    p_trip_id,
    p_passenger_id,
    p_event,
    'pending',
    0,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'delivery_confirmation', 'not_device_heads_up'
    ),
    v_now,
    v_now
  )
  ON CONFLICT (notification_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT d.id INTO v_id
      FROM public.customer_trip_notification_deliveries d
     WHERE d.notification_id = p_notification_id;
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.sn1_insert_pending_lifecycle_notify(text, uuid, uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sn1_insert_pending_lifecycle_notify(text, uuid, uuid, text, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.sn1_insert_pending_lifecycle_notify(text, uuid, uuid, text, jsonb) IS
  'SN1: idempotent pending lifecycle notify claim. UNIQUE(notification_id). No provider send.';

-- Atomic Accept preconfirm normalize + scheduled_accept notify intent.
CREATE OR REPLACE FUNCTION public.sn1_finalize_scheduled_accept_preconfirm(
  p_trip_id uuid,
  p_driver_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_passenger uuid;
  v_scheduled_at timestamptz;
  v_updated int := 0;
  v_notif_id text;
  v_delivery_id uuid;
  v_now timestamptz := now();
BEGIN
  IF p_trip_id IS NULL OR p_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ARGS');
  END IF;

  UPDATE public.trips t
     SET driver_id = NULL,
         confirmed_driver_id = p_driver_id,
         scheduled_status = 'driver_assigned',
         status = 'scheduled',
         updated_at = v_now
   WHERE t.id = p_trip_id
     AND (t.confirmed_driver_id IS NULL OR t.confirmed_driver_id = p_driver_id);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  SELECT t.passenger_id, t.scheduled_at
    INTO v_passenger, v_scheduled_at
    FROM public.trips t
   WHERE t.id = p_trip_id;

  IF v_passenger IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'NO_PASSENGER',
      'preconfirm_updated', v_updated > 0
    );
  END IF;

  -- If update matched 0 but trip already preconfirmed to this driver, still ensure intent.
  IF v_updated = 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.trips t
       WHERE t.id = p_trip_id AND t.confirmed_driver_id = p_driver_id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PRECONFIRM_NOT_APPLIED');
    END IF;
  END IF;

  v_notif_id := 'driver_assigned-' || p_trip_id::text || '-scheduled_accept';
  v_delivery_id := public.sn1_insert_pending_lifecycle_notify(
    v_notif_id,
    p_trip_id,
    v_passenger,
    'driver_assigned',
    jsonb_build_object(
      'source', 'sn1_finalize_scheduled_accept_preconfirm',
      'sn1_kind', 'scheduled_accept',
      'confirmed_driver_id', p_driver_id,
      'scheduled_at', v_scheduled_at
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'preconfirm_updated', v_updated > 0,
    'passenger_id', v_passenger,
    'notification_id', v_notif_id,
    'delivery_id', v_delivery_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sn1_finalize_scheduled_accept_preconfirm(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sn1_finalize_scheduled_accept_preconfirm(uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.sn1_finalize_scheduled_accept_preconfirm(uuid, uuid) IS
  'SN1: one transaction — scheduled Accept preconfirm stamp + pending Customer notify intent.';

-- CTAP: same-txn as trip INSERT for scheduled bookings.
CREATE OR REPLACE FUNCTION public.trg_sn1_scheduled_booking_confirm_intent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.is_scheduled IS TRUE AND NEW.passenger_id IS NOT NULL THEN
    PERFORM public.sn1_insert_pending_lifecycle_notify(
      'sn1:scheduled_booking_confirmed:' || NEW.id::text,
      NEW.id,
      NEW.passenger_id,
      'scheduled_booking_confirmed',
      jsonb_build_object(
        'source', 'trg_sn1_scheduled_booking_confirm_intent',
        'sn1_kind', 'scheduled_booking_confirmed',
        'scheduled_at', NEW.scheduled_at
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sn1_scheduled_booking_confirm_intent ON public.trips;
CREATE TRIGGER trg_sn1_scheduled_booking_confirm_intent
  AFTER INSERT ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sn1_scheduled_booking_confirm_intent();

-- Cron convert (unclaimed): same-txn as scheduled_status → converted_to_instant.
-- Skip when OLD.confirmed_driver_id was set (urgent cancel rematch owns cancel notify).
CREATE OR REPLACE FUNCTION public.trg_sn1_scheduled_converted_intent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.scheduled_status IS NOT DISTINCT FROM OLD.scheduled_status THEN
    RETURN NEW;
  END IF;
  IF lower(COALESCE(NEW.scheduled_status, '')) <> 'converted_to_instant' THEN
    RETURN NEW;
  END IF;
  IF lower(COALESCE(OLD.scheduled_status, '')) = 'converted_to_instant' THEN
    RETURN NEW;
  END IF;
  -- Unclaimed convert only — driver cancel urgent convert uses cancel-rematch intent.
  IF OLD.confirmed_driver_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.passenger_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM public.sn1_insert_pending_lifecycle_notify(
    'sn1:scheduled_converted_to_instant:' || NEW.id::text,
    NEW.id,
    NEW.passenger_id,
    'finding_another_driver_updated_fare',
    jsonb_build_object(
      'source', 'trg_sn1_scheduled_converted_intent',
      'sn1_kind', 'scheduled_converted_to_instant',
      'converted_to_instant', true
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sn1_scheduled_converted_intent ON public.trips;
CREATE TRIGGER trg_sn1_scheduled_converted_intent
  AFTER UPDATE OF scheduled_status ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sn1_scheduled_converted_intent();

-- Patch driver-cancel release: insert cancel-rematch intent in the same transaction.
CREATE OR REPLACE FUNCTION public.release_scheduled_assignment_for_driver_cancel(
  p_trip_id uuid,
  p_expected_driver_id uuid,
  p_reason text,
  p_note text DEFAULT NULL,
  p_urgent boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_now timestamptz := now();
  v_broadcast_at timestamptz;
  v_n int := 0;
  v_status text;
  v_sched text;
  v_delivery_id uuid;
  v_notif_id text;
BEGIN
  IF p_trip_id IS NULL OR p_expected_driver_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_ARGS');
  END IF;
  IF COALESCE(trim(p_reason), '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'REASON_REQUIRED');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  v_status := lower(COALESCE(v_trip.status::text, ''));
  v_sched := lower(COALESCE(v_trip.scheduled_status::text, ''));

  IF v_trip.confirmed_driver_id IS NULL AND v_trip.driver_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'released', false,
      'idempotent', true,
      'error', 'ALREADY_RELEASED'
    );
  END IF;

  IF v_trip.started_at IS NOT NULL
     OR v_trip.driver_id IS NOT NULL
     OR v_status IN (
       'in_progress', 'en_route_to_pickup', 'arrived', 'arrived_at_pickup',
       'at_pickup', 'driver_en_route', 'completed', 'cancelled'
     )
     OR v_sched IN ('driver_en_route', 'converted_to_instant')
  THEN
    RETURN jsonb_build_object(
      'success', false,
      'released', false,
      'error', 'ACTIVATED_PROTECTED',
      'status', v_trip.status,
      'scheduled_status', v_trip.scheduled_status,
      'driver_id', v_trip.driver_id,
      'started_at', v_trip.started_at
    );
  END IF;

  IF v_trip.confirmed_driver_id IS DISTINCT FROM p_expected_driver_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'released', false,
      'error', 'DRIVER_MISMATCH',
      'confirmed_driver_id', v_trip.confirmed_driver_id
    );
  END IF;

  IF COALESCE(v_trip.is_scheduled, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('success', false, 'released', false, 'error', 'NOT_SCHEDULED');
  END IF;

  BEGIN
    PERFORM public.decline_scheduled_ride(p_trip_id, p_expected_driver_id, COALESCE(p_reason, 'driver_cancelled'));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  v_broadcast_at := COALESCE(v_trip.scheduled_broadcast_at, v_now);

  IF p_urgent AND COALESCE(v_trip.broadcast_enabled, true) = true THEN
    UPDATE public.trips SET
      driver_id = NULL,
      confirmed_driver_id = NULL,
      cancelled_at = NULL,
      cancelled_by = NULL,
      cancellation_reason = p_reason,
      cancellation_note = p_note,
      dispatch_mode = 'instant',
      scheduled_status = 'converted_to_instant',
      status = 'searching',
      dispatch_status = 'broadcasting',
      scheduled_broadcast_at = v_now,
      broadcast_started_at = v_now,
      current_offer_driver_id = NULL,
      current_offer_expires_at = NULL,
      commitment_time = NULL,
      scheduled_committed_at = NULL,
      scheduled_driver_risk = false,
      scheduled_jit_activate_at = NULL,
      scheduled_jit_eta_minutes = NULL,
      scheduled_jit_eta_observed_at = NULL,
      scheduled_jit_distance_kind = NULL,
      scheduled_jit_eta_source = NULL,
      scheduled_jit_basis_scheduled_at = NULL,
      scheduled_jit_eta_spike_samples = 0,
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id
      AND confirmed_driver_id = p_expected_driver_id
      AND driver_id IS NULL
      AND started_at IS NULL;
  ELSE
    UPDATE public.trips SET
      driver_id = NULL,
      confirmed_driver_id = NULL,
      cancelled_at = NULL,
      cancelled_by = NULL,
      cancellation_reason = p_reason,
      cancellation_note = p_note,
      scheduled_status = CASE
        WHEN COALESCE(broadcast_enabled, true) THEN 'broadcasting'
        ELSE 'admin_held'
      END,
      status = 'scheduled',
      dispatch_status = CASE
        WHEN COALESCE(broadcast_enabled, true) THEN 'broadcasting'
        ELSE dispatch_status
      END,
      scheduled_broadcast_at = v_broadcast_at,
      current_offer_driver_id = NULL,
      current_offer_expires_at = NULL,
      commitment_time = NULL,
      scheduled_committed_at = NULL,
      scheduled_driver_risk = false,
      scheduled_jit_activate_at = NULL,
      scheduled_jit_eta_minutes = NULL,
      scheduled_jit_eta_observed_at = NULL,
      scheduled_jit_distance_kind = NULL,
      scheduled_jit_eta_source = NULL,
      scheduled_jit_basis_scheduled_at = NULL,
      scheduled_jit_eta_spike_samples = 0,
      pending_release_kind = NULL,
      pending_release_at = NULL,
      pending_release_driver_id = NULL,
      updated_at = v_now
    WHERE id = p_trip_id
      AND confirmed_driver_id = p_expected_driver_id
      AND driver_id IS NULL
      AND started_at IS NULL;
  END IF;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'released', false,
      'error', 'CAS_LOST'
    );
  END IF;

  -- SN1: same transaction as release — Customer rematch notify intent.
  IF v_trip.passenger_id IS NOT NULL THEN
    v_notif_id := 'driver_cancelled-scheduled-' || p_trip_id::text;
    v_delivery_id := public.sn1_insert_pending_lifecycle_notify(
      v_notif_id,
      p_trip_id,
      v_trip.passenger_id,
      'driver_cancelled',
      jsonb_build_object(
        'source', 'release_scheduled_assignment_for_driver_cancel',
        'sn1_kind', 'scheduled_cancel_rematch',
        'confirmed_driver_id', p_expected_driver_id,
        'converted_to_instant', COALESCE(p_urgent, false)
          AND COALESCE(v_trip.broadcast_enabled, true)
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'released', true,
    'urgent_convert', COALESCE(p_urgent, false)
      AND COALESCE(v_trip.broadcast_enabled, true),
    'sn1_notification_id', v_notif_id,
    'sn1_delivery_id', v_delivery_id
  );
END;
$function$;

-- Belt-and-suspenders: backfill missing intents from authoritative trip state.
CREATE OR REPLACE FUNCTION public.sn1_reconcile_missing_lifecycle_intents(
  p_limit integer DEFAULT 40
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_limit int := GREATEST(1, LEAST(COALESCE(p_limit, 40), 80));
  v_accept int := 0;
  v_booking int := 0;
  v_convert int := 0;
  v_cancel int := 0;
  v_row RECORD;
BEGIN
  -- Missing preconfirm intents.
  FOR v_row IN
    SELECT t.id, t.passenger_id, t.confirmed_driver_id, t.scheduled_at
      FROM public.trips t
     WHERE t.passenger_id IS NOT NULL
       AND t.confirmed_driver_id IS NOT NULL
       AND lower(COALESCE(t.scheduled_status, '')) IN (
         'driver_assigned', 'scheduled_committed', 'awaiting_activation_accept', 'driver_en_route'
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.customer_trip_notification_deliveries d
          WHERE d.notification_id = 'driver_assigned-' || t.id::text || '-scheduled_accept'
       )
     ORDER BY t.updated_at DESC
     LIMIT v_limit
  LOOP
    PERFORM public.sn1_insert_pending_lifecycle_notify(
      'driver_assigned-' || v_row.id::text || '-scheduled_accept',
      v_row.id,
      v_row.passenger_id,
      'driver_assigned',
      jsonb_build_object(
        'source', 'sn1_reconcile_missing_lifecycle_intents',
        'sn1_kind', 'scheduled_accept',
        'confirmed_driver_id', v_row.confirmed_driver_id,
        'scheduled_at', v_row.scheduled_at,
        'reconcile', true
      )
    );
    v_accept := v_accept + 1;
  END LOOP;

  -- Missing booking-confirm intents (scheduled trips last 14d).
  FOR v_row IN
    SELECT t.id, t.passenger_id, t.scheduled_at
      FROM public.trips t
     WHERE t.is_scheduled IS TRUE
       AND t.passenger_id IS NOT NULL
       AND t.created_at >= now() - interval '14 days'
       AND NOT EXISTS (
         SELECT 1 FROM public.customer_trip_notification_deliveries d
          WHERE d.notification_id = 'sn1:scheduled_booking_confirmed:' || t.id::text
       )
     ORDER BY t.created_at DESC
     LIMIT v_limit
  LOOP
    PERFORM public.sn1_insert_pending_lifecycle_notify(
      'sn1:scheduled_booking_confirmed:' || v_row.id::text,
      v_row.id,
      v_row.passenger_id,
      'scheduled_booking_confirmed',
      jsonb_build_object(
        'source', 'sn1_reconcile_missing_lifecycle_intents',
        'sn1_kind', 'scheduled_booking_confirmed',
        'scheduled_at', v_row.scheduled_at,
        'reconcile', true
      )
    );
    v_booking := v_booking + 1;
  END LOOP;

  -- Missing unclaimed convert intents.
  FOR v_row IN
    SELECT t.id, t.passenger_id
      FROM public.trips t
     WHERE t.passenger_id IS NOT NULL
       AND lower(COALESCE(t.scheduled_status, '')) = 'converted_to_instant'
       AND t.confirmed_driver_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.customer_trip_notification_deliveries d
          WHERE d.notification_id = 'sn1:scheduled_converted_to_instant:' || t.id::text
       )
       -- Prefer not to invent convert notify when a cancel-rematch claim already exists.
       AND NOT EXISTS (
         SELECT 1 FROM public.customer_trip_notification_deliveries d
          WHERE d.notification_id = 'driver_cancelled-scheduled-' || t.id::text
       )
     ORDER BY t.updated_at DESC
     LIMIT v_limit
  LOOP
    PERFORM public.sn1_insert_pending_lifecycle_notify(
      'sn1:scheduled_converted_to_instant:' || v_row.id::text,
      v_row.id,
      v_row.passenger_id,
      'finding_another_driver_updated_fare',
      jsonb_build_object(
        'source', 'sn1_reconcile_missing_lifecycle_intents',
        'sn1_kind', 'scheduled_converted_to_instant',
        'converted_to_instant', true,
        'reconcile', true
      )
    );
    v_convert := v_convert + 1;
  END LOOP;

  -- Missing cancel-rematch intents (driver cancelled pre-activation; rematch open).
  FOR v_row IN
    SELECT t.id, t.passenger_id, t.cancellation_reason
      FROM public.trips t
     WHERE t.passenger_id IS NOT NULL
       AND t.confirmed_driver_id IS NULL
       AND t.cancellation_reason IS NOT NULL
       AND lower(COALESCE(t.status, '')) NOT IN (
         'cancelled', 'canceled', 'completed', 'no_show', 'expired'
       )
       AND (
         lower(COALESCE(t.scheduled_status, '')) IN (
           'broadcasting', 'admin_held', 'converted_to_instant'
         )
         OR (
           t.is_scheduled IS TRUE
           AND lower(COALESCE(t.status, '')) IN ('searching', 'scheduled')
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.customer_trip_notification_deliveries d
          WHERE d.notification_id = 'driver_cancelled-scheduled-' || t.id::text
       )
     ORDER BY t.updated_at DESC
     LIMIT v_limit
  LOOP
    PERFORM public.sn1_insert_pending_lifecycle_notify(
      'driver_cancelled-scheduled-' || v_row.id::text,
      v_row.id,
      v_row.passenger_id,
      'driver_cancelled',
      jsonb_build_object(
        'source', 'sn1_reconcile_missing_lifecycle_intents',
        'sn1_kind', 'scheduled_cancel_rematch',
        'reconcile', true,
        'cancellation_reason', v_row.cancellation_reason
      )
    );
    v_cancel := v_cancel + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'accept_backfill', v_accept,
    'booking_backfill', v_booking,
    'convert_backfill', v_convert,
    'cancel_rematch_backfill', v_cancel
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sn1_reconcile_missing_lifecycle_intents(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sn1_reconcile_missing_lifecycle_intents(integer)
  TO service_role;

COMMENT ON FUNCTION public.sn1_reconcile_missing_lifecycle_intents(integer) IS
  'SN1: durable recovery — insert missing pending lifecycle notify intents from trip state.';

-- Accept: authoritative marketplace reservation + notify intent in ONE transaction.
-- Body matches live accept_scheduled_ride (docs / gates / commitment / CW) plus SN1 insert.
CREATE OR REPLACE FUNCTION public.accept_scheduled_ride(
  p_trip_id uuid,
  p_driver_id uuid DEFAULT NULL::uuid
)
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
  v_notif_id text;
  v_delivery_id uuid;
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

  IF NOT public.check_driver_documents_approved(v_driver_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DOCUMENTS_NOT_APPROVED',
      'message', 'One or more of your documents has expired or is not approved. Renew them before accepting scheduled rides.'
    );
  END IF;

  IF NOT public.driver_eligible_for_scheduled_journey(v_driver_id, p_trip_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DOCUMENTS_EXPIRE_BEFORE_JOURNEY_END',
      'message', 'Required documents do not remain valid through the scheduled journey.'
    );
  END IF;

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

  BEGIN
    PERFORM public.assert_payment_gate(p_trip_id);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'PAYMENT_GATE_NOT_SATISFIED',
      'message', 'This booking cannot be accepted because payment authorisation is not valid.'
    );
  END;

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

  IF COALESCE(
       (public.driver_scheduled_commitment_gate(v_driver_id, p_trip_id, 'additional_scheduled') ->> 'allowed')::boolean,
       true
     ) = false
  THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'SCHEDULED_COMMITMENT_INFEASIBLE',
      'message', 'This booking conflicts with another confirmed scheduled ride.',
      'commitment_trip_id',
        public.driver_scheduled_commitment_gate(v_driver_id, p_trip_id, 'additional_scheduled') ->> 'commitment_trip_id'
    );
  END IF;

  IF NOT public.driver_passes_commission_wallet_dispatch_gate(v_driver_id, p_trip_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INSUFFICIENT_COMMISSION_WALLET_BALANCE',
      'message', 'Your commission wallet balance is too low to take this booking. Top up your wallet and try again.'
    );
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

  -- SN1: same transaction as marketplace accept — Customer preconfirm notify intent.
  IF v_trip.passenger_id IS NOT NULL THEN
    v_notif_id := 'driver_assigned-' || p_trip_id::text || '-scheduled_accept';
    v_delivery_id := public.sn1_insert_pending_lifecycle_notify(
      v_notif_id,
      p_trip_id,
      v_trip.passenger_id,
      'driver_assigned',
      jsonb_build_object(
        'source', 'accept_scheduled_ride',
        'sn1_kind', 'scheduled_accept',
        'confirmed_driver_id', v_driver_id,
        'scheduled_at', v_trip.scheduled_at
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', p_trip_id,
    'message', 'Scheduled ride reserved successfully',
    'sn1_notification_id', v_notif_id,
    'sn1_delivery_id', v_delivery_id
  );
END;
$function$;

COMMENT ON FUNCTION public.accept_scheduled_ride(uuid, uuid) IS
  'Atomically reserve a marketplace scheduled ride + SN1 Customer notify intent. Live docs, payment gate, commitment, CW unchanged.';
