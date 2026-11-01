-- Accept scheduled ride must use the same live Europe/London document eligibility
-- SSOT as instant accept-offer (check_driver_documents_approved →
-- get_driver_document_eligibility_internal). Direct RPC cannot bypass this gate.
--
-- Does NOT cancel or interrupt already-accepted / in-progress scheduled work.
-- Activation / check-in of a ride accepted before expiry is unchanged (policy
-- retained; see acceptScheduledRideDocumentEligibilityLock.test.ts).

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
$function$;

COMMENT ON FUNCTION public.accept_scheduled_ride(uuid, uuid) IS
  'Atomically reserve a marketplace scheduled ride for the authenticated driver. '
  'Requires live check_driver_documents_approved (Europe/London eligibility). '
  'Does not interrupt already-accepted or in-progress assignments.';

REVOKE ALL ON FUNCTION public.accept_scheduled_ride(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_scheduled_ride(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_scheduled_ride(uuid, uuid) TO service_role;
