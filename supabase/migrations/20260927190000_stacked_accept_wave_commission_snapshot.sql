-- MK-260817-008: stacked accept queued the trip without the accepted-offer
-- financial snapshot. Driver card reads driver_net_pence only → £0.00.
-- Reuse snapshot_accepted_wave_commission (same SSOT as accept_ride_offer).
-- Do not invent a second fare formula. Do not copy customer fare onto driver net.
-- promote_stacked_trip must keep those stamps (lifecycle/queue fields only).

CREATE OR REPLACE FUNCTION public.accept_stacked_ride(
  p_offer_id uuid,
  p_driver_id uuid,
  p_current_trip_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_offer              public.ride_offers%ROWTYPE;
  v_current_trip       public.trips%ROWTYPE;
  v_stacked_trip       public.trips%ROWTYPE;
  v_now                timestamptz := now();
  v_stacked_enabled    boolean := false;
  v_max_stacked        integer := NULL;
  v_queued_count       integer := 0;
  v_revoked_ids        uuid[] := '{}';
  v_passenger_user_id  uuid;
  v_rows_updated       integer;
  v_next_position      integer;
  v_driver_net         integer;
BEGIN
  SELECT * INTO v_offer
  FROM public.ride_offers
  WHERE id = p_offer_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found'; END IF;

  IF v_offer.driver_id IS DISTINCT FROM p_driver_id THEN
    RAISE EXCEPTION 'offer_not_for_driver';
  END IF;

  IF v_offer.status <> 'pending' THEN
    RAISE EXCEPTION 'offer_not_pending::%', v_offer.status;
  END IF;

  IF public.driver_is_excluded_from_trip(v_offer.trip_id, p_driver_id) THEN
    RAISE EXCEPTION 'driver_excluded';
  END IF;

  IF v_offer.expires_at IS NOT NULL AND v_offer.expires_at < v_now THEN
    UPDATE public.ride_offers
    SET status = 'expired', updated_at = v_now
    WHERE id = p_offer_id;
    RAISE EXCEPTION 'offer_expired';
  END IF;

  IF COALESCE(v_offer.offered_driver_net_pence, 0) <= 0 THEN
    RAISE EXCEPTION 'stacked_offer_net_missing';
  END IF;

  IF v_offer.effective_commission_percent IS NULL THEN
    RAISE EXCEPTION 'stacked_offer_commission_missing';
  END IF;

  SELECT * INTO v_stacked_trip
  FROM public.trips
  WHERE id = v_offer.trip_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'trip_not_found'; END IF;

  IF v_offer.trip_id IS DISTINCT FROM v_stacked_trip.id THEN
    RAISE EXCEPTION 'offer_trip_mismatch';
  END IF;

  IF (
        v_stacked_trip.negotiation_owner_driver_id IS NOT NULL
        AND v_stacked_trip.negotiation_owner_driver_id IS DISTINCT FROM p_driver_id
      )
      OR (
        v_stacked_trip.status = 'negotiating'
        AND v_stacked_trip.negotiation_owner_driver_id IS DISTINCT FROM p_driver_id
      )
  THEN
    RAISE EXCEPTION 'NEGOTIATION_HELD';
  END IF;

  SELECT * INTO v_current_trip
  FROM public.trips
  WHERE id = p_current_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'current_trip_not_found'; END IF;

  IF v_current_trip.driver_id IS DISTINCT FROM p_driver_id
     AND v_current_trip.confirmed_driver_id IS DISTINCT FROM p_driver_id THEN
    RAISE EXCEPTION 'current_trip_not_yours';
  END IF;

  IF v_current_trip.status IN (
    'completed', 'cancelled', 'expired', 'declined',
    'customer_cancelled', 'driver_cancelled', 'no_show'
  ) THEN
    RAISE EXCEPTION 'current_trip_terminal::%', v_current_trip.status;
  END IF;

  SELECT
    COALESCE(stacked_rides_enabled, false),
    max_stacked_rides
  INTO v_stacked_enabled, v_max_stacked
  FROM public.global_dispatch_settings
  WHERE singleton = true
  LIMIT 1;

  IF NOT v_stacked_enabled THEN
    RAISE EXCEPTION 'stacked_rides_disabled';
  END IF;

  IF v_max_stacked IS NULL OR v_max_stacked < 1 THEN
    RAISE EXCEPTION 'stacked_config_invalid::max_stacked_rides';
  END IF;

  SELECT COUNT(*)::integer INTO v_queued_count
  FROM public.trips
  WHERE (driver_id = p_driver_id OR confirmed_driver_id = p_driver_id)
    AND status = 'queued';

  IF v_queued_count >= v_max_stacked THEN
    RAISE EXCEPTION 'max_stack_reached::%/%', v_queued_count, v_max_stacked;
  END IF;

  -- Stamp is_stacked even on auto-redirected accepts so queue traces match.
  UPDATE public.ride_offers
  SET
    status = 'accepted',
    is_stacked = true,
    responded_at = v_now,
    updated_at = v_now
  WHERE id = p_offer_id;

  WITH revoked AS (
    UPDATE public.ride_offers
    SET status = 'revoked', revoked_reason = 'taken', updated_at = v_now
    WHERE trip_id = v_offer.trip_id
      AND id      <> p_offer_id
      AND status   = 'pending'
    RETURNING driver_id
  )
  SELECT array_agg(driver_id) INTO v_revoked_ids FROM revoked;

  SELECT COALESCE(MAX(stack_position), 0) + 1 INTO v_next_position
  FROM public.trips
  WHERE (driver_id = p_driver_id OR confirmed_driver_id = p_driver_id)
    AND status = 'queued';

  -- Assignment + accepted-offer pointer first (same fields as accept_ride_offer).
  -- Do not activate the trip. Snapshot writes net/commission/wave.
  UPDATE public.trips
  SET
    driver_id              = p_driver_id,
    confirmed_driver_id    = p_driver_id,
    accepted_ride_offer_id = p_offer_id,
    assigned_at            = COALESCE(assigned_at, v_now),
    updated_at             = v_now
  WHERE id = v_offer.trip_id;

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  IF v_rows_updated = 0 THEN
    RAISE EXCEPTION 'queued_trip_assign_failed';
  END IF;

  PERFORM public.snapshot_accepted_wave_commission(v_offer.trip_id, p_offer_id);

  SELECT driver_net_pence INTO v_driver_net
  FROM public.trips
  WHERE id = v_offer.trip_id;

  IF COALESCE(v_driver_net, 0) <= 0 THEN
    RAISE EXCEPTION 'stacked_fare_snapshot_failed::driver_net';
  END IF;

  UPDATE public.trips
  SET
    fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb)
      || jsonb_build_object(
        'accepted_via', 'accept_stacked_ride',
        'accepted_at', v_now,
        'accepted_ride_offer_id', p_offer_id
      ),
    status           = 'queued',
    dispatch_status  = 'stacked_committed',
    stack_position   = v_next_position,
    updated_at       = v_now
  WHERE id = v_offer.trip_id;

  IF v_current_trip.stacked_trip_id IS NULL THEN
    UPDATE public.trips
    SET stacked_trip_id = v_offer.trip_id, updated_at = v_now
    WHERE id = p_current_trip_id;

    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
    IF v_rows_updated = 0 THEN RAISE EXCEPTION 'link_failed'; END IF;
  END IF;

  SELECT c.user_id INTO v_passenger_user_id
  FROM public.trips t
  JOIN public.customers c ON c.id = t.passenger_id
  WHERE t.id = v_offer.trip_id
  LIMIT 1;

  RETURN jsonb_build_object(
    'success',            true,
    'trip_id',            v_offer.trip_id,
    'current_trip_id',    p_current_trip_id,
    'revoked_driver_ids', COALESCE(v_revoked_ids, '{}'),
    'passenger_user_id',  v_passenger_user_id,
    'stack_position',     v_next_position,
    'queued_count',       v_queued_count + 1,
    'max_stacked_rides',  v_max_stacked,
    'driver_net_pence',   v_driver_net
  );
END;
$function$;

-- Promotion: lifecycle + queue only. Never rewrite accepted fare/net/commission.
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

  -- Waiting pence reset is pickup-lifecycle only.
  -- Do not SET driver_net_pence / accepted_ride_offer_id / commission stamps /
  -- final_fare_pence / accepted_dispatch_wave (MK-260817-008).
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
