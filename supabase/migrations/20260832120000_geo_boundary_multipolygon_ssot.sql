-- Allow service_areas / regions geo_boundary to be LatLng[] OR GeoJSON Polygon/MultiPolygon.
-- MultiPolygon is required for islands / disconnected operational zones.
-- point_in_polygon returns true if the point is inside ANY polygon part.

CREATE OR REPLACE FUNCTION public.point_in_polygon(
  point_lat double precision,
  point_lng double precision,
  polygon_geojson jsonb
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
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
  item jsonb;
  geom_type text;
  poly jsonb;
  ring jsonb;
BEGIN
  IF polygon_geojson IS NULL THEN
    RETURN false;
  END IF;

  geom_type := polygon_geojson ->> 'type';

  -- MultiPolygon: true if inside any part
  IF geom_type = 'MultiPolygon' THEN
    FOR poly IN SELECT * FROM jsonb_array_elements(polygon_geojson -> 'coordinates')
    LOOP
      IF public.point_in_polygon(
        point_lat,
        point_lng,
        jsonb_build_object('type', 'Polygon', 'coordinates', poly)
      ) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  END IF;

  -- GeoJSON Polygon: first exterior ring
  IF polygon_geojson ? 'coordinates' THEN
    coords := polygon_geojson -> 'coordinates' -> 0;
  ELSE
    -- Legacy LatLng[] array
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
  inside := false;
  FOR i IN 0..n-1 LOOP
    item := coords -> i;

    IF jsonb_typeof(item) = 'array' THEN
      xi := (item -> 0)::double precision;
      yi := (item -> 1)::double precision;
    ELSIF jsonb_typeof(item) = 'object' THEN
      xi := (item ->> 'lng')::double precision;
      yi := (item ->> 'lat')::double precision;
    ELSE
      CONTINUE;
    END IF;

    item := coords -> j;
    IF jsonb_typeof(item) = 'array' THEN
      xj := (item -> 0)::double precision;
      yj := (item -> 1)::double precision;
    ELSIF jsonb_typeof(item) = 'object' THEN
      xj := (item ->> 'lng')::double precision;
      yj := (item ->> 'lat')::double precision;
    ELSE
      j := i;
      CONTINUE;
    END IF;

    IF ((yi > point_lat) != (yj > point_lat)) AND
       (point_lng < (xj - xi) * (point_lat - yi) / (yj - yi) + xi) THEN
      inside := NOT inside;
    END IF;

    j := i;
  END LOOP;

  RETURN inside;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_service_area_boundary()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_boundary jsonb;
  v_length int;
  v_type text;
  v_ring jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.is_active = false THEN
    RETURN NEW;
  END IF;

  IF NEW.geo_boundary IS NULL THEN
    RAISE EXCEPTION 'Service area must have a polygon boundary. Draw the boundary on the map before saving.';
  END IF;

  v_boundary := NEW.geo_boundary::jsonb;
  v_type := v_boundary ->> 'type';

  IF v_type = 'Polygon' THEN
    v_ring := v_boundary -> 'coordinates' -> 0;
    IF v_ring IS NULL OR jsonb_array_length(v_ring) < 4 THEN
      RAISE EXCEPTION 'Service area GeoJSON Polygon must have a closed ring with at least 3 points.';
    END IF;
    RETURN NEW;
  END IF;

  IF v_type = 'MultiPolygon' THEN
    IF jsonb_array_length(v_boundary -> 'coordinates') < 1 THEN
      RAISE EXCEPTION 'Service area MultiPolygon must contain at least one polygon.';
    END IF;
    RETURN NEW;
  END IF;

  IF jsonb_typeof(v_boundary) != 'array' THEN
    RAISE EXCEPTION 'Service area geo_boundary must be LatLng[] or GeoJSON Polygon/MultiPolygon.';
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
    AND point_in_polygon(p_lat, p_lng, geo_boundary)
  LIMIT 1;

  RETURN v_service_area_id;
END;
$function$;
