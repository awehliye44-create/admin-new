-- Stacked accept: consume Admin max_stacked_rides (never hard-code queue=1).
-- Replaces already_has_stacked_trip single-pointer gate with a count vs Admin config.
-- DO NOT APPLY until reviewed — production deploy is a separate step.

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
  v_now                timestamptz := now();
  v_stacked_enabled    boolean := false;
  v_max_stacked        integer := NULL;
  v_queued_count       integer := 0;
  v_revoked_ids        uuid[] := '{}';
  v_passenger_user_id  uuid;
  v_rows_updated       integer;
  v_next_position      integer;
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

  -- Fail closed when Admin max is missing or invalid (never fall back to hard-coded 1).
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

  UPDATE public.ride_offers
  SET status = 'accepted', responded_at = v_now, updated_at = v_now
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

  UPDATE public.trips
  SET
    driver_id           = p_driver_id,
    confirmed_driver_id = p_driver_id,
    status              = 'queued',
    dispatch_status     = 'stacked_committed',
    stack_position      = v_next_position,
    updated_at          = v_now
  WHERE id = v_offer.trip_id;

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  IF v_rows_updated = 0 THEN
    RAISE EXCEPTION 'queued_trip_assign_failed';
  END IF;

  -- Keep stacked_trip_id as the next-to-promote pointer (lowest queue position).
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
    'max_stacked_rides',  v_max_stacked
  );
END;
$function$;
