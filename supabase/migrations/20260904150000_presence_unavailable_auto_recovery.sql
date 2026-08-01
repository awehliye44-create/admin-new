-- Presence-unavailable auto-recovery SSOT hardening.
-- Stale heartbeat may set effective is_online=false (audit reason presence_unavailable)
-- but MUST NEVER clear driver_online_intent, trip ids, stacked trips, or auth session.
-- Fresh valid heartbeat + intent + eligible restores effective online without Go Online.

BEGIN;

-- ---------------------------------------------------------------------------
-- Heartbeat: refresh presence health + effective online; never touch intent.
-- Signature must match existing upsert_driver_presence overload exactly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_driver_presence(
  p_driver_id uuid,
  p_status text DEFAULT NULL::text,
  p_lat double precision DEFAULT NULL::double precision,
  p_lng double precision DEFAULT NULL::double precision,
  p_heading double precision DEFAULT NULL::double precision,
  p_speed double precision DEFAULT NULL::double precision,
  p_app_state text DEFAULT NULL::text,
  p_platform text DEFAULT NULL::text,
  p_push_token text DEFAULT NULL::text,
  p_device_id text DEFAULT NULL::text,
  p_accuracy double precision DEFAULT NULL::double precision,
  p_battery_level smallint DEFAULT NULL::smallint,
  p_socket_connected boolean DEFAULT NULL::boolean,
  p_unresolved_critical_tracking boolean DEFAULT NULL::boolean,
  p_network_type text DEFAULT NULL::text,
  p_offline_reason text DEFAULT NULL::text
)
RETURNS driver_presence
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_result public.driver_presence;
  v_driver public.drivers%ROWTYPE;
  v_prev_hb timestamptz;
  v_gap_s integer;
  v_low_accuracy boolean;
  v_active_device text;
  v_effective_online boolean;
  v_eligible jsonb;
  v_next_status text;
