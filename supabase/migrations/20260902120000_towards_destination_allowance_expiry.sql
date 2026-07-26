-- Towards Destination allowance / expiry (Gap 2) — local snapshot of live production.
-- Already applied on remote; kept for checkout parity. Idempotent OR REPLACE.
-- Usage policy: consumed on activation/replacement; clear does not restore.
-- ROLLBACK: restore prior get/set/clear bodies from backup.

CREATE OR REPLACE FUNCTION public.towards_destination_resolve_config(p_service_area_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_global public.global_dispatch_settings%ROWTYPE;
  v_sa public.dispatch_settings%ROWTYPE;
  v_enabled boolean := true;
  v_limit integer := 3;
  v_duration integer := 60;
  v_tolerance integer := 3000;
  v_weight numeric := 12;
BEGIN
  SELECT * INTO v_global
  FROM public.global_dispatch_settings
  WHERE singleton IS TRUE
  LIMIT 1;

  IF FOUND THEN
    v_enabled := COALESCE(v_global.towards_destination_enabled, true);
    v_limit := COALESCE(v_global.towards_destination_daily_limit, 3);
    v_duration := COALESCE(v_global.towards_destination_duration_minutes, 60);
    v_tolerance := COALESCE(v_global.towards_destination_matching_tolerance_meters, 3000);
    v_weight := COALESCE(v_global.towards_destination_priority_weight, 12);
  END IF;

  IF p_service_area_id IS NOT NULL THEN
    SELECT * INTO v_sa
    FROM public.dispatch_settings
    WHERE service_area_id = p_service_area_id
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1;

    IF FOUND THEN
      -- Per-SA row may override when columns are present (defaults mirror global).
      v_enabled := COALESCE(v_sa.towards_destination_enabled, v_enabled);
      v_limit := COALESCE(v_sa.towards_destination_daily_limit, v_limit);
      v_duration := COALESCE(v_sa.towards_destination_duration_minutes, v_duration);
      v_tolerance := COALESCE(v_sa.towards_destination_matching_tolerance_meters, v_tolerance);
      v_weight := COALESCE(v_sa.towards_destination_priority_weight, v_weight);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'enabled', v_enabled,
    'daily_limit', v_limit,
    'duration_minutes', v_duration,
    'matching_tolerance_meters', v_tolerance,
    'priority_weight', v_weight
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.towards_destination_business_date(p_driver_id uuid)
 RETURNS date
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tz text;
  v_sa uuid;
BEGIN
  SELECT COALESCE(d.service_area_id, (
    SELECT dsa.service_area_id
    FROM public.driver_service_areas dsa
    WHERE dsa.driver_id = p_driver_id
    ORDER BY dsa.created_at NULLS LAST
    LIMIT 1
  ))
  INTO v_sa
  FROM public.drivers d
  WHERE d.id = p_driver_id;

  IF v_sa IS NOT NULL THEN
    SELECT NULLIF(trim(sa.timezone), '') INTO v_tz
    FROM public.service_areas sa
    WHERE sa.id = v_sa;
  END IF;

  v_tz := COALESCE(v_tz, 'Europe/London');

  RETURN (timezone(v_tz, now()))::date;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_driver_own_towards_destination()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_row public.driver_settings%ROWTYPE;
  v_sa uuid;
  v_cfg jsonb;
  v_biz date;
  v_uses integer;
  v_active boolean;
  v_remaining integer;
BEGIN
  IF auth.uid() IS NULL OR v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT COALESCE(d.service_area_id, (
    SELECT dsa.service_area_id FROM public.driver_service_areas dsa
    WHERE dsa.driver_id = v_driver_id ORDER BY dsa.created_at NULLS LAST LIMIT 1
  ))
  INTO v_sa
  FROM public.drivers d WHERE d.id = v_driver_id;

  v_cfg := public.towards_destination_resolve_config(v_sa);
  v_biz := public.towards_destination_business_date(v_driver_id);

  SELECT * INTO v_row FROM public.driver_settings WHERE driver_id = v_driver_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'active', false,
      'saved_destinations', '[]'::jsonb,
      'uses_today', 0,
      'remaining_uses_today', (v_cfg->>'daily_limit')::integer,
      'daily_limit', (v_cfg->>'daily_limit')::integer,
      'enabled', (v_cfg->>'enabled')::boolean,
      'expires_at', NULL,
      'activated_at', NULL,
      'duration_minutes', (v_cfg->>'duration_minutes')::integer
    );
  END IF;

  -- Business-day reset of uses counter (timezone-safe).
  v_uses := COALESCE(v_row.towards_destination_uses_today, 0);
  IF v_row.towards_destination_last_reset IS DISTINCT FROM v_biz THEN
    v_uses := 0;
    UPDATE public.driver_settings
    SET towards_destination_uses_today = 0,
        towards_destination_last_reset = v_biz
    WHERE driver_id = v_driver_id;
  END IF;

  v_active := COALESCE(v_row.towards_destination_active, false);
  IF v_active AND v_row.towards_destination_expires_at IS NOT NULL
     AND v_row.towards_destination_expires_at <= now() THEN
    v_active := false;
    UPDATE public.driver_settings
    SET towards_destination_active = false
    WHERE driver_id = v_driver_id
      AND towards_destination_active = true;
  END IF;

  v_remaining := GREATEST(((v_cfg->>'daily_limit')::integer) - v_uses, 0);

  RETURN jsonb_build_object(
    'ok', true,
    'active', v_active,
    'address', CASE WHEN v_active THEN v_row.towards_destination_address ELSE NULL END,
    'lat', CASE WHEN v_active THEN v_row.towards_destination_lat ELSE NULL END,
    'lng', CASE WHEN v_active THEN v_row.towards_destination_lng ELSE NULL END,
    'uses_today', v_uses,
    'remaining_uses_today', v_remaining,
    'daily_limit', (v_cfg->>'daily_limit')::integer,
    'enabled', (v_cfg->>'enabled')::boolean,
    'expires_at', CASE WHEN v_active THEN v_row.towards_destination_expires_at ELSE NULL END,
    'activated_at', CASE WHEN v_active THEN v_row.towards_destination_activated_at ELSE NULL END,
    'duration_minutes', (v_cfg->>'duration_minutes')::integer,
    'last_reset', v_biz,
    'saved_destinations', COALESCE(v_row.saved_destinations, '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_driver_own_towards_destination(p_address text, p_lat double precision, p_lng double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_sa uuid;
  v_cfg jsonb;
  v_biz date;
  v_uses integer := 0;
  v_limit integer;
  v_duration integer;
  v_activated_at timestamptz := now();
  v_expires_at timestamptz;
  v_remaining integer;
BEGIN
  IF auth.uid() IS NULL OR v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  IF p_address IS NULL OR length(trim(p_address)) < 3
     OR p_lat IS NULL OR p_lng IS NULL
     OR abs(p_lat) > 90 OR abs(p_lng) > 180
     OR (p_lat = 0 AND p_lng = 0) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_destination');
  END IF;

  SELECT COALESCE(d.service_area_id, (
    SELECT dsa.service_area_id FROM public.driver_service_areas dsa
    WHERE dsa.driver_id = v_driver_id ORDER BY dsa.created_at NULLS LAST LIMIT 1
  ))
  INTO v_sa
  FROM public.drivers d WHERE d.id = v_driver_id;

  v_cfg := public.towards_destination_resolve_config(v_sa);
  IF NOT COALESCE((v_cfg->>'enabled')::boolean, true) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'feature_disabled');
  END IF;

  v_limit := GREATEST(COALESCE((v_cfg->>'daily_limit')::integer, 3), 0);
  v_duration := GREATEST(COALESCE((v_cfg->>'duration_minutes')::integer, 60), 5);
  v_biz := public.towards_destination_business_date(v_driver_id);
  v_expires_at := v_activated_at + make_interval(mins => v_duration);

  SELECT COALESCE(towards_destination_uses_today, 0)
  INTO v_uses
  FROM public.driver_settings
  WHERE driver_id = v_driver_id;

  IF NOT FOUND THEN
    v_uses := 0;
  ELSIF (
    SELECT towards_destination_last_reset
    FROM public.driver_settings
    WHERE driver_id = v_driver_id
  ) IS DISTINCT FROM v_biz THEN
    v_uses := 0;
  END IF;

  IF v_uses >= v_limit THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'daily_limit_reached',
      'uses_today', v_uses,
      'remaining_uses_today', 0,
      'daily_limit', v_limit
    );
  END IF;

  v_uses := v_uses + 1; -- consume on activation / replacement
  v_remaining := GREATEST(v_limit - v_uses, 0);

  INSERT INTO public.driver_settings AS ds (
    driver_id,
    towards_destination_active,
    towards_destination_address,
    towards_destination_lat,
    towards_destination_lng,
    towards_destination_uses_today,
    towards_destination_last_reset,
    towards_destination_activated_at,
    towards_destination_expires_at
  ) VALUES (
    v_driver_id,
    true,
    trim(p_address),
    p_lat,
    p_lng,
    v_uses,
    v_biz,
    v_activated_at,
    v_expires_at
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    towards_destination_active = true,
    towards_destination_address = EXCLUDED.towards_destination_address,
    towards_destination_lat = EXCLUDED.towards_destination_lat,
    towards_destination_lng = EXCLUDED.towards_destination_lng,
    towards_destination_uses_today = EXCLUDED.towards_destination_uses_today,
    towards_destination_last_reset = EXCLUDED.towards_destination_last_reset,
    towards_destination_activated_at = EXCLUDED.towards_destination_activated_at,
    towards_destination_expires_at = EXCLUDED.towards_destination_expires_at;

  RETURN jsonb_build_object(
    'ok', true,
    'active', true,
    'address', trim(p_address),
    'lat', p_lat,
    'lng', p_lng,
    'activated_at', v_activated_at,
    'expires_at', v_expires_at,
    'uses_today', v_uses,
    'remaining_uses_today', v_remaining,
    'daily_limit', v_limit,
    'duration_minutes', v_duration,
    'enabled', true
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.clear_driver_own_towards_destination()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_sa uuid;
  v_cfg jsonb;
  v_uses integer := 0;
  v_biz date;
BEGIN
  IF auth.uid() IS NULL OR v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT COALESCE(d.service_area_id, (
    SELECT dsa.service_area_id FROM public.driver_service_areas dsa
    WHERE dsa.driver_id = v_driver_id ORDER BY dsa.created_at NULLS LAST LIMIT 1
  ))
  INTO v_sa
  FROM public.drivers d WHERE d.id = v_driver_id;

  v_cfg := public.towards_destination_resolve_config(v_sa);
  v_biz := public.towards_destination_business_date(v_driver_id);

  SELECT COALESCE(towards_destination_uses_today, 0) INTO v_uses
  FROM public.driver_settings WHERE driver_id = v_driver_id;

  IF FOUND AND (
    SELECT towards_destination_last_reset FROM public.driver_settings WHERE driver_id = v_driver_id
  ) IS DISTINCT FROM v_biz THEN
    v_uses := 0;
  END IF;

  UPDATE public.driver_settings
  SET towards_destination_active = false,
      towards_destination_address = NULL,
      towards_destination_lat = NULL,
      towards_destination_lng = NULL,
      towards_destination_activated_at = NULL,
      towards_destination_expires_at = NULL
      -- uses_today intentionally preserved (no restore on clear)
  WHERE driver_id = v_driver_id;

  RETURN jsonb_build_object(
    'ok', true,
    'active', false,
    'uses_today', COALESCE(v_uses, 0),
    'remaining_uses_today', GREATEST(((v_cfg->>'daily_limit')::integer) - COALESCE(v_uses, 0), 0),
    'daily_limit', (v_cfg->>'daily_limit')::integer
  );
END;
$function$;
