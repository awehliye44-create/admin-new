
-- Upsert driver live location RPC (used by edge function)
CREATE OR REPLACE FUNCTION public.upsert_driver_live_location(
  p_driver_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_geohash6 text,
  p_speed real DEFAULT NULL,
  p_heading real DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  INSERT INTO public.driver_live_locations (driver_id, loc, lat, lng, geohash6, speed, heading, updated_at)
  VALUES (
    p_driver_id,
    extensions.ST_MakePoint(p_lng, p_lat)::extensions.geography,
    p_lat, p_lng, p_geohash6, p_speed, p_heading, now()
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    loc = extensions.ST_MakePoint(p_lng, p_lat)::extensions.geography,
    lat = p_lat,
    lng = p_lng,
    geohash6 = p_geohash6,
    speed = COALESCE(p_speed, driver_live_locations.speed),
    heading = COALESCE(p_heading, driver_live_locations.heading),
    updated_at = now();

  -- Sync to drivers table for backwards compat
  UPDATE public.drivers SET
    current_lat = p_lat,
    current_lng = p_lng,
    heading = p_heading,
    speed = p_speed,
    last_location_updated_at = now(),
    updated_at = now()
  WHERE id = p_driver_id;
END;
$$;
