-- Customer map nearby-driver radius is an admin setting, not a client constant.
--
-- Before: passenger_map_nearby_drivers (created outside migrations) passed the
-- caller's p_radius_meters straight to find_nearby_drivers, and the Customer
-- app hard-coded 25_000. Any radius change needed an app release.
--
-- After: global_dispatch_settings.customer_nearby_drivers_radius_meters
-- (Admin → Auto-Dispatch Rules → "Customer Map — Nearby Drivers Radius") is the
-- only radius. p_radius_meters is accepted for older Customer builds but
-- ignored. Freshness (p_stale_seconds), online, approval and frozen-location
-- filters stay in find_nearby_drivers unchanged.
--
-- Columns are now mapped by name. The previous `SELECT *` mapped
-- find_nearby_drivers(heading, speed, distance_meters) positionally onto
-- (distance_meters, speed, heading), so Customer markers were rotated by the
-- distance in meters and distance_meters carried the heading.
--
-- Dispatch wave radii (start/expand/max_radius_meters), stacked search radius
-- and towards-destination matching do not read this column.

ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS customer_nearby_drivers_radius_meters integer NOT NULL DEFAULT 25000;

ALTER TABLE public.global_dispatch_settings
  DROP CONSTRAINT IF EXISTS global_dispatch_settings_customer_nearby_radius_range;
ALTER TABLE public.global_dispatch_settings
  ADD CONSTRAINT global_dispatch_settings_customer_nearby_radius_range
  CHECK (customer_nearby_drivers_radius_meters BETWEEN 1000 AND 100000);

COMMENT ON COLUMN public.global_dispatch_settings.customer_nearby_drivers_radius_meters IS
  'Customer map nearby-driver display radius in meters (1000–100000). Read only by passenger_map_nearby_drivers. Not a dispatch radius.';

CREATE OR REPLACE FUNCTION public.passenger_map_nearby_drivers(
  p_lat double precision,
  p_lng double precision,
  p_radius_meters double precision DEFAULT NULL,
  p_limit integer DEFAULT 24,
  p_stale_seconds integer DEFAULT 45
)
RETURNS TABLE(
  driver_id uuid,
  lat double precision,
  lng double precision,
  distance_meters double precision,
  speed real,
  heading real,
  updated_at timestamp with time zone
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT
    f.driver_id,
    f.lat,
    f.lng,
    f.distance_meters,
    f.speed::real,
    f.heading::real,
    f.updated_at
  FROM public.find_nearby_drivers(
    p_lat,
    p_lng,
    (
      SELECT gds.customer_nearby_drivers_radius_meters::double precision
      FROM public.global_dispatch_settings gds
      WHERE gds.singleton = true
    ),
    p_limit,
    p_stale_seconds
  ) f;
$function$;

REVOKE ALL ON FUNCTION public.passenger_map_nearby_drivers(double precision, double precision, double precision, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.passenger_map_nearby_drivers(double precision, double precision, double precision, integer, integer) TO authenticated, service_role;
