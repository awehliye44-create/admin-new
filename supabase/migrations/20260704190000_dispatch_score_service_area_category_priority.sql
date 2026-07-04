-- Dispatch scoring SSOT: category_priority from service_area_driver_tiers per trip SA.

DROP FUNCTION IF EXISTS public.compute_dispatch_score(
  public.dispatch_settings,
  double precision,
  numeric,
  numeric,
  numeric
);

DROP FUNCTION IF EXISTS public.compute_dispatch_score(
  public.dispatch_settings,
  numeric,
  numeric,
  numeric,
  numeric
);

CREATE OR REPLACE FUNCTION public.compute_dispatch_score(
  p_settings public.dispatch_settings,
  p_distance_meters numeric,
  p_category_priority numeric,
  p_idle_minutes numeric,
  p_degraded_penalty numeric DEFAULT 0
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_distance_km numeric;
  v_distance_penalty numeric;
  v_waiting_bonus numeric;
  v_fairness_boost numeric;
BEGIN
  IF p_settings IS NULL THEN
    RETURN COALESCE(p_category_priority, 0) - COALESCE(p_degraded_penalty, 0)
      - GREATEST(COALESCE(p_distance_meters, 0), 0) / 1000.0;
  END IF;

  v_distance_km := GREATEST(COALESCE(p_distance_meters, 0), 0) / 1000.0;
  v_distance_penalty := v_distance_km * COALESCE(p_settings.distance_penalty_per_km, 2.0);
  v_waiting_bonus := LEAST(
    GREATEST(COALESCE(p_idle_minutes, 0), 0),
    COALESCE(p_settings.max_waiting_bonus_minutes, 20)
  ) * COALESCE(p_settings.waiting_bonus_per_minute, 0.5);
  v_fairness_boost := CASE
    WHEN COALESCE(p_idle_minutes, 0) >= COALESCE(p_settings.fairness_idle_minutes, 20)
      THEN COALESCE(p_settings.fairness_boost_score, 10)
    ELSE 0
  END;

  RETURN COALESCE(p_category_priority, 0)
    + v_waiting_bonus
    + v_fairness_boost
    - v_distance_penalty
    - GREATEST(COALESCE(p_degraded_penalty, 0), 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.compute_dispatch_score(
  p_settings public.dispatch_settings,
  p_distance_meters double precision,
  p_category_priority numeric,
  p_idle_minutes numeric,
  p_degraded_penalty numeric DEFAULT 0
)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT public.compute_dispatch_score(
    p_settings,
    p_distance_meters::numeric,
    p_category_priority,
    p_idle_minutes,
    p_degraded_penalty
  );
$$;

GRANT EXECUTE ON FUNCTION public.compute_dispatch_score(
  public.dispatch_settings,
  numeric,
  numeric,
  numeric,
  numeric
) TO service_role;

GRANT EXECUTE ON FUNCTION public.compute_dispatch_score(
  public.dispatch_settings,
  double precision,
  numeric,
  numeric,
  numeric
) TO service_role;

-- Patch dispatch_trip_offers to resolve SA tier priority (not global driver_categories).
DO $patch$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'dispatch_trip_offers'
  LIMIT 1;

  IF v_def IS NULL THEN
    RETURN;
  END IF;

  v_old := $old$
      public.compute_dispatch_score(
        v_settings,
        public.haversine_meters(
          v_trip.pickup_latitude,
          v_trip.pickup_longitude,
          COALESCE(dp.lat, d.current_lat),
          COALESCE(dp.lng, d.current_lng)
        ),
        COALESCE(d.display_rating, d.rating, 4.5),
        COALESCE(
          (
            SELECT COUNT(*) FILTER (WHERE ro2.status = 'accepted')::numeric
              / NULLIF(COUNT(*)::numeric, 0)
            FROM public.ride_offers ro2
            WHERE ro2.driver_id = d.id
              AND ro2.created_at > v_now - interval '30 days'
          ),
          0.5
        ),
        public.driver_idle_minutes(d.last_trip_end_at, d.online_since, d.last_seen_at, v_now)
      )$old$;

  v_new := $new$
      public.compute_dispatch_score(
        v_settings,
        public.haversine_meters(
          v_trip.pickup_latitude,
          v_trip.pickup_longitude,
          COALESCE(dp.lat, d.current_lat),
          COALESCE(dp.lng, d.current_lng)
        ),
        public.resolve_driver_tier_category_priority(d.id, v_trip.service_area_id),
        public.driver_idle_minutes(d.last_trip_end_at, d.online_since, d.last_seen_at, v_now),
        0
      )$new$;

  IF position(v_old in v_def) > 0 THEN
    v_def := replace(v_def, v_old, v_new);
    EXECUTE v_def;
  END IF;
END;
$patch$;

NOTIFY pgrst, 'reload schema';
