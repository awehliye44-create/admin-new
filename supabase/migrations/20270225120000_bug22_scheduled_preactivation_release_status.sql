-- Bug #22: pre-activation scheduled assignment release must reopen Requested
-- marketplace with status=scheduled (Make Available shape), never status=offered.
-- status=offered + scheduled_status=broadcasting caused Customer Finding while
-- dispatch_mode stayed scheduled (MK-261115-004).

CREATE OR REPLACE FUNCTION public.release_scheduled_assignment_for_compliance(
  p_trip_id uuid,
  p_expected_driver_id uuid,
  p_reason text DEFAULT 'compliance_ineligible',
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
BEGIN
  IF p_trip_id IS NULL OR p_expected_driver_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_ARGS');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  -- Idempotent: already unassigned
  IF v_trip.confirmed_driver_id IS NULL AND v_trip.driver_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'released', false,
      'idempotent', true,
      'error', 'ALREADY_RELEASED'
    );
  END IF;

  -- Protect activated / in-progress journeys (use existing rematch paths).
  IF v_trip.started_at IS NOT NULL
     OR v_trip.driver_id IS NOT NULL
     OR lower(COALESCE(v_trip.status::text, '')) IN (
       'in_progress', 'en_route_to_pickup', 'arrived', 'arrived_at_pickup',
       'completed', 'cancelled'
     )
  THEN
    RETURN jsonb_build_object(
      'success', false,
      'released', false,
      'error', 'IN_PROGRESS_PROTECTED'
    );
  END IF;

  IF v_trip.confirmed_driver_id IS DISTINCT FROM p_expected_driver_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'released', false,
      'error', 'DRIVER_MISMATCH'
    );
  END IF;

  IF COALESCE(v_trip.scheduled_status::text, '') NOT IN (
    'driver_assigned', 'scheduled_committed', 'awaiting_activation_accept', 'scheduled'
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'released', false,
      'error', 'INVALID_STATE',
      'scheduled_status', v_trip.scheduled_status
    );
  END IF;

  -- Exclude ineligible driver from reconfirming this booking.
  BEGIN
    PERFORM public.decline_scheduled_ride(p_trip_id, p_expected_driver_id, COALESCE(p_reason, 'compliance_ineligible'));
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
      dispatch_mode = 'instant',
      scheduled_status = 'converted_to_instant',
      status = 'searching',
      scheduled_broadcast_at = v_now,
      broadcast_started_at = v_now,
      current_offer_driver_id = NULL,
      current_offer_expires_at = NULL,
      commitment_time = NULL,
      scheduled_committed_at = NULL,
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
      scheduled_status = CASE
        WHEN COALESCE(broadcast_enabled, true) THEN 'broadcasting'
        ELSE 'admin_held'
      END,
      -- Bug #22: Make Available shape — never status=offered (Customer Finding).
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

  INSERT INTO public.audit_logs (event_type, driver_id, trip_id, details)
  VALUES (
    'scheduled_job_compliance_released',
    p_expected_driver_id,
    p_trip_id,
    jsonb_build_object(
      'reason', COALESCE(p_reason, 'compliance_ineligible'),
      'urgent', COALESCE(p_urgent, false),
      'at', v_now
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'released', true,
    'urgent', COALESCE(p_urgent, false) AND COALESCE(v_trip.broadcast_enabled, true),
    'trip_id', p_trip_id,
    'driver_id', p_expected_driver_id
  );
END;
$function$;

COMMENT ON FUNCTION public.release_scheduled_assignment_for_compliance(uuid, uuid, text, boolean) IS
  'Atomically clear unactivated confirmed scheduled assignment for compliance; exclude driver; reopen marketplace (status=scheduled, Bug #22) or urgent convert. No fare/payment mutation. No cancellation of customer booking.';

REVOKE ALL ON FUNCTION public.release_scheduled_assignment_for_compliance(uuid, uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_scheduled_assignment_for_compliance(uuid, uuid, text, boolean) TO service_role;
