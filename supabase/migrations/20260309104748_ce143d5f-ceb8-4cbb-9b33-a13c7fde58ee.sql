-- Fix the validation trigger to allow deactivating boundary-less areas
-- and only enforce boundary on INSERT or when activating
CREATE OR REPLACE FUNCTION public.validate_service_area_boundary()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_boundary jsonb;
  v_length int;
BEGIN
  -- On UPDATE: only validate if area is being kept active or activated
  -- Allow deactivation of boundary-less areas
  IF TG_OP = 'UPDATE' AND NEW.is_active = false THEN
    RETURN NEW;
  END IF;

  -- geo_boundary is required for active service areas
  IF NEW.geo_boundary IS NULL THEN
    RAISE EXCEPTION 'Service area must have a polygon boundary. Draw the boundary on the map before saving.';
  END IF;

  v_boundary := NEW.geo_boundary::jsonb;

  IF jsonb_typeof(v_boundary) != 'array' THEN
    RAISE EXCEPTION 'Service area geo_boundary must be an array of coordinate points.';
  END IF;

  v_length := jsonb_array_length(v_boundary);

  IF v_length < 3 THEN
    RAISE EXCEPTION 'Service area polygon must have at least 3 coordinate points. Found: %', v_length;
  END IF;

  IF NOT (v_boundary->0 ? 'lat') OR NOT (v_boundary->0 ? 'lng') THEN
    RAISE EXCEPTION 'Each polygon point must have "lat" and "lng" properties.';
  END IF;

  RETURN NEW;
END;
$function$;

-- Now deactivate boundary-less service areas
UPDATE service_areas
SET is_active = false, updated_at = now()
WHERE geo_boundary IS NULL
  AND is_active = true;

-- Fix find_service_area_by_location: remove fallback
CREATE OR REPLACE FUNCTION public.find_service_area_by_location(p_lat double precision, p_lng double precision)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_service_area_id uuid;
BEGIN
  SELECT id INTO v_service_area_id
  FROM service_areas
  WHERE is_active = true
    AND geo_boundary IS NOT NULL
    AND jsonb_typeof(geo_boundary::jsonb) = 'array'
    AND jsonb_array_length(geo_boundary::jsonb) >= 3
    AND point_in_polygon(p_lat, p_lng, geo_boundary)
  LIMIT 1;

  RETURN v_service_area_id;
END;
$function$;