-- Phase 5: Service-area customer live-location freshness configuration.
-- Default 90s; Driver falls back to the same value when config is unavailable.

ALTER TABLE public.service_areas
  ADD COLUMN IF NOT EXISTS customer_location_stale_after_seconds integer
  NOT NULL
  DEFAULT 90;

ALTER TABLE public.service_areas
  DROP CONSTRAINT IF EXISTS service_areas_customer_location_stale_after_seconds_check;

ALTER TABLE public.service_areas
  ADD CONSTRAINT service_areas_customer_location_stale_after_seconds_check
  CHECK (
    customer_location_stale_after_seconds >= 15
    AND customer_location_stale_after_seconds <= 600
  );

COMMENT ON COLUMN public.service_areas.customer_location_stale_after_seconds IS
  'How long a customer location update remains visible to the assigned driver (seconds).';

-- Extend live-location RPC with authoritative freshness (replace signature).
DROP FUNCTION IF EXISTS public.get_customer_live_for_driver(uuid, double precision, double precision);

CREATE FUNCTION public.get_customer_live_for_driver(
  p_trip_id uuid,
  p_driver_lat double precision,
  p_driver_lng double precision
)
RETURNS TABLE(
  latitude double precision,
  longitude double precision,
  accuracy double precision,
  heading double precision,
  speed double precision,
  updated_at timestamp with time zone,
  is_fresh boolean,
  expires_at timestamp with time zone,
  stale_after_seconds integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    cll.latitude,
    cll.longitude,
    cll.accuracy,
    cll.heading,
    cll.speed,
    cll.updated_at,
    (cll.updated_at + make_interval(secs => COALESCE(sa.customer_location_stale_after_seconds, 90))) > now()
      AS is_fresh,
    (cll.updated_at + make_interval(secs => COALESCE(sa.customer_location_stale_after_seconds, 90)))
      AS expires_at,
    COALESCE(sa.customer_location_stale_after_seconds, 90) AS stale_after_seconds
  FROM public.customer_live_locations cll
  INNER JOIN public.trips t ON t.id = cll.trip_id
  INNER JOIN public.drivers d ON (d.id = t.driver_id OR d.id = t.confirmed_driver_id)
  LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
  WHERE cll.trip_id = p_trip_id
    AND d.user_id = auth.uid()
    AND t.status IN (
      'accepted',
      'confirmed',
      'driver_assigned',
      'en_route',
      'driver_en_route',
      'en_route_to_pickup',
      'enroute_to_pickup',
      'driver_arriving',
      'queued',
      'arrived',
      'arrived_pickup',
      'arrived_at_pickup',
      'at_pickup',
      'pickup_waiting',
      'waiting'
    )
    AND p_driver_lat IS NOT NULL
    AND p_driver_lng IS NOT NULL
    AND t.pickup_latitude IS NOT NULL
    AND t.pickup_longitude IS NOT NULL
    AND public.haversine_meters(
          p_driver_lat, p_driver_lng,
          t.pickup_latitude, t.pickup_longitude
        ) <= 1127
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.get_customer_live_for_driver(uuid, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_live_for_driver(uuid, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_live_for_driver(uuid, double precision, double precision) TO service_role;

COMMENT ON FUNCTION public.get_customer_live_for_driver(uuid, double precision, double precision) IS
  'Assigned-driver customer live location with service-area freshness (is_fresh / expires_at).';
