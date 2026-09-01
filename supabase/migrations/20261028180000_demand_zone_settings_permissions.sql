-- Enforce granular demand-zone action keys on admin_save_demand_zone_settings.

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

  IF NOT public.is_super_admin(v_actor) THEN
    IF _settings ?| ARRAY[
      'heat_map_enabled', 'manual_zones_enabled', 'recompute_interval_minutes',
      'open_trip_max_lifetime_minutes', 'zone_radius_meters', 'consecutive_checks_required',
      'low_min_trips', 'low_max_trips', 'medium_min_trips', 'medium_max_trips', 'high_min_trips'
    ] AND NOT public.staff_has_action(v_actor, 'demand_zones.configure_heatmap') THEN
      RAISE EXCEPTION 'FORBIDDEN_DEMAND_ZONE_HEATMAP';
    END IF;
    IF _settings ?| ARRAY['colour_low', 'colour_medium', 'colour_high']
      AND NOT public.staff_has_action(v_actor, 'demand_zones.configure_colours') THEN
      RAISE EXCEPTION 'FORBIDDEN_DEMAND_ZONE_COLOURS';
    END IF;
    IF _settings ?| ARRAY['surge_enabled', 'multiplier_low', 'multiplier_medium', 'multiplier_high', 'max_multiplier']
      AND NOT public.staff_has_action(v_actor, 'demand_zones.configure_surge') THEN
      RAISE EXCEPTION 'FORBIDDEN_DEMAND_ZONE_SURGE';
    END IF;
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
