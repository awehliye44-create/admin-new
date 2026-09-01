-- Driver demand zone read RPC + per-SA recompute sweep + permission seeds.

-- ─── Driver app: scoped zone list with confirmed levels + SA colours ───

CREATE OR REPLACE FUNCTION public.list_driver_own_demand_zones()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_region_id uuid;
BEGIN
  IF v_driver_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT d.region_id INTO v_region_id
  FROM public.drivers d
  WHERE d.id = v_driver_id;

  RETURN COALESCE((
    SELECT jsonb_agg(row_to_json(z) ORDER BY z.source, z.name)
    FROM (
      SELECT
        dz.id,
        dz.name,
        dz.center_lat,
        dz.center_lng,
        dz.radius_meters,
        COALESCE(dz.confirmed_demand_level, dz.demand_level, 'LOW') AS demand_level,
        dz.source,
        dz.active,
        dz.service_area_id,
        dz.region_id,
        dz.updated_at,
        s.colour_low,
        s.colour_medium,
        s.colour_high
      FROM public.driver_demand_zones dz
      LEFT JOIN public.service_area_demand_zone_settings s
        ON s.service_area_id = dz.service_area_id
      WHERE dz.active = true
        AND (
          (
            dz.service_area_id IS NOT NULL
            AND dz.service_area_id IN (
              SELECT dsa.service_area_id
              FROM public.driver_service_areas dsa
              WHERE dsa.driver_id = v_driver_id
            )
          )
          OR (dz.service_area_id IS NULL AND dz.region_id IS NULL)
          OR (
            dz.service_area_id IS NULL
            AND dz.region_id IS NOT NULL
            AND dz.region_id = v_region_id
          )
        )
        AND (
          (dz.source = 'computed' AND COALESCE(s.heat_map_enabled, true))
          OR (dz.source = 'manual' AND COALESCE(s.manual_zones_enabled, true))
        )
    ) z
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.list_driver_own_demand_zones() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_driver_own_demand_zones() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_driver_own_demand_zones() TO service_role;

-- ─── Cron work gate: any heat-map SA past its recompute interval ───

CREATE OR REPLACE FUNCTION public.compute_driver_demand_zones_sweep_has_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.service_area_demand_zone_settings s
    WHERE s.heat_map_enabled = true
      AND NOT EXISTS (
        SELECT 1
        FROM public.driver_demand_zones z
        WHERE z.service_area_id = s.service_area_id
          AND z.source = 'computed'
          AND z.last_evaluated_at IS NOT NULL
          AND z.last_evaluated_at >= now() - make_interval(mins => s.recompute_interval_minutes)
      )
  );
$$;

REVOKE ALL ON FUNCTION public.compute_driver_demand_zones_sweep_has_work() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_driver_demand_zones_sweep_has_work() TO service_role;

-- ─── Cron sweep → edge function (only when work exists) ───

CREATE OR REPLACE FUNCTION public.compute_driver_demand_zones_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_compute_driver_demand_zones_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/compute-driver-demand-zones'
  );
  v_token text := public.cron_edge_auth_token();
BEGIN
  IF NOT public.compute_driver_demand_zones_sweep_has_work() THEN
    RETURN;
  END IF;

  IF v_url IS NULL OR length(trim(v_url)) < 20 THEN
    RAISE LOG '[demand-zones] sweep aborted reason=bad_url';
    RETURN;
  END IF;

  IF v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[demand-zones] sweep aborted reason=bad_token';
    RETURN;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_token,
        'apikey', v_token
      ),
      body := jsonb_build_object('source', 'pg_cron')
    );
    RAISE LOG '[demand-zones] sweep enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[demand-zones] sweep failed sqlerrm=%', SQLERRM;
  END;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.compute_driver_demand_zones_sweep() TO service_role;

DO $$
BEGIN
  PERFORM cron.unschedule('compute-driver-demand-zones-every-2m');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM cron.unschedule('compute-driver-demand-zones-sweep');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'compute-driver-demand-zones-sweep',
  '* * * * *',
  $$SELECT public.compute_driver_demand_zones_sweep()$$
);

-- ─── Permission seeds for demand zone admin actions ───

INSERT INTO public.role_action_permissions (role, action_key, is_allowed)
SELECT r.role, k.action_key,
       CASE
         WHEN r.role = 'super_admin' THEN true
         WHEN r.role = 'admin' THEN true
         WHEN r.role = 'operator' AND k.action_key IN (
           'demand_zones.view', 'demand_zones.recompute'
         ) THEN true
         ELSE false
       END
FROM (SELECT unnest(enum_range(NULL::public.staff_role)) AS role) r
CROSS JOIN (VALUES
  ('demand_zones.view'),
  ('demand_zones.recompute'),
  ('demand_zones.configure_heatmap'),
  ('demand_zones.configure_colours'),
  ('demand_zones.configure_surge'),
  ('demand_zones.view_audit')
) AS k(action_key)
ON CONFLICT (role, action_key) DO NOTHING;
