-- Smoke expectations for list_driver_own_demand_zones (manual / CI linked run).
-- Not executed by app; documents ownership + no trip leakage.

-- Unauthenticated must fail (run without JWT):
-- SELECT public.list_driver_own_demand_zones();  -- raises not_authenticated

-- Authenticated driver must only receive active rows for own SA / region scope,
-- never trip ids, passenger fields, or inactive zones.
-- SELECT jsonb_object_keys(elem) FROM jsonb_array_elements(public.list_driver_own_demand_zones()) elem;
-- Expected keys subset:
--   id, name, center_lat, center_lng, radius_meters, demand_level, source,
--   active, service_area_id, region_id, updated_at
