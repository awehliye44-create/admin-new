-- ─────────────────────────────────────────────────────────────
-- Migration B: demand zone settings save RPC + zone surge resolution
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.demand_zone_distance_meters(
  _lat1 double precision, _lng1 double precision,
  _lat2 double precision, _lng2 double precision
)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT 2 * 6371000 * asin(
    least(1, sqrt(
      power(sin(radians(_lat2 - _lat1) / 2), 2)
      + cos(radians(_lat1)) * cos(radians(_lat2))
      * power(sin(radians(_lng2 - _lng1) / 2), 2)
    ))
  );
$$;

-- ─── Admin save (validates + audits) ───

CREATE OR REPLACE FUNCTION public.admin_save_demand_zone_settings(
  _service_area_id uuid,
  _settings jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_existing public.service_area_demand_zone_settings%ROWTYPE;
  v_new public.service_area_demand_zone_settings%ROWTYPE;
  v_key text;
  v_old jsonb;
  v_after jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  IF NOT public.has_role(v_actor, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'FORBIDDEN_NOT_ADMIN';
  END IF;

  IF _service_area_id IS NULL THEN
    RAISE EXCEPTION 'SERVICE_AREA_REQUIRED';
  END IF;

  SELECT * INTO v_existing
  FROM public.service_area_demand_zone_settings
  WHERE service_area_id = _service_area_id;

  IF NOT FOUND THEN
    INSERT INTO public.service_area_demand_zone_settings (service_area_id)
    VALUES (_service_area_id)
    RETURNING * INTO v_existing;
  END IF;

  UPDATE public.service_area_demand_zone_settings s SET
    heat_map_enabled = COALESCE((_settings->>'heat_map_enabled')::boolean, s.heat_map_enabled),
    recompute_interval_minutes = COALESCE((_settings->>'recompute_interval_minutes')::integer, s.recompute_interval_minutes),
    open_trip_max_lifetime_minutes = COALESCE((_settings->>'open_trip_max_lifetime_minutes')::integer, s.open_trip_max_lifetime_minutes),
    zone_radius_meters = COALESCE((_settings->>'zone_radius_meters')::integer, s.zone_radius_meters),
    manual_zones_enabled = COALESCE((_settings->>'manual_zones_enabled')::boolean, s.manual_zones_enabled),
    low_min_trips = COALESCE((_settings->>'low_min_trips')::integer, s.low_min_trips),
    low_max_trips = COALESCE((_settings->>'low_max_trips')::integer, s.low_max_trips),
    medium_min_trips = COALESCE((_settings->>'medium_min_trips')::integer, s.medium_min_trips),
    medium_max_trips = COALESCE((_settings->>'medium_max_trips')::integer, s.medium_max_trips),
    high_min_trips = COALESCE((_settings->>'high_min_trips')::integer, s.high_min_trips),
    consecutive_checks_required = COALESCE((_settings->>'consecutive_checks_required')::integer, s.consecutive_checks_required),
    colour_low = COALESCE(upper(_settings->>'colour_low'), s.colour_low),
    colour_medium = COALESCE(upper(_settings->>'colour_medium'), s.colour_medium),
    colour_high = COALESCE(upper(_settings->>'colour_high'), s.colour_high),
    surge_enabled = COALESCE((_settings->>'surge_enabled')::boolean, s.surge_enabled),
    multiplier_low = COALESCE((_settings->>'multiplier_low')::numeric, s.multiplier_low),
    multiplier_medium = CASE WHEN _settings ? 'multiplier_medium'
      THEN NULLIF(_settings->>'multiplier_medium','')::numeric ELSE s.multiplier_medium END,
    multiplier_high = CASE WHEN _settings ? 'multiplier_high'
      THEN NULLIF(_settings->>'multiplier_high','')::numeric ELSE s.multiplier_high END,
    max_multiplier = COALESCE((_settings->>'max_multiplier')::numeric, s.max_multiplier),
    updated_by = v_actor,
    updated_at = now()
  WHERE s.service_area_id = _service_area_id
  RETURNING * INTO v_new;

  v_old := to_jsonb(v_existing);
  v_after := to_jsonb(v_new);

  FOR v_key IN
    SELECT jsonb_object_keys(v_after)
  LOOP
    IF v_key NOT IN ('id','service_area_id','created_at','updated_at','updated_by')
       AND (v_old->v_key) IS DISTINCT FROM (v_after->v_key) THEN
      INSERT INTO public.demand_zone_audit_log
        (service_area_id, actor_id, action, field_key, old_value, new_value)
      VALUES
        (_service_area_id, v_actor, 'settings_update', v_key, v_old->v_key, v_after->v_key);
    END IF;
  END LOOP;

  RETURN v_after;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_save_demand_zone_settings(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_save_demand_zone_settings(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_demand_zone_settings(uuid, jsonb) TO service_role;

-- ─── Zone-based surge resolution (backend pricing only) ───

CREATE OR REPLACE FUNCTION public.resolve_zone_surge(
  _service_area_id uuid,
  _pickup_lat double precision,
  _pickup_lng double precision
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_settings public.service_area_demand_zone_settings%ROWTYPE;
  v_zone public.driver_demand_zones%ROWTYPE;
  v_multiplier numeric(4,2) := 1.00;
  v_level text;
BEGIN
  IF _service_area_id IS NULL OR _pickup_lat IS NULL OR _pickup_lng IS NULL THEN
    RETURN jsonb_build_object(
      'zone_id', NULL, 'confirmed_demand_level', NULL,
      'applied_multiplier', 1.00, 'surge_enabled', false, 'reason', 'NO_SETTINGS');
  END IF;

  SELECT * INTO v_settings
  FROM public.service_area_demand_zone_settings
  WHERE service_area_id = _service_area_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'zone_id', NULL, 'confirmed_demand_level', NULL,
      'applied_multiplier', 1.00, 'surge_enabled', false, 'reason', 'NO_SETTINGS');
  END IF;

  SELECT z.* INTO v_zone
  FROM public.driver_demand_zones z
  WHERE z.service_area_id = _service_area_id
    AND z.active = true
    AND z.source = 'computed'
    AND public.demand_zone_distance_meters(_pickup_lat, _pickup_lng, z.center_lat, z.center_lng) <= z.radius_meters
  ORDER BY public.demand_zone_distance_meters(_pickup_lat, _pickup_lng, z.center_lat, z.center_lng) ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'zone_id', NULL, 'confirmed_demand_level', NULL,
      'applied_multiplier', 1.00, 'surge_enabled', v_settings.surge_enabled, 'reason', 'NO_ZONE');
  END IF;

  v_level := COALESCE(v_zone.confirmed_demand_level, v_zone.demand_level, 'LOW');

  IF NOT v_settings.surge_enabled THEN
    RETURN jsonb_build_object(
      'zone_id', v_zone.id, 'confirmed_demand_level', v_level,
      'applied_multiplier', 1.00, 'surge_enabled', false, 'reason', 'SURGE_DISABLED');
  END IF;

  v_multiplier := CASE v_level
    WHEN 'HIGH' THEN COALESCE(v_settings.multiplier_high, 1.00)
    WHEN 'MEDIUM' THEN COALESCE(v_settings.multiplier_medium, 1.00)
    ELSE COALESCE(v_settings.multiplier_low, 1.00)
  END;

  IF v_multiplier < 1.00 THEN v_multiplier := 1.00; END IF;
  IF v_multiplier > v_settings.max_multiplier THEN v_multiplier := v_settings.max_multiplier; END IF;

  RETURN jsonb_build_object(
    'zone_id', v_zone.id, 'confirmed_demand_level', v_level,
    'applied_multiplier', v_multiplier, 'surge_enabled', true, 'reason', 'ZONE_MULTIPLIER');
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_zone_surge(uuid, double precision, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_zone_surge(uuid, double precision, double precision) TO service_role;

-- ─── Audit helper for recompute activity ───

CREATE OR REPLACE FUNCTION public.log_demand_zone_event(
  _service_area_id uuid,
  _zone_id uuid,
  _action text,
  _old_value jsonb DEFAULT NULL,
  _new_value jsonb DEFAULT NULL,
  _reason text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.demand_zone_audit_log
    (service_area_id, zone_id, actor_id, actor_role, action, old_value, new_value, reason)
  VALUES
    (_service_area_id, _zone_id, auth.uid(),
     CASE WHEN auth.uid() IS NULL THEN 'system' ELSE 'admin' END,
     _action, _old_value, _new_value, _reason);
$$;

REVOKE ALL ON FUNCTION public.log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text) TO service_role;