BEGIN
  IF p_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_id required';
  END IF;

  SELECT * INTO v_driver FROM public.drivers WHERE id = p_driver_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DRIVER_NOT_FOUND';
  END IF;

  -- Ownership: caller must own the driver (or service_role/admin).
  IF auth.role() <> 'service_role'
     AND auth.uid() IS DISTINCT FROM v_driver.user_id
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles p
       WHERE p.user_id = auth.uid() AND p.role = 'admin'
     )
  THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED'
      USING ERRCODE = 'P0001';
  END IF;

  -- Reject legacy intent-changing status transitions via upsert.
  IF p_status = 'offline' AND public.is_explicit_offline_reason(p_offline_reason) THEN
    RAISE EXCEPTION 'USE_DRIVER_REQUEST_GO_OFFLINE: call driver_request_go_offline instead'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_status IN ('online', 'on_trip')
     AND COALESCE(v_driver.driver_online_intent, false) <> true
  THEN
    RAISE EXCEPTION 'USE_DRIVER_REQUEST_GO_ONLINE: call driver_request_go_online instead'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT dp.last_heartbeat_at INTO v_prev_hb
  FROM public.driver_presence dp
  WHERE dp.driver_id = p_driver_id;

  IF v_prev_hb IS NOT NULL THEN
    v_gap_s := GREATEST(0, floor(extract(epoch FROM (now() - v_prev_hb)))::integer);
    IF v_gap_s < 2 AND COALESCE(p_status, '') <> 'offline' THEN
      SELECT * INTO v_result FROM public.driver_presence WHERE driver_id = p_driver_id;
      IF FOUND THEN
        RETURN v_result;
      END IF;
    END IF;
  END IF;

  IF p_device_id IS NOT NULL THEN
    SELECT device_id INTO v_active_device
    FROM public.driver_active_devices
    WHERE driver_id = p_driver_id;
    IF v_active_device IS NOT NULL AND v_active_device <> p_device_id THEN
      RAISE EXCEPTION 'STALE_DEVICE: device % is not the active device for driver %',
        p_device_id, p_driver_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_low_accuracy := (p_accuracy IS NOT NULL AND p_accuracy > 50);

  v_next_status := COALESCE(
    p_status,
    CASE
      WHEN COALESCE(v_driver.driver_online_intent, false) THEN 'online'
      ELSE 'offline'
    END
  );

  INSERT INTO public.driver_presence (
    driver_id, status, last_heartbeat_at,
    lat, lng, heading, speed, last_location_at,
    app_state, platform, push_token,
    accuracy_m, battery_level, low_accuracy,
    socket_connected, unresolved_critical_tracking,
    last_socket_pong_at, network_type,
    presence_health, offline_reason, updated_at
  ) VALUES (
    p_driver_id,
    v_next_status,
    now(),
    p_lat, p_lng, p_heading, p_speed,
    CASE WHEN p_lat IS NOT NULL THEN now() ELSE NULL END,
    COALESCE(p_app_state, 'foreground'),
    p_platform,
    p_push_token,
    p_accuracy, p_battery_level, v_low_accuracy,
    p_socket_connected,
    COALESCE(p_unresolved_critical_tracking, false),
    CASE WHEN COALESCE(p_socket_connected, false) THEN now() ELSE NULL END,
    NULLIF(trim(COALESCE(p_network_type, '')), ''),
    CASE
      WHEN COALESCE(v_driver.driver_online_intent, false)
           AND v_next_status IN ('online', 'on_trip', 'paused')
        THEN 'healthy'
      ELSE 'offline'
    END,
    CASE
      WHEN public.is_explicit_offline_reason(p_offline_reason) THEN p_offline_reason
      ELSE NULL
    END,
    now()
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    status = CASE
      WHEN p_status IS NOT NULL THEN p_status
      WHEN COALESCE(v_driver.driver_online_intent, false) THEN
        CASE
          WHEN public.driver_presence.status IN ('online', 'on_trip', 'paused')
            THEN public.driver_presence.status
          ELSE 'online'
        END
      ELSE public.driver_presence.status
    END,
    last_heartbeat_at = now(),
    lat = COALESCE(p_lat, public.driver_presence.lat),
    lng = COALESCE(p_lng, public.driver_presence.lng),
    heading = COALESCE(p_heading, public.driver_presence.heading),
    speed = COALESCE(p_speed, public.driver_presence.speed),
    last_location_at = CASE WHEN p_lat IS NOT NULL THEN now() ELSE public.driver_presence.last_location_at END,
    app_state = COALESCE(p_app_state, public.driver_presence.app_state),
    platform = COALESCE(p_platform, public.driver_presence.platform),
    push_token = COALESCE(p_push_token, public.driver_presence.push_token),
    accuracy_m = COALESCE(p_accuracy, public.driver_presence.accuracy_m),
    battery_level = COALESCE(p_battery_level, public.driver_presence.battery_level),
    low_accuracy = CASE WHEN p_accuracy IS NOT NULL THEN v_low_accuracy ELSE public.driver_presence.low_accuracy END,
    socket_connected = COALESCE(p_socket_connected, public.driver_presence.socket_connected),
    unresolved_critical_tracking = COALESCE(p_unresolved_critical_tracking, public.driver_presence.unresolved_critical_tracking),
    last_socket_pong_at = CASE
      WHEN COALESCE(p_socket_connected, false) THEN now()
      ELSE public.driver_presence.last_socket_pong_at
    END,
    network_type = CASE
      WHEN p_network_type IS NOT NULL AND trim(p_network_type) <> '' THEN trim(p_network_type)
      ELSE public.driver_presence.network_type
    END,
    -- Auto-recovery: fresh HB with intent restores healthy presence (not Go Online).
    presence_health = CASE
      WHEN COALESCE(v_driver.driver_online_intent, false) THEN 'healthy'
      ELSE COALESCE(public.driver_presence.presence_health, 'offline')
    END,
    offline_reason = CASE
      WHEN public.is_explicit_offline_reason(p_offline_reason) THEN p_offline_reason
      WHEN COALESCE(v_driver.driver_online_intent, false)
           AND NOT public.is_explicit_offline_reason(public.driver_presence.offline_reason)
        THEN NULL
      ELSE public.driver_presence.offline_reason
    END,
    updated_at = now()
  RETURNING * INTO v_result;

  -- Effective availability: intent + eligibility + presence status. Never touch intent here.
  v_eligible := public.assert_driver_presence_online_eligible(p_driver_id);
  v_effective_online :=
    COALESCE(v_driver.driver_online_intent, false)
    AND COALESCE((v_eligible ->> 'eligible')::boolean, false)
    AND v_result.status IN ('online', 'on_trip', 'paused');

  PERFORM public.allow_driver_availability_write();
  UPDATE public.drivers SET
    is_online = v_effective_online,
    current_lat = COALESCE(p_lat, current_lat),
    current_lng = COALESCE(p_lng, current_lng),
    heading = COALESCE(p_heading, heading),
    speed = COALESCE(p_speed, speed),
    last_location_updated_at = CASE WHEN p_lat IS NOT NULL THEN now() ELSE last_location_updated_at END,
    last_seen_at = now(),
    updated_at = now()
  WHERE id = p_driver_id;
  -- Intentionally does not write: driver_online_intent, current_trip_id,
  -- online_since, auth session, or stacked-trip queues.

  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Cron: derive effective availability; NEVER clear driver_online_intent
-- Stale HB → is_online=false (presence_unavailable audit); keep trips/intent.
-- Fresh HB + intent + eligible → repair presence + restore is_online.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_stale_drivers(p_ttl_seconds integer DEFAULT 60)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_repaired integer := 0;
  v_repaired_online integer := 0;
  v_degraded integer := 0;
  v_offline integer := 0;
  v_unavailable integer := 0;
  v_ineligible integer := 0;
  v_ttl_s integer := GREATEST(p_ttl_seconds, 45);
BEGIN
  PERFORM public.allow_driver_availability_write();

  -- 1a) REPAIR presence: intent=true + eligible + fresh HB → healthy/online
  UPDATE public.driver_presence dp
  SET status = 'online',
      presence_health = 'healthy',
      offline_reason = CASE
        WHEN public.is_explicit_offline_reason(dp.offline_reason) THEN dp.offline_reason
        ELSE NULL
      END,
      updated_at = now()
  FROM public.drivers d
  WHERE d.id = dp.driver_id
    AND COALESCE(d.driver_online_intent, false) = true
    AND COALESCE((public.assert_driver_presence_online_eligible(d.id) ->> 'eligible')::boolean, false) = true
    AND NOT public.is_explicit_offline_reason(dp.offline_reason)
    AND dp.last_heartbeat_at IS NOT NULL
    AND dp.last_heartbeat_at > now() - make_interval(secs => v_ttl_s)
    AND (
      dp.status IS DISTINCT FROM 'online'
      OR (dp.offline_reason IS NOT NULL AND NOT public.is_explicit_offline_reason(dp.offline_reason))
      OR dp.presence_health IS DISTINCT FROM 'healthy'
    );
  GET DIAGNOSTICS v_repaired = ROW_COUNT;

  -- 1b) REPAIR effective online: same gate → is_online=true (no Go Online required)
  UPDATE public.drivers d
  SET is_online = true,
      updated_at = now()
  FROM public.driver_presence dp
  WHERE d.id = dp.driver_id
    AND COALESCE(d.driver_online_intent, false) = true
    AND COALESCE((public.assert_driver_presence_online_eligible(d.id) ->> 'eligible')::boolean, false) = true
    AND NOT public.is_explicit_offline_reason(dp.offline_reason)
    AND dp.last_heartbeat_at IS NOT NULL
    AND dp.last_heartbeat_at > now() - make_interval(secs => v_ttl_s)
    AND dp.status IN ('online', 'on_trip', 'paused')
    AND d.is_online IS DISTINCT FROM true;
  GET DIAGNOSTICS v_repaired_online = ROW_COUNT;

  -- 2) STALE presence: intent=true, HB past TTL → degraded health (not manual offline)
  UPDATE public.driver_presence dp
  SET presence_health = 'degraded',
      updated_at = now()
  FROM public.drivers d
  WHERE d.id = dp.driver_id
    AND COALESCE(d.driver_online_intent, false) = true
    AND dp.last_heartbeat_at IS NOT NULL
    AND dp.last_heartbeat_at <= now() - make_interval(secs => v_ttl_s)
    AND NOT public.is_explicit_offline_reason(dp.offline_reason)
    AND dp.presence_health IS DISTINCT FROM 'degraded';
  GET DIAGNOSTICS v_degraded = ROW_COUNT;

  -- 3) STALE effective availability: is_online=false, KEEP intent / trips
  -- Audit trigger records reason presence_unavailable (not manual_go_offline).
  UPDATE public.drivers d
  SET is_online = false,
      updated_at = now()
  FROM public.driver_presence dp
  WHERE d.id = dp.driver_id
    AND COALESCE(d.driver_online_intent, false) = true
    AND dp.last_heartbeat_at IS NOT NULL
    AND dp.last_heartbeat_at <= now() - make_interval(secs => v_ttl_s)
    AND d.is_online IS DISTINCT FROM false;
  GET DIAGNOSTICS v_unavailable = ROW_COUNT;
  -- Does NOT write: driver_online_intent, current_trip_id, online_since,
  -- offline_reason=manual_go_offline, stacked trips, auth session.

  -- 4) Intent=true but account/compliance ineligible → effective offline, KEEP intent
  UPDATE public.drivers d
  SET is_online = false,
      updated_at = now()
  WHERE COALESCE(d.driver_online_intent, false) = true
    AND COALESCE((public.assert_driver_presence_online_eligible(d.id) ->> 'eligible')::boolean, false) = false
    AND d.is_online IS DISTINCT FROM false;
  GET DIAGNOSTICS v_ineligible = ROW_COUNT;

  UPDATE public.driver_presence dp
  SET presence_health = 'degraded',
      updated_at = now()
  FROM public.drivers d
  WHERE d.id = dp.driver_id
    AND COALESCE(d.driver_online_intent, false) = true
    AND COALESCE((public.assert_driver_presence_online_eligible(d.id) ->> 'eligible')::boolean, false) = false
    AND NOT public.is_explicit_offline_reason(dp.offline_reason)
    AND dp.presence_health IS DISTINCT FROM 'degraded'
    AND dp.presence_health IS DISTINCT FROM 'offline';

  -- 5) Explicit offline intent=false → presence offline + is_online false
  UPDATE public.driver_presence dp
  SET status = 'offline',
      presence_health = 'offline',
      offline_reason = COALESCE(NULLIF(trim(dp.offline_reason), ''), 'manual_go_offline'),
      last_offline_at = COALESCE(dp.last_offline_at, now()),
      updated_at = now()
  FROM public.drivers d
  WHERE d.id = dp.driver_id
    AND COALESCE(d.driver_online_intent, false) = false
    AND (
      dp.status IS DISTINCT FROM 'offline'
      OR dp.presence_health IS DISTINCT FROM 'offline'
    );
  GET DIAGNOSTICS v_offline = ROW_COUNT;

  UPDATE public.drivers d
  SET is_online = false,
      updated_at = now()
  WHERE COALESCE(d.driver_online_intent, false) = false
    AND d.is_online IS DISTINCT FROM false;

  IF v_repaired > 0 OR v_repaired_online > 0 OR v_degraded > 0
     OR v_offline > 0 OR v_unavailable > 0 OR v_ineligible > 0 THEN
    RAISE LOG '[expire_stale_drivers] repaired=% repaired_online=% degraded=% stale_unavailable=% offline=% ineligible=% ttl_s=%',
      v_repaired, v_repaired_online, v_degraded, v_unavailable, v_offline, v_ineligible, v_ttl_s;
  END IF;

  RETURN v_offline + v_unavailable + v_ineligible;
END;
$$;

COMMIT;
