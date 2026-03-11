CREATE OR REPLACE FUNCTION public.point_in_polygon(point_lat double precision, point_lng double precision, polygon_geojson jsonb)
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
BEGIN
  -- Handle GeoJSON Polygon format: {type: "Polygon", coordinates: [[[lng,lat], ...]]}
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
    item := coords -> i;
    
    -- Handle both formats:
    -- 1. Array format: [lng, lat]
    -- 2. Object format: {lat: ..., lng: ...}
    IF jsonb_typeof(item) = 'array' THEN
      xi := (item -> 0)::double precision;  -- lng
      yi := (item -> 1)::double precision;  -- lat
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