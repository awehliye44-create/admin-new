-- P0 Arrive Phase 3: one transactional pickup waiting start (idempotent).
-- Replaces Edge trips UPDATE + confirming SELECT round-trips.
-- BEFORE trigger trg_persist_pickup_waiting_admin_ssot still freezes admin config
-- when pickup_waiting_started_at is first set.

CREATE OR REPLACE FUNCTION public.start_pickup_waiting_on_arrive(
  p_trip_id uuid,
  p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
BEGIN
  IF p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'trip_id_required');
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;

  IF v_trip.pickup_waiting_started_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_started', true,
      'started_at', v_trip.pickup_waiting_started_at,
      'status', v_trip.status,
      'arrived_at', v_trip.arrived_at,
      'pickup_arrived_at', v_trip.pickup_arrived_at,
      'pickup_waiting_admin_config', v_trip.pickup_waiting_admin_config,
      'free_wait_expires_at', v_trip.free_wait_expires_at,
      'pickup_waiting_charge_pence', COALESCE(v_trip.pickup_waiting_charge_pence, 0),
      'pickup_waiting_counted_seconds', COALESCE(v_trip.pickup_waiting_counted_seconds, 0),
      'service_area_id', v_trip.service_area_id,
      'vehicle_type_id', v_trip.vehicle_type_id,
      'driver_id', v_trip.driver_id
    );
  END IF;

  UPDATE public.trips
  SET
    pickup_waiting_started_at = p_now,
    pickup_arrived_at = COALESCE(pickup_arrived_at, arrived_at, p_now),
    updated_at = p_now
  WHERE id = p_trip_id
  RETURNING * INTO v_trip;

  -- Mirror onto pickup trip_stops when present (best-effort identity, not money SSOT).
  UPDATE public.trip_stops
  SET
    waiting_started_at = COALESCE(waiting_started_at, p_now),
    updated_at = p_now
  WHERE trip_id = p_trip_id
    AND type = 'pickup'
    AND waiting_started_at IS NULL;

  RETURN jsonb_build_object(
    'ok', true,
    'already_started', false,
    'started_at', v_trip.pickup_waiting_started_at,
    'status', v_trip.status,
    'arrived_at', v_trip.arrived_at,
    'pickup_arrived_at', v_trip.pickup_arrived_at,
    'pickup_waiting_admin_config', v_trip.pickup_waiting_admin_config,
    'free_wait_expires_at', v_trip.free_wait_expires_at,
    'pickup_waiting_charge_pence', COALESCE(v_trip.pickup_waiting_charge_pence, 0),
    'pickup_waiting_counted_seconds', COALESCE(v_trip.pickup_waiting_counted_seconds, 0),
    'service_area_id', v_trip.service_area_id,
    'vehicle_type_id', v_trip.vehicle_type_id,
    'driver_id', v_trip.driver_id
  );
END;
$function$;

COMMENT ON FUNCTION public.start_pickup_waiting_on_arrive(uuid, timestamptz) IS
  'Idempotent Arrive pickup waiting start: FOR UPDATE, set pickup_waiting_started_at once, return frozen admin SSOT fields.';

REVOKE ALL ON FUNCTION public.start_pickup_waiting_on_arrive(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_pickup_waiting_on_arrive(uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.start_pickup_waiting_on_arrive(uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_pickup_waiting_on_arrive(uuid, timestamptz) TO service_role;
