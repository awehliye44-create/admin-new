-- Bug #22: atomic voluntary pre-activation scheduled cancel (full CAS).
-- Mirrors release_scheduled_assignment_for_compliance locking semantics so
-- JIT activate / Phase-5 arm / compliance release / replacement confirm / cancel
-- cannot race-overwrite each other.

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

  -- Idempotent: already unassigned (double-cancel / concurrent winner).
  IF v_trip.confirmed_driver_id IS NULL AND v_trip.driver_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'released', false,
      'idempotent', true,
      'error', 'ALREADY_RELEASED'
    );
  END IF;

  -- Activated / live journey — do NOT reopen marketplace; caller must use
  -- activated cancel / driver-cancel-before-pickup rematch.
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

  -- Exclude cancelling driver from reconfirming this booking.
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
      -- Bug #22: Make Available shape — never status=offered.
      status = 'scheduled',
      dispatch_mode = 'scheduled',
      scheduled_broadcast_at = CASE
        WHEN COALESCE(broadcast_enabled, true) THEN v_broadcast_at
        ELSE NULL
      END,
      dispatch_status = 'available',
      broadcast_enabled = COALESCE(broadcast_enabled, true),
      scheduled_hold_reason = CASE
        WHEN COALESCE(broadcast_enabled, true) THEN 'publication_pending'
        ELSE 'airport_pricing'
      END,
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
      'error', 'CAS_MISMATCH'
    );
  END IF;

  UPDATE public.ride_offers
  SET status = 'cancelled', updated_at = v_now
  WHERE trip_id = p_trip_id
    AND driver_id = p_expected_driver_id
    AND status IN ('pending', 'offered', 'countered');

  BEGIN
    INSERT INTO public.audit_logs (event_type, driver_id, trip_id, details)
    VALUES (
      'scheduled_job_driver_cancelled',
      p_expected_driver_id,
      p_trip_id,
      jsonb_build_object(
        'reason', p_reason,
        'note', p_note,
        'urgent', COALESCE(p_urgent, false),
        'at', v_now,
        'cas', true
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'released', true,
    'urgent', COALESCE(p_urgent, false) AND COALESCE(v_trip.broadcast_enabled, true),
    'trip_id', p_trip_id,
    'driver_id', p_expected_driver_id
  );
END;
$function$;

COMMENT ON FUNCTION public.release_scheduled_assignment_for_driver_cancel(uuid, uuid, text, text, boolean) IS
  'Atomic voluntary pre-activation scheduled cancel (Bug #22). FOR UPDATE + CAS; ACTIVATED_PROTECTED when JIT/live won; marketplace status=scheduled or urgent convert. No fare/payment mutation.';

REVOKE ALL ON FUNCTION public.release_scheduled_assignment_for_driver_cancel(uuid, uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_scheduled_assignment_for_driver_cancel(uuid, uuid, text, text, boolean) TO service_role;
