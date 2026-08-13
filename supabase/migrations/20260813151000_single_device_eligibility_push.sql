-- Single-device: eligibility must require authoritative active push token only.
CREATE OR REPLACE FUNCTION public.dispatchable_reason(p_driver_id uuid, p_max_heartbeat_age_seconds integer DEFAULT 180, p_require_push_token boolean DEFAULT true, p_max_location_age_seconds integer DEFAULT 600)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d_row RECORD;
  dp_row RECORD;
  v_hb_ok BOOLEAN;
  v_loc_ok BOOLEAN;
  v_has_presence BOOLEAN := false;
  v_background_degraded BOOLEAN := false;
  v_intent_active BOOLEAN := false;
  v_has_registered_push_token BOOLEAN := false;
  v_can_deliver_via_foreground_realtime BOOLEAN := false;
BEGIN
  SELECT * INTO d_row FROM public.drivers WHERE id = p_driver_id;
  IF NOT FOUND THEN RETURN 'driver_not_found'; END IF;

  v_intent_active := COALESCE(d_row.driver_online_intent, false);

  IF d_row.driver_status::text <> 'active' THEN RETURN 'driver_status_not_active'; END IF;
  IF d_row.approval_status <> 'approved' THEN RETURN 'not_approved'; END IF;
  IF COALESCE(d_row.documents_approved, FALSE) <> TRUE THEN RETURN 'documents_not_approved'; END IF;
  IF d_row.current_trip_id IS NOT NULL THEN RETURN 'busy_on_trip'; END IF;
  IF COALESCE(d_row.is_online, FALSE) <> TRUE AND NOT v_intent_active THEN RETURN 'driver_offline'; END IF;

  SELECT * INTO dp_row FROM public.driver_presence WHERE driver_id = p_driver_id;
  v_has_presence := FOUND;

  IF v_has_presence THEN
    IF dp_row.status = 'offline' AND NOT v_background_degraded THEN
      RETURN 'driver_offline_explicit';
    END IF;

    IF dp_row.presence_health = 'offline' AND NOT v_background_degraded THEN
      RETURN 'presence_offline_explicit';
    END IF;

    IF dp_row.status NOT IN ('online', 'paused', 'offline') THEN
      RETURN 'presence_not_online';
    END IF;
  ELSIF NOT v_intent_active THEN
    RETURN 'no_presence_row';
  ELSE
    v_background_degraded := true;
  END IF;

  v_hb_ok :=
    v_background_degraded
    OR (
      (v_has_presence AND dp_row.last_heartbeat_at IS NOT NULL
       AND dp_row.last_heartbeat_at > now() - make_interval(secs => p_max_heartbeat_age_seconds))
      OR (d_row.last_seen_at IS NOT NULL
          AND d_row.last_seen_at > now() - make_interval(secs => p_max_heartbeat_age_seconds))
    );

  IF NOT COALESCE(v_hb_ok, false) THEN
    RETURN 'stale_heartbeat';
  END IF;

  IF NOT (
       (v_has_presence AND dp_row.lat IS NOT NULL AND dp_row.lng IS NOT NULL)
    OR (d_row.current_lat IS NOT NULL AND d_row.current_lng IS NOT NULL)
  ) THEN
    RETURN 'no_location';
  END IF;

  v_loc_ok :=
    v_background_degraded
    OR (
      (v_has_presence AND dp_row.last_location_at IS NOT NULL
       AND dp_row.last_location_at > now() - make_interval(secs => p_max_location_age_seconds))
      OR (d_row.last_location_updated_at IS NOT NULL
          AND d_row.last_location_updated_at > now() - make_interval(secs => p_max_location_age_seconds))
    );

  IF NOT COALESCE(v_loc_ok, false) THEN
    RETURN 'stale_location';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.push_tokens pt
    JOIN public.driver_active_devices dad ON dad.driver_id = pt.driver_id
    WHERE pt.driver_id = p_driver_id
      AND pt.app_type = 'driver'
      AND pt.is_active = true
      AND pt.device_id IS NOT DISTINCT FROM dad.device_id
      AND coalesce(length(pt.token), 0) > 0
    LIMIT 1
  ) INTO v_has_registered_push_token;

  v_can_deliver_via_foreground_realtime :=
    v_has_presence
    AND dp_row.status = 'online'
    AND COALESCE(dp_row.app_state, '') = 'foreground'
    AND COALESCE(dp_row.socket_connected, false) = true
    AND COALESCE(v_hb_ok, false);

  IF p_require_push_token AND NOT v_has_registered_push_token AND NOT v_can_deliver_via_foreground_realtime THEN
    RETURN 'no_registered_push_token';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.driver_alerts a
    WHERE a.driver_id = p_driver_id
      AND a.status = 'active'::public.driver_alert_status
      AND a.severity = 'critical'::public.driver_alert_severity
      AND a.alert_type IN ('heartbeat_missing','location_stale','tracking_service_stopped')
  ) THEN
    RETURN 'critical_tracking_alert';
  END IF;

  RETURN 'eligible';
