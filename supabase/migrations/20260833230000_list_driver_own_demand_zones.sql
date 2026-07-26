-- Driver-facing read of Admin demand-zone SSOT (advisory heatmap only).
-- Admin SELECT on driver_demand_zones is admin-only after 20260702100105;
-- this RPC restores authenticated Driver read scoped to assigned areas.
-- Does not change recompute, thresholds, fares, dispatch, or Admin writes.

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

REVOKE ALL ON FUNCTION public.list_driver_own_demand_zones() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_driver_own_demand_zones() TO authenticated;

COMMENT ON FUNCTION public.list_driver_own_demand_zones() IS
  'Authenticated Driver read of active driver_demand_zones for assigned service areas (or unscoped/region-matched). Advisory only — no trip/PII fields.';
