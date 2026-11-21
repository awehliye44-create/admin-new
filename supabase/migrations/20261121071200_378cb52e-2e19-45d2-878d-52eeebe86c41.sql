-- Re-apply Bug #51 TD gate to dispatch_trip_offers(uuid, text).
-- 20270227140000 replaced the full body without the towards_destination branch.
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
    RAISE EXCEPTION 'dispatch_trip_offers TD re-patch failed: reject_reason anchor not found';
  END IF;

  EXECUTE replace(v_def, v_needle, v_insert);
END $$;