END;
$function$;

CREATE OR REPLACE FUNCTION public.driver_effective_online_reason(p_driver_id uuid, p_max_heartbeat_age_seconds integer DEFAULT 45, p_max_location_age_seconds integer DEFAULT 45, p_max_realtime_age_seconds integer DEFAULT 90, p_require_push_token boolean DEFAULT true)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d_row RECORD;
  dp_row RECORD;
  v_freshness text;
  v_has_registered_push_token boolean;
  v_has_coords boolean;
BEGIN
  SELECT * INTO d_row FROM public.drivers WHERE id = p_driver_id;
  IF NOT FOUND THEN RETURN 'driver_not_found'; END IF;

  SELECT * INTO dp_row FROM public.driver_presence dp WHERE dp.driver_id = p_driver_id;

  IF d_row.driver_status::text <> 'active' THEN RETURN 'driver_status_not_active'; END IF;
  IF d_row.approval_status <> 'approved' THEN RETURN 'not_approved'; END IF;
  IF COALESCE(d_row.documents_approved, FALSE) <> TRUE THEN RETURN 'documents_not_approved'; END IF;

  IF public.is_explicit_offline_reason(dp_row.offline_reason) THEN
    RETURN public.normalize_driver_offline_reason(dp_row.offline_reason);
  END IF;

  IF COALESCE(d_row.driver_online_intent, FALSE) <> TRUE THEN
    RETURN 'driver_offline';
  END IF;

  IF COALESCE(dp_row.status, '') = 'offline'
     OR COALESCE(dp_row.presence_health, '') = 'offline' THEN
    RETURN 'driver_offline';
  END IF;

  v_has_registered_push_token := EXISTS (
    SELECT 1
    FROM public.push_tokens pt
    JOIN public.driver_active_devices dad ON dad.driver_id = pt.driver_id
    WHERE pt.driver_id = p_driver_id
      AND pt.app_type = 'driver'
      AND pt.is_active = true
      AND pt.device_id IS NOT DISTINCT FROM dad.device_id
      AND coalesce(length(pt.token), 0) > 0
    LIMIT 1
  );

  v_has_coords := (
       (dp_row.lat IS NOT NULL AND dp_row.lng IS NOT NULL)
    OR (d_row.current_lat IS NOT NULL AND d_row.current_lng IS NOT NULL)
  );

  v_freshness := public.driver_freshness_reason(
    p_driver_id,
    p_max_heartbeat_age_seconds,
    p_max_location_age_seconds,
    p_max_realtime_age_seconds,
    p_require_push_token
  );

  IF v_freshness = 'fresh' THEN
    IF COALESCE(d_row.is_online, FALSE) = TRUE THEN
      RETURN 'online';
    END IF;
    RETURN 'online_degraded';
  END IF;

  IF v_has_registered_push_token
     AND v_has_coords
     AND v_freshness IN ('stale_heartbeat', 'presence_not_online', 'realtime_unhealthy') THEN
    RETURN 'online_degraded';
  END IF;

  IF COALESCE(d_row.is_online, FALSE) <> TRUE THEN
    RETURN 'driver_offline';
  END IF;

  RETURN v_freshness;
END;
$function$;

CREATE OR REPLACE FUNCTION public.driver_freshness_reason(p_driver_id uuid, p_max_heartbeat_age_seconds integer DEFAULT 45, p_max_location_age_seconds integer DEFAULT 45, p_max_realtime_age_seconds integer DEFAULT 90, p_require_push_token boolean DEFAULT true)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d_row RECORD;
  dp_row RECORD;
  v_hb_ok boolean;
  v_loc_ok boolean;
  v_rt_anchor timestamptz;
