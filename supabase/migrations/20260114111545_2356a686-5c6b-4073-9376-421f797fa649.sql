-- Add new columns to custom_zones for enhanced zone functionality
ALTER TABLE public.custom_zones
ADD COLUMN IF NOT EXISTS shape_type text NOT NULL DEFAULT 'polygon' CHECK (shape_type IN ('polygon', 'circle')),
ADD COLUMN IF NOT EXISTS center_lat double precision,
ADD COLUMN IF NOT EXISTS center_lng double precision,
ADD COLUMN IF NOT EXISTS radius_meters double precision,
ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- Add comment explaining the structure
COMMENT ON COLUMN public.custom_zones.zone_type IS 'PRICING for pricing modifiers, GEOFENCE for enter/exit triggers';
COMMENT ON COLUMN public.custom_zones.shape_type IS 'polygon or circle';
COMMENT ON COLUMN public.custom_zones.metadata IS 'JSON containing zone-specific rules like pickup_fee, dropoff_fee, surge_multiplier, trigger_on_enter, trigger_on_exit, etc.';

-- Create index for efficient zone lookups
CREATE INDEX IF NOT EXISTS idx_custom_zones_region_active ON public.custom_zones(region_id, is_active);
CREATE INDEX IF NOT EXISTS idx_custom_zones_type ON public.custom_zones(zone_type);

-- Add pickup_zone_id and dropoff_zone_id to trips table for zone tracking
ALTER TABLE public.trips
ADD COLUMN IF NOT EXISTS pickup_zone_id uuid REFERENCES public.custom_zones(id),
ADD COLUMN IF NOT EXISTS dropoff_zone_id uuid REFERENCES public.custom_zones(id),
ADD COLUMN IF NOT EXISTS service_area_id uuid REFERENCES public.service_areas(id);

-- Create geofence_events table for tracking driver enter/exit events
CREATE TABLE IF NOT EXISTS public.geofence_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  zone_id uuid NOT NULL REFERENCES public.custom_zones(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('enter', 'exit')),
  trip_id uuid REFERENCES public.trips(id),
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS on geofence_events
ALTER TABLE public.geofence_events ENABLE ROW LEVEL SECURITY;

-- RLS policies for geofence_events
CREATE POLICY "Admins can view all geofence events"
ON public.geofence_events
FOR SELECT
TO authenticated
USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can insert geofence events"
ON public.geofence_events
FOR INSERT
TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Service role can manage geofence events (for edge functions)
CREATE POLICY "Service role can manage geofence events"
ON public.geofence_events
FOR ALL
USING (auth.jwt() ->> 'role' = 'service_role');

-- Create indexes for geofence_events
CREATE INDEX IF NOT EXISTS idx_geofence_events_driver ON public.geofence_events(driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_geofence_events_zone ON public.geofence_events(zone_id, created_at DESC);

-- Function to check if a point is inside a polygon (for zone resolution)
CREATE OR REPLACE FUNCTION public.point_in_polygon(
  point_lat double precision,
  point_lng double precision,
  polygon_geojson jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  coords jsonb;
  n int;
  i int;
  j int;
  xi double precision;
  yi double precision;
  xj double precision;
  yj double precision;
  inside boolean := false;
BEGIN
  -- Handle both GeoJSON Polygon and simple coordinate array
  IF polygon_geojson ? 'coordinates' THEN
    coords := polygon_geojson -> 'coordinates' -> 0;
  ELSE
    coords := polygon_geojson;
  END IF;
  
  IF coords IS NULL THEN
    RETURN false;
  END IF;
  
  n := jsonb_array_length(coords);
  IF n < 3 THEN
    RETURN false;
  END IF;
  
  j := n - 1;
  FOR i IN 0..n-1 LOOP
    xi := (coords -> i -> 0)::double precision;
    yi := (coords -> i -> 1)::double precision;
    xj := (coords -> j -> 0)::double precision;
    yj := (coords -> j -> 1)::double precision;
    
    IF ((yi > point_lat) != (yj > point_lat)) AND
       (point_lng < (xj - xi) * (point_lat - yi) / (yj - yi) + xi) THEN
      inside := NOT inside;
    END IF;
    
    j := i;
  END LOOP;
  
  RETURN inside;
END;
$$;

-- Function to check if a point is inside a circle
CREATE OR REPLACE FUNCTION public.point_in_circle(
  point_lat double precision,
  point_lng double precision,
  center_lat double precision,
  center_lng double precision,
  radius_meters double precision
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  distance_meters double precision;
  lat1_rad double precision;
  lat2_rad double precision;
  delta_lat double precision;
  delta_lng double precision;
  a double precision;
  c double precision;
BEGIN
  -- Haversine formula
  lat1_rad := radians(point_lat);
  lat2_rad := radians(center_lat);
  delta_lat := radians(center_lat - point_lat);
  delta_lng := radians(center_lng - point_lng);
  
  a := sin(delta_lat/2) * sin(delta_lat/2) +
       cos(lat1_rad) * cos(lat2_rad) *
       sin(delta_lng/2) * sin(delta_lng/2);
  c := 2 * atan2(sqrt(a), sqrt(1-a));
  
  distance_meters := 6371000 * c; -- Earth radius in meters
  
  RETURN distance_meters <= radius_meters;
END;
$$;

-- Function to resolve zones for a given point
CREATE OR REPLACE FUNCTION public.resolve_zone(
  point_lat double precision,
  point_lng double precision,
  p_region_id uuid,
  p_zone_type text DEFAULT NULL
)
RETURNS TABLE(
  zone_id uuid,
  zone_name text,
  zone_type text,
  priority int,
  metadata jsonb
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    cz.id,
    cz.name,
    cz.zone_type,
    COALESCE(cz.priority, 0),
    cz.metadata
  FROM public.custom_zones cz
  WHERE cz.region_id = p_region_id
    AND cz.is_active = true
    AND (p_zone_type IS NULL OR cz.zone_type = p_zone_type)
    AND (
      (cz.shape_type = 'polygon' AND public.point_in_polygon(point_lat, point_lng, cz.geo_boundary))
      OR
      (cz.shape_type = 'circle' AND public.point_in_circle(point_lat, point_lng, cz.center_lat, cz.center_lng, cz.radius_meters))
    )
  ORDER BY COALESCE(cz.priority, 0) DESC
  LIMIT 1;
END;
$$;