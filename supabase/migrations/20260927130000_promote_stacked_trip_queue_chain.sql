-- Stacked queue depth SSOT: Admin max_stacked_rides (1–3).
-- After promoting the head of queue, re-link the next queued trip onto the
-- newly active trip so restore/failure/promotion chains honor multi-queue (2–3).

CREATE OR REPLACE FUNCTION public.promote_stacked_trip(
  p_driver_id uuid,
  p_completed_trip_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_stacked_trip_id uuid;
  v_next_queued_id  uuid;
  v_promoted_trip   record;
  v_blocking_count  integer;
  v_pickup_stop_id  uuid;
  v_passenger_id    uuid;
BEGIN
  IF p_completed_trip_id IS NOT NULL THEN
    SELECT stacked_trip_id INTO v_stacked_trip_id
    FROM trips
    WHERE id = p_completed_trip_id;
  END IF;

  -- Prefer linked head; otherwise earliest queue position (supports max 1–3).
  IF v_stacked_trip_id IS NULL THEN
    SELECT id INTO v_stacked_trip_id
    FROM trips
    WHERE status = 'queued'
      AND (driver_id = p_driver_id OR confirmed_driver_id = p_driver_id)
    ORDER BY stack_position ASC NULLS LAST, created_at ASC
    LIMIT 1;
  END IF;

  IF v_stacked_trip_id IS NULL THEN
    UPDATE drivers SET current_trip_id = NULL, updated_at = now()
    WHERE id = p_driver_id;
    RETURN jsonb_build_object('promoted', false, 'reason', 'no_stacked_trip');
  END IF;

  SELECT COUNT(*) INTO v_blocking_count
  FROM trips
  WHERE (driver_id = p_driver_id OR confirmed_driver_id = p_driver_id)
    AND status IN ('accepted', 'arrived', 'arrived_at_pickup', 'arrived_pickup', 'at_pickup',
                   'pickup_waiting', 'waiting', 'in_progress')
    AND id != v_stacked_trip_id;

  IF v_blocking_count > 0 THEN
    RETURN jsonb_build_object('promoted', false, 'reason', 'blocking_trip_exists');
  END IF;

  UPDATE trips
  SET
    status                          = 'accepted',
    driver_id                       = p_driver_id,
    confirmed_driver_id             = p_driver_id,
    dispatch_status                 = 'assigned',
    stack_position                  = NULL,
    current_stop_index              = 0,
    current_stop_id                 = NULL,
    started_at                      = NULL,
    arrived_at                      = NULL,
    pickup_waiting_started_at       = NULL,
    pickup_paid_waiting_started_at  = NULL,
    grace_period_expired_at         = NULL,
    pickup_waiting_charge_pence     = 0,
    stop_arrived_at                 = NULL,
    stop_waiting_started_at         = NULL,
    stop_waiting_status             = NULL,
    stop_waiting_paid_started_at    = NULL,
    stop_waiting_charge_pence       = 0,
    stop_waiting_charge_amount      = 0,
    stop_charge_total_pence         = 0,
    stop_waiting_finalized_at       = NULL,
    waiting_charge_pence            = 0,
    total_waiting_charge_pence      = 0,
    updated_at                      = now()
  WHERE id = v_stacked_trip_id
    AND (driver_id = p_driver_id OR confirmed_driver_id = p_driver_id OR status = 'queued')
  RETURNING * INTO v_promoted_trip;

  IF v_promoted_trip IS NULL THEN
    UPDATE drivers SET current_trip_id = NULL, updated_at = now()
    WHERE id = p_driver_id;
    RETURN jsonb_build_object('promoted', false, 'reason', 'promotion_failed');
  END IF;

  UPDATE trip_stops
  SET
    status                     = 'pending',
    arrived_at                 = NULL,
    waiting_charge_active      = false,
    waiting_started_at         = NULL,
    waiting_stopped_at         = NULL,
    waiting_total_amount_pence = 0,
    updated_at                 = now()
  WHERE trip_id = v_stacked_trip_id;

  UPDATE trip_stops
  SET status = 'current', arrived_at = NULL, updated_at = now()
  WHERE trip_id = v_stacked_trip_id AND stop_index = 0 AND type = 'pickup'
  RETURNING id INTO v_pickup_stop_id;

  IF v_pickup_stop_id IS NOT NULL THEN
    UPDATE trips
    SET current_stop_id = v_pickup_stop_id, current_stop_index = 0, updated_at = now()
    WHERE id = v_stacked_trip_id;
  END IF;

  UPDATE drivers SET current_trip_id = v_stacked_trip_id, updated_at = now()
  WHERE id = p_driver_id;

  IF p_completed_trip_id IS NOT NULL THEN
    UPDATE trips
    SET
      dispatch_status = 'completed',
      stacked_trip_id = NULL,
      stack_position  = NULL,
      updated_at      = now()
    WHERE id = p_completed_trip_id
      AND status IN ('completed', 'cancelled', 'expired');
  END IF;

  UPDATE trips
  SET stacked_trip_id = NULL, stack_position = NULL, updated_at = now()
  WHERE stacked_trip_id = v_stacked_trip_id
    AND status IN ('completed', 'cancelled', 'expired')
    AND id IS DISTINCT FROM p_completed_trip_id;

  -- Chain remaining queue (Admin max up to 3) onto the newly active trip.
  SELECT id INTO v_next_queued_id
  FROM trips
  WHERE status = 'queued'
    AND (driver_id = p_driver_id OR confirmed_driver_id = p_driver_id)
    AND id IS DISTINCT FROM v_stacked_trip_id
  ORDER BY stack_position ASC NULLS LAST, created_at ASC
  LIMIT 1;

  IF v_next_queued_id IS NOT NULL THEN
    UPDATE trips
    SET stacked_trip_id = v_next_queued_id, updated_at = now()
    WHERE id = v_stacked_trip_id;
  END IF;

  v_passenger_id := v_promoted_trip.passenger_id;
  IF v_passenger_id IS NOT NULL THEN
    UPDATE customers
    SET active_trip_id = v_stacked_trip_id, updated_at = now()
    WHERE id = v_passenger_id;
  END IF;

  BEGIN
    PERFORM public.record_booking_delivery(
      v_stacked_trip_id,
      'accepted',
      p_driver_id,
      NULL,
      'promote_stacked_trip',
      jsonb_build_object(
        'stacked_activation', true,
        'completed_trip_id',  p_completed_trip_id,
        'lifecycle_reset',    true,
        'next_queued_trip_id', v_next_queued_id
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[promote_stacked_trip] record_booking_delivery failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'promoted', true,
    'trip_id',  v_promoted_trip.id,
    'next_queued_trip_id', v_next_queued_id,
    'trip',     row_to_json(v_promoted_trip)
  );
END;
$function$;
