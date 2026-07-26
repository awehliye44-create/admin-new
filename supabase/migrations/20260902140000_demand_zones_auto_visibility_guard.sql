-- Demand zones: keep auto-compute SSOT fresh and block invalid geometry.
-- Does NOT invent demand — only uses existing open-trip compute pipeline.
--
-- ROLLBACK:
--   1) Restore prior compute_driver_demand_zones_sweep_has_work body (open-trips only).
--   2) DROP TRIGGER trg_driver_demand_zones_reject_invalid_geometry ON public.driver_demand_zones;
--   3) DROP FUNCTION public.driver_demand_zone_geometry_is_valid(double precision, double precision, numeric);
--   4) Re-activate manual zones only if intentionally restored by Admin.

-- 1) Geometry guard (shared by trigger + RPC filter)
CREATE OR REPLACE FUNCTION public.driver_demand_zone_geometry_is_valid(
  p_lat double precision,
  p_lng double precision,
  p_radius_meters numeric
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT
    p_lat IS NOT NULL
    AND p_lng IS NOT NULL
    AND p_radius_meters IS NOT NULL
    AND p_radius_meters > 0
    AND abs(p_lat) <= 90
    AND abs(p_lng) <= 180
    AND NOT (p_lat = 0 AND p_lng = 0);
$function$;

COMMENT ON FUNCTION public.driver_demand_zone_geometry_is_valid(double precision, double precision, numeric) IS
  'Rejects null-island (0,0), out-of-range coords, and non-positive radius for demand-zone circles.';

REVOKE ALL ON FUNCTION public.driver_demand_zone_geometry_is_valid(double precision, double precision, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_demand_zone_geometry_is_valid(double precision, double precision, numeric)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.driver_demand_zones_enforce_valid_geometry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.active IS TRUE
     AND NOT public.driver_demand_zone_geometry_is_valid(
       NEW.center_lat::double precision,
       NEW.center_lng::double precision,
       NEW.radius_meters
     )
  THEN
    RAISE EXCEPTION 'invalid_demand_zone_geometry'
      USING ERRCODE = '22023',
            HINT = 'Active demand zones require real coordinates (not 0,0) and radius_meters > 0';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_driver_demand_zones_reject_invalid_geometry ON public.driver_demand_zones;
CREATE TRIGGER trg_driver_demand_zones_reject_invalid_geometry
  BEFORE INSERT OR UPDATE OF center_lat, center_lng, radius_meters, active
  ON public.driver_demand_zones
  FOR EACH ROW
  EXECUTE FUNCTION public.driver_demand_zones_enforce_valid_geometry();

-- 2) Deactivate existing invalid active rows (e.g. null-island manual junk)
UPDATE public.driver_demand_zones z
SET active = false,
    updated_at = now()
WHERE z.active IS TRUE
  AND NOT public.driver_demand_zone_geometry_is_valid(
    z.center_lat::double precision,
    z.center_lng::double precision,
    z.radius_meters
  );

-- 3) Align cron "has work" with edge OPEN_TRIP_STATUSES + clear stale computed zones
--    so auto heatmap stays in sync without Admin clicking Recompute.
CREATE OR REPLACE FUNCTION public.compute_driver_demand_zones_sweep_has_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.trips t
      WHERE t.confirmed_driver_id IS NULL
        AND t.driver_id IS NULL
        AND t.status IN (
          'searching',
          'searching_new_driver',
          'offered',
          'broadcasting',
          'negotiating',
          'offering'
        )
        AND t.created_at >= now() - interval '45 minutes'
        AND t.pickup_latitude IS NOT NULL
        AND t.pickup_longitude IS NOT NULL
      LIMIT 1
    )
    OR EXISTS (
      -- When open demand ends, still invoke edge so it deletes stale computed zones.
      SELECT 1
      FROM public.driver_demand_zones z
      WHERE z.source = 'computed'
        AND z.active IS TRUE
      LIMIT 1
    );
$function$;

COMMENT ON FUNCTION public.compute_driver_demand_zones_sweep_has_work() IS
  'True when open unassigned trips need zoning, or active computed zones must be cleared/refreshed.';

-- 4) Driver RPC: never return invalid geometry (defense in depth; same SSOT)
CREATE OR REPLACE FUNCTION public.list_driver_own_demand_zones()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_region_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  IF v_driver_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT d.region_id INTO v_region_id
  FROM public.drivers d
  WHERE d.id = v_driver_id;

  RETURN COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(row) ORDER BY row.source ASC, row.name ASC)
      FROM (
        SELECT
          z.id,
          z.name,
          z.center_lat,
          z.center_lng,
          z.radius_meters,
          upper(trim(z.demand_level)) AS demand_level,
          z.source,
          z.active,
          z.service_area_id,
          z.region_id,
          z.updated_at
        FROM public.driver_demand_zones z
        WHERE z.active = true
          AND public.driver_demand_zone_geometry_is_valid(
            z.center_lat::double precision,
            z.center_lng::double precision,
            z.radius_meters
          )
          AND (
            z.service_area_id IN (
              SELECT dsa.service_area_id
              FROM public.driver_service_areas dsa
              WHERE dsa.driver_id = v_driver_id
              UNION
              SELECT d.service_area_id
              FROM public.drivers d
              WHERE d.id = v_driver_id
                AND d.service_area_id IS NOT NULL
            )
            OR (
              z.service_area_id IS NULL
              AND (z.region_id IS NULL OR z.region_id IS NOT DISTINCT FROM v_region_id)
            )
          )
        ORDER BY z.source ASC, z.name ASC
        LIMIT 500
      ) row
    ),
    '[]'::jsonb
  );
END;
$function$;

COMMENT ON FUNCTION public.list_driver_own_demand_zones() IS
  'Driver-authorised active demand zones with valid geometry only. Computed by pg_cron + compute-driver-demand-zones.';

REVOKE ALL ON FUNCTION public.list_driver_own_demand_zones() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_driver_own_demand_zones() TO authenticated, service_role;