BEGIN
  SELECT * INTO d_row FROM public.drivers WHERE id = p_driver_id;
  IF NOT FOUND THEN RETURN 'driver_not_found'; END IF;

  SELECT * INTO dp_row FROM public.driver_presence WHERE driver_id = p_driver_id;
  IF NOT FOUND THEN RETURN 'no_presence_row'; END IF;

  IF COALESCE(dp_row.status, '') NOT IN ('online', 'on_trip') THEN
    RETURN 'presence_not_online';
  END IF;

  v_hb_ok :=
    (dp_row.last_heartbeat_at IS NOT NULL
     AND dp_row.last_heartbeat_at > now() - make_interval(secs => p_max_heartbeat_age_seconds))
    OR (d_row.last_seen_at IS NOT NULL
        AND d_row.last_seen_at > now() - make_interval(secs => p_max_heartbeat_age_seconds));

  IF NOT COALESCE(v_hb_ok, false) THEN
    RETURN 'stale_heartbeat';
  END IF;

  IF NOT (
       (dp_row.lat IS NOT NULL AND dp_row.lng IS NOT NULL)
    OR (d_row.current_lat IS NOT NULL AND d_row.current_lng IS NOT NULL)
  ) THEN
    RETURN 'no_location';
  END IF;

  v_loc_ok :=
    (dp_row.last_location_at IS NOT NULL
     AND dp_row.last_location_at > now() - make_interval(secs => p_max_location_age_seconds))
    OR (d_row.last_location_updated_at IS NOT NULL
        AND d_row.last_location_updated_at > now() - make_interval(secs => p_max_location_age_seconds));

  IF NOT COALESCE(v_loc_ok, false) THEN
    RETURN 'stale_location';
  END IF;

  IF p_require_push_token AND NOT EXISTS (
    SELECT 1
    FROM public.push_tokens pt
    JOIN public.driver_active_devices dad ON dad.driver_id = pt.driver_id
    WHERE pt.driver_id = p_driver_id
      AND pt.app_type = 'driver'
      AND pt.is_active = true
      AND pt.device_id IS NOT DISTINCT FROM dad.device_id
      AND coalesce(length(pt.token), 0) > 0
    LIMIT 1
  ) THEN
    RETURN 'no_registered_push_token';
  END IF;

  IF COALESCE(dp_row.socket_connected, false) <> true THEN
    RETURN 'realtime_unhealthy';
  END IF;

  v_rt_anchor := COALESCE(dp_row.last_socket_pong_at, dp_row.last_realtime_seen_at, dp_row.updated_at);
  IF v_rt_anchor IS NULL
     OR v_rt_anchor <= now() - make_interval(secs => p_max_realtime_age_seconds) THEN
    RETURN 'realtime_unhealthy';
  END IF;

  RETURN 'fresh';
END;
$function$;

CREATE OR REPLACE FUNCTION public.driver_effective_online_snapshot(p_driver_id uuid, p_max_heartbeat_age_seconds integer DEFAULT 45, p_max_location_age_seconds integer DEFAULT 45, p_max_realtime_age_seconds integer DEFAULT 90, p_require_push_token boolean DEFAULT true)
 RETURNS TABLE(driver_id uuid, effective_online boolean, effective_online_reason text, freshness_ok boolean, freshness_reason text, dispatchable boolean, dispatchable_reason text, heartbeat_age_seconds integer, location_age_seconds integer, realtime_age_seconds integer, has_registered_push_token boolean, socket_connected boolean, presence_status text, app_state text, platform text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d_row RECORD;
  dp_row RECORD;
  v_effective_reason text;
  v_freshness_reason text;
  v_dispatch_reason text;
  v_rt_anchor timestamptz;
BEGIN
  SELECT * INTO d_row FROM public.drivers WHERE id = p_driver_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO dp_row FROM public.driver_presence dp WHERE dp.driver_id = p_driver_id;

  v_effective_reason := public.driver_effective_online_reason(
    p_driver_id,
    p_max_heartbeat_age_seconds,
    p_max_location_age_seconds,
    p_max_realtime_age_seconds,
    p_require_push_token
  );

  v_freshness_reason := public.driver_freshness_reason(
    p_driver_id,
    p_max_heartbeat_age_seconds,
    p_max_location_age_seconds,
    p_max_realtime_age_seconds,
    p_require_push_token
  );

  v_dispatch_reason := public.dispatchable_reason(
    p_driver_id,
    p_max_heartbeat_age_seconds,
    p_require_push_token,
    p_max_location_age_seconds
  );

  v_rt_anchor := COALESCE(dp_row.last_socket_pong_at, dp_row.last_realtime_seen_at, dp_row.updated_at);

  RETURN QUERY
  SELECT
    p_driver_id,
    v_effective_reason IN ('online', 'online_degraded'),
    v_effective_reason,
    v_freshness_reason = 'fresh',
    v_freshness_reason,
    v_dispatch_reason IN ('eligible', 'dispatchable_degraded'),
    v_dispatch_reason,
    CASE
      WHEN COALESCE(dp_row.last_heartbeat_at, d_row.last_seen_at) IS NULL THEN NULL
      ELSE GREATEST(0, floor(extract(epoch FROM (now() - COALESCE(dp_row.last_heartbeat_at, d_row.last_seen_at))))::integer)
    END,
    CASE
      WHEN COALESCE(dp_row.last_location_at, d_row.last_location_updated_at) IS NULL THEN NULL
      ELSE GREATEST(0, floor(extract(epoch FROM (now() - COALESCE(dp_row.last_location_at, d_row.last_location_updated_at))))::integer)
    END,
    CASE
      WHEN v_rt_anchor IS NULL THEN NULL
      ELSE GREATEST(0, floor(extract(epoch FROM (now() - v_rt_anchor)))::integer)
    END,
    EXISTS (
    SELECT 1
    FROM public.push_tokens pt
    JOIN public.driver_active_devices dad ON dad.driver_id = pt.driver_id
    WHERE pt.driver_id = p_driver_id
      AND pt.app_type = 'driver'
      AND pt.is_active = true
      AND pt.device_id IS NOT DISTINCT FROM dad.device_id
      AND coalesce(length(pt.token), 0) > 0
    LIMIT 1
  ),
    COALESCE(dp_row.socket_connected, false),
    dp_row.status::text,
    dp_row.app_state::text,
    dp_row.platform::text;
END;
$function$;

