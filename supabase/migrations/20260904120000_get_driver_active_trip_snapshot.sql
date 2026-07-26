-- Phase 2: Privacy-safe active-trip (+ queue summary) snapshot for the authenticated driver.
-- Additive; does not alter existing assignment logic.

CREATE OR REPLACE FUNCTION public.get_driver_active_trip_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
  v_active jsonb;
  v_queued jsonb;
  v_server_now timestamptz := now();
BEGIN
  SELECT d.id INTO v_driver_id
  FROM public.drivers d
  WHERE d.user_id = auth.uid()
  LIMIT 1;

  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_not_found' USING ERRCODE = 'P0001';
  END IF;

  SELECT jsonb_build_object(
    'id', t.id,
    'trip_id', t.id,
    'public_trip_id', COALESCE(NULLIF(trim(t.trip_number::text), ''), substring(t.id::text, 1, 8)),
    'status', t.status,
    'dispatch_status', t.dispatch_status,
    'trip_version', t.trip_version,
    'pricing_version', t.pricing_version,
    'fare_revision_number', t.fare_revision_number,
    'driver_id', t.driver_id,
    'confirmed_driver_id', t.confirmed_driver_id,
    'arrived_at', t.arrived_at,
    'pickup_arrived_at', t.pickup_arrived_at,
    'started_at', t.started_at,
    'completed_at', t.completed_at,
    'current_stop_index', t.current_stop_index,
    'pickup_waiting_started_at', t.pickup_waiting_started_at,
    'pickup_paid_waiting_started_at', t.pickup_paid_waiting_started_at,
    'free_wait_expires_at', t.free_wait_expires_at,
    'pickup_address', left(COALESCE(t.pickup_address::text, ''), 160),
    'dropoff_address', left(COALESCE(t.dropoff_address::text, ''), 160),
    'pickup_latitude', t.pickup_latitude,
    'pickup_longitude', t.pickup_longitude,
    'dropoff_latitude', t.dropoff_latitude,
    'dropoff_longitude', t.dropoff_longitude,
    'payment_method', t.payment_method,
    'payment_status', t.payment_status,
    'driver_net_pence', COALESCE(
      NULLIF(t.driver_net_pence, 0),
      NULLIF(t.driver_net_before_tip_pence, 0),
      NULLIF(t.accepted_driver_offer_fare_pence, 0)
    ),
    'currency_code', COALESCE(t.currency_code, t.offer_currency, 'GBP'),
    'stack_position', t.stack_position,
    'is_queued', (t.status = 'queued'),
    'customer_live_location_allowed', (
      t.status IN (
        'accepted', 'confirmed', 'en_route', 'en_route_to_pickup',
        'driver_en_route', 'driver_arriving', 'arrived', 'arrived_at_pickup',
        'at_pickup', 'pickup_waiting', 'waiting', 'driver_arrived'
      )
    )
  )
  INTO v_active
  FROM public.trips t
  WHERE (t.driver_id = v_driver_id OR t.confirmed_driver_id = v_driver_id)
    AND t.status IS DISTINCT FROM 'queued'
    AND t.status NOT IN (
      'completed', 'cancelled', 'canceled', 'customer_cancelled',
      'driver_cancelled', 'no_show', 'expired', 'declined', 'failed'
    )
  ORDER BY t.updated_at DESC NULLS LAST
  LIMIT 1;

  SELECT COALESCE(public.get_driver_queued_trips(), '[]'::jsonb)
  INTO v_queued;

  RETURN jsonb_build_object(
    'server_now', v_server_now,
    'driver_id', v_driver_id,
    'active_trip', v_active,
    'queued_trips', v_queued
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_driver_active_trip_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_active_trip_snapshot() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_active_trip_snapshot() TO service_role;

COMMENT ON FUNCTION public.get_driver_active_trip_snapshot() IS
  'Privacy-safe active trip + queued summary for the authenticated driver. JWT-scoped.';
