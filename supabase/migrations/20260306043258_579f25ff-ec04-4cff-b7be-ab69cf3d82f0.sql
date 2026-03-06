
-- PostGIS-backed find_nearby_drivers function
CREATE OR REPLACE FUNCTION public.find_nearby_drivers(
  p_lat double precision,
  p_lng double precision,
  p_radius_meters double precision,
  p_limit integer DEFAULT 100,
  p_stale_seconds integer DEFAULT 60
)
RETURNS TABLE (
  driver_id uuid,
  lat double precision,
  lng double precision,
  distance_meters double precision,
  speed real,
  heading real,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dll.driver_id,
    dll.lat,
    dll.lng,
    extensions.ST_Distance(dll.loc, extensions.ST_MakePoint(p_lng, p_lat)::extensions.geography) AS distance_meters,
    dll.speed,
    dll.heading,
    dll.updated_at
  FROM public.driver_live_locations dll
  JOIN public.drivers d ON d.id = dll.driver_id
  WHERE d.is_online = true
    AND d.current_trip_id IS NULL
    AND d.approval_status = 'approved'
    AND d.documents_approved = true
    AND dll.updated_at > now() - make_interval(secs => p_stale_seconds)
    AND extensions.ST_DWithin(dll.loc, extensions.ST_MakePoint(p_lng, p_lat)::extensions.geography, p_radius_meters)
  ORDER BY extensions.ST_Distance(dll.loc, extensions.ST_MakePoint(p_lng, p_lat)::extensions.geography)
  LIMIT p_limit;
END;
$$;
