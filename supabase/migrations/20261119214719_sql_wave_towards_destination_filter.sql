-- Bug #51: SQL Wave-1 (trip-insert / corporate / emergency dispatch_trip_offers)
-- must honour Towards Destination the same way Edge auto-dispatch does.
-- Otherwise TRIP_ALREADY_OFFERED can leave TD-mismatched SQL offers live.
--
-- Approved matching policy (parity with Edge):
--   - No active unexpired TD → allow
--   - Active TD + invalid trip dropoff → deny (fail-closed)
--   - Active TD + dropoff beyond towards_destination_match_radius_meters → deny
-- Does NOT invent direction/progress rules (trip_qualifies remains unused).

BEGIN;

CREATE OR REPLACE FUNCTION public.towards_destination_sql_wave_allows_driver(
  p_driver_id uuid,
  p_dropoff_lat double precision,
  p_dropoff_lng double precision,
  p_now timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
  v_active boolean;
  v_lat double precision;
  v_lng double precision;
  v_expires timestamptz;
  v_radius integer;
  v_dist numeric;
BEGIN
  IF p_driver_id IS NULL THEN
    RETURN true;
  END IF;

  SELECT ds.towards_destination_active,
         ds.towards_destination_lat,
         ds.towards_destination_lng,
         ds.towards_destination_expires_at
    INTO v_active, v_lat, v_lng, v_expires
  FROM public.driver_settings ds
  WHERE ds.driver_id = p_driver_id;

  -- No settings / inactive → no TD hard-filter.
  IF NOT FOUND OR COALESCE(v_active, false) = false THEN
    RETURN true;
  END IF;

  -- Expired sessions must not filter (Edge buildTowardsDestinationMap parity).
  IF v_expires IS NOT NULL AND v_expires <= p_now THEN
    RETURN true;
  END IF;

  -- Invalid destination coords → treat as inactive (Edge omits from map).
  IF v_lat IS NULL OR v_lng IS NULL
     OR abs(v_lat) > 90 OR abs(v_lng) > 180
     OR (abs(v_lat) < 1e-6 AND abs(v_lng) < 1e-6) THEN
    RETURN true;
  END IF;

  -- Active TD: invalid trip dropoff fail-closed.
  IF p_dropoff_lat IS NULL OR p_dropoff_lng IS NULL
     OR abs(p_dropoff_lat) > 90 OR abs(p_dropoff_lng) > 180
     OR (abs(p_dropoff_lat) < 1e-6 AND abs(p_dropoff_lng) < 1e-6) THEN
    RETURN false;
  END IF;

  SELECT COALESCE(
           g.towards_destination_match_radius_meters,
           g.start_radius_meters,
           13000
         )
    INTO v_radius
  FROM public.global_dispatch_settings g
  WHERE g.singleton IS TRUE
  LIMIT 1;

  v_radius := GREATEST(COALESCE(v_radius, 13000), 1);
  v_dist := public.haversine_meters(p_dropoff_lat, p_dropoff_lng, v_lat, v_lng);
  RETURN v_dist IS NOT NULL AND v_dist <= v_radius;
END;
$$;

COMMENT ON FUNCTION public.towards_destination_sql_wave_allows_driver(uuid, double precision, double precision, timestamptz) IS
  'SQL Wave-1 TD gate — Edge auto-dispatch dropoff-radius parity. Expired/inactive → allow.';

REVOKE ALL ON FUNCTION public.towards_destination_sql_wave_allows_driver(uuid, double precision, double precision, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_sql_wave_allows_driver(uuid, double precision, double precision, timestamptz)
  TO service_role;

-- Patch live dispatch_trip_offers(uuid, text) reject_reason CASE (idempotent).
DO $$
DECLARE
  v_def text;
  v_needle text :=
    'WHEN f.vehicle_category_reject IS NOT NULL THEN f.vehicle_category_reject
      WHEN f.distance_m > v_fleet_max_m THEN ''exceeds_fleet_max_pickup_distance''';
  v_insert text :=
    'WHEN f.vehicle_category_reject IS NOT NULL THEN f.vehicle_category_reject
      WHEN NOT public.towards_destination_sql_wave_allows_driver(
             f.driver_id, v_trip.dropoff_latitude, v_trip.dropoff_longitude, v_now)
        THEN ''towards_destination_mismatch''
      WHEN f.distance_m > v_fleet_max_m THEN ''exceeds_fleet_max_pickup_distance''';
BEGIN
  v_def := pg_get_functiondef('public.dispatch_trip_offers(uuid, text)'::regprocedure);

  IF v_def LIKE '%towards_destination_sql_wave_allows_driver%' THEN
    RAISE NOTICE 'dispatch_trip_offers already includes TD SQL-wave gate';
    RETURN;
  END IF;

  IF position(v_needle in v_def) = 0 THEN
    RAISE EXCEPTION
      'dispatch_trip_offers TD patch failed: reject_reason anchor not found';
  END IF;

  v_def := replace(v_def, v_needle, v_insert);
  EXECUTE v_def;
END $$;

COMMIT;
