-- P0 MK-260921-006: upsert_driver_presence must not drop genuine GPS samples
-- because a heartbeat refreshed last_heartbeat_at within the prior 2 seconds.
-- Pure heartbeat (no p_gps_recorded_at) keeps the <2s rate-limit.

CREATE OR REPLACE FUNCTION public.upsert_driver_presence(p_driver_id uuid, p_status text DEFAULT NULL::text, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_heading double precision DEFAULT NULL::double precision, p_speed double precision DEFAULT NULL::double precision, p_app_state text DEFAULT NULL::text, p_platform text DEFAULT NULL::text, p_push_token text DEFAULT NULL::text, p_device_id text DEFAULT NULL::text, p_accuracy double precision DEFAULT NULL::double precision, p_battery_level smallint DEFAULT NULL::smallint, p_socket_connected boolean DEFAULT NULL::boolean, p_unresolved_critical_tracking boolean DEFAULT NULL::boolean, p_network_type text DEFAULT NULL::text, p_offline_reason text DEFAULT NULL::text, p_gps_recorded_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_source text DEFAULT NULL::text)
 RETURNS driver_presence
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result public.driver_presence;
  v_driver public.drivers%ROWTYPE;
  v_prev public.driver_presence%ROWTYPE;
  v_prev_hb timestamptz;
  v_gap_s integer;
  v_low_accuracy boolean;
  v_active_device text;
  v_effective_online boolean;
  v_eligible jsonb;
  v_next_status text;
  v_thresholds jsonb;
  v_now timestamptz := now();
  v_lat double precision := p_lat;
  v_lng double precision := p_lng;
  v_accept_location boolean := false;
  v_location_reject_reason text := NULL;
  v_coordinate_changed boolean := false;
  v_ref_lat double precision;
  v_ref_lng double precision;
  v_move_m double precision;
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

  SELECT * INTO v_prev FROM public.driver_presence WHERE driver_id = p_driver_id;
  v_prev_hb := v_prev.last_heartbeat_at;

  -- Heartbeat rate-limit: pure liveness only (no GPS sample).
  -- Genuine location samples (p_gps_recorded_at set) must never be discarded
  -- by this throttle. MK-260921-006: BG delivery historically called
  -- driver_heartbeat_ping then submit_driver_location_sample in the same wake;
  -- native FGS heartbeat can also refresh last_heartbeat_at within <2s of GPS.
  -- Result: PRESENCE_REJECTED + no trip_driver_live_location → Customer freeze.
  IF v_prev_hb IS NOT NULL THEN
    v_gap_s := GREATEST(0, floor(extract(epoch FROM (v_now - v_prev_hb)))::integer);
    IF p_gps_recorded_at IS NULL
       AND v_gap_s < 2
       AND COALESCE(p_status, '') <> 'offline'
    THEN
      IF FOUND THEN
        RETURN v_prev;
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

  -- ── Location-freshness gate ──────────────────────────────────────────────
  -- This is the P0 fix: only a genuinely NEW sample may advance
  -- last_location_at / last_gps_sample_at / last_coordinate_change_at /
  -- drivers.current_lat/lng / drivers.last_location_updated_at. A heartbeat
  -- tick that merely republishes the same cached fix must NOT look fresh.
  v_thresholds := public.driver_location_thresholds();

  IF v_lat IS NOT NULL AND v_lng IS NOT NULL THEN
    -- Impossible-coordinate guard (NaN self-inequality check included).
    IF v_lat <> v_lat OR v_lng <> v_lng
       OR abs(v_lat) > 90 OR abs(v_lng) > 180
       OR (v_lat = 0 AND v_lng = 0)
    THEN
      v_lat := NULL;
      v_lng := NULL;
      v_location_reject_reason := 'impossible_coordinates';
    END IF;
  END IF;

  IF v_lat IS NOT NULL AND v_lng IS NOT NULL THEN
    IF p_gps_recorded_at IS NOT NULL THEN
      -- New app builds: caller proves this is a genuine device GPS fix.
      IF p_gps_recorded_at > v_now + make_interval(secs => (v_thresholds->>'future_skew_tolerance_seconds')::int) THEN
        v_location_reject_reason := 'future_timestamp';
      ELSIF p_gps_recorded_at < v_now - make_interval(secs => (v_thresholds->>'gps_sample_max_age_seconds')::int) THEN
        v_location_reject_reason := 'stale_gps_timestamp';
      ELSIF v_prev.last_gps_recorded_at IS NOT NULL
            AND p_gps_recorded_at < v_prev.last_gps_recorded_at - make_interval(secs => (v_thresholds->>'out_of_order_tolerance_seconds')::int)
      THEN
        v_location_reject_reason := 'out_of_order_sample';
      ELSIF v_prev.last_gps_recorded_at IS NOT NULL
            AND v_prev.last_gps_recorded_at = p_gps_recorded_at
            AND v_prev.lat = v_lat AND v_prev.lng = v_lng
      THEN
        v_location_reject_reason := 'duplicate_cached_sample';
      ELSE
        v_accept_location := true;
      END IF;
    ELSE
      -- Legacy callers (every driver app version live today): no proof of a
      -- fresh GPS timestamp is available. Coordinate-equality heuristic -
      -- a real device GPS fix varies at double precision even when
      -- stationary; an EXACT repeat of the previously stored fix is the
      -- confirmed cache-replay bug pattern and must not advance freshness.
      IF v_prev.lat IS NOT NULL AND v_prev.lng IS NOT NULL
         AND v_prev.lat = v_lat AND v_prev.lng = v_lng
      THEN
        v_location_reject_reason := 'duplicate_cached_sample_no_timestamp';
      ELSE
        v_accept_location := true;
      END IF;
    END IF;
  END IF;

  IF v_accept_location THEN
    v_ref_lat := COALESCE(v_prev.last_significant_move_lat, v_prev.lat);
    v_ref_lng := COALESCE(v_prev.last_significant_move_lng, v_prev.lng);
    IF v_ref_lat IS NULL OR v_ref_lng IS NULL THEN
      v_coordinate_changed := true;
    ELSE
      v_move_m := public.haversine_meters(v_ref_lat, v_ref_lng, v_lat, v_lng);
      v_coordinate_changed := v_move_m >= (v_thresholds->>'movement_threshold_meters')::double precision;
    END IF;
  END IF;

  INSERT INTO public.driver_presence (
    driver_id, status, last_heartbeat_at,
    lat, lng, heading, speed, last_location_at,
    last_gps_recorded_at, last_gps_sample_at, location_source,
    last_coordinate_change_at, last_significant_move_at,
    last_significant_move_lat, last_significant_move_lng,
    app_state, platform, push_token,
    accuracy_m, battery_level, low_accuracy,
    socket_connected, unresolved_critical_tracking,
    last_socket_pong_at, network_type,
    presence_health, offline_reason, updated_at
  ) VALUES (
    p_driver_id,
    v_next_status,
    v_now,
    CASE WHEN v_accept_location THEN v_lat ELSE NULL END,
    CASE WHEN v_accept_location THEN v_lng ELSE NULL END,
    p_heading, p_speed,
    CASE WHEN v_accept_location THEN v_now ELSE NULL END,
    CASE WHEN v_accept_location THEN p_gps_recorded_at ELSE NULL END,
    CASE WHEN v_accept_location THEN v_now ELSE NULL END,
    CASE WHEN v_accept_location THEN p_source ELSE NULL END,
    CASE WHEN v_accept_location AND v_coordinate_changed THEN v_now ELSE NULL END,
    CASE WHEN v_accept_location AND v_coordinate_changed THEN v_now ELSE NULL END,
    CASE WHEN v_accept_location AND v_coordinate_changed THEN v_lat ELSE NULL END,
    CASE WHEN v_accept_location AND v_coordinate_changed THEN v_lng ELSE NULL END,
    COALESCE(p_app_state, 'foreground'),
    p_platform,
    p_push_token,
    p_accuracy, p_battery_level, v_low_accuracy,
    p_socket_connected,
    COALESCE(p_unresolved_critical_tracking, false),
    CASE WHEN COALESCE(p_socket_connected, false) THEN v_now ELSE NULL END,
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
    v_now
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
    last_heartbeat_at = v_now,
    lat = CASE WHEN v_accept_location THEN v_lat ELSE public.driver_presence.lat END,
    lng = CASE WHEN v_accept_location THEN v_lng ELSE public.driver_presence.lng END,
    -- Gated on v_accept_location (not just "was a value supplied"): a
    -- rejected/duplicate location sample must not leak a new heading/speed/
    -- accuracy reading into driver_presence either — the whole GPS sample
    -- (lat, lng, gps_ts, accuracy, speed, course) is accepted or rejected
    -- as one atomic unit. A pure heartbeat (driver_heartbeat_ping — no
    -- p_heading/p_speed supplied) already no-ops via COALESCE regardless.
    heading = CASE WHEN v_accept_location THEN COALESCE(p_heading, public.driver_presence.heading) ELSE public.driver_presence.heading END,
    speed = CASE WHEN v_accept_location THEN COALESCE(p_speed, public.driver_presence.speed) ELSE public.driver_presence.speed END,
    last_location_at = CASE WHEN v_accept_location THEN v_now ELSE public.driver_presence.last_location_at END,
    last_gps_recorded_at = CASE WHEN v_accept_location THEN p_gps_recorded_at ELSE public.driver_presence.last_gps_recorded_at END,
    last_gps_sample_at = CASE WHEN v_accept_location THEN v_now ELSE public.driver_presence.last_gps_sample_at END,
    location_source = CASE WHEN v_accept_location THEN p_source ELSE public.driver_presence.location_source END,
    last_coordinate_change_at = CASE WHEN v_accept_location AND v_coordinate_changed THEN v_now ELSE public.driver_presence.last_coordinate_change_at END,
    last_significant_move_at = CASE WHEN v_accept_location AND v_coordinate_changed THEN v_now ELSE public.driver_presence.last_significant_move_at END,
    last_significant_move_lat = CASE WHEN v_accept_location AND v_coordinate_changed THEN v_lat ELSE public.driver_presence.last_significant_move_lat END,
    last_significant_move_lng = CASE WHEN v_accept_location AND v_coordinate_changed THEN v_lng ELSE public.driver_presence.last_significant_move_lng END,
    app_state = COALESCE(p_app_state, public.driver_presence.app_state),
    platform = COALESCE(p_platform, public.driver_presence.platform),
    push_token = COALESCE(p_push_token, public.driver_presence.push_token),
    accuracy_m = CASE WHEN v_accept_location THEN COALESCE(p_accuracy, public.driver_presence.accuracy_m) ELSE public.driver_presence.accuracy_m END,
    battery_level = COALESCE(p_battery_level, public.driver_presence.battery_level),
    low_accuracy = CASE WHEN v_accept_location AND p_accuracy IS NOT NULL THEN v_low_accuracy ELSE public.driver_presence.low_accuracy END,
    socket_connected = COALESCE(p_socket_connected, public.driver_presence.socket_connected),
    unresolved_critical_tracking = COALESCE(p_unresolved_critical_tracking, public.driver_presence.unresolved_critical_tracking),
    last_socket_pong_at = CASE
      WHEN COALESCE(p_socket_connected, false) THEN v_now
      ELSE public.driver_presence.last_socket_pong_at
    END,
    network_type = CASE
      WHEN p_network_type IS NOT NULL AND trim(p_network_type) <> '' THEN trim(p_network_type)
      ELSE public.driver_presence.network_type
    END,
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
    updated_at = v_now
  RETURNING * INTO v_result;

  v_eligible := public.assert_driver_presence_online_eligible(p_driver_id);
  v_effective_online :=
    COALESCE(v_driver.driver_online_intent, false)
    AND COALESCE((v_eligible ->> 'eligible')::boolean, false)
    AND v_result.status IN ('online', 'on_trip', 'paused');

  PERFORM public.allow_driver_availability_write();
  UPDATE public.drivers SET
    is_online = v_effective_online,
    current_lat = CASE WHEN v_accept_location THEN v_lat ELSE current_lat END,
    current_lng = CASE WHEN v_accept_location THEN v_lng ELSE current_lng END,
    heading = CASE WHEN v_accept_location THEN COALESCE(p_heading, heading) ELSE heading END,
    speed = CASE WHEN v_accept_location THEN COALESCE(p_speed, speed) ELSE speed END,
    last_location_updated_at = CASE WHEN v_accept_location THEN v_now ELSE last_location_updated_at END,
    last_gps_sample_at = CASE WHEN v_accept_location THEN v_now ELSE last_gps_sample_at END,
    location_source = CASE WHEN v_accept_location THEN p_source ELSE location_source END,
    last_coordinate_change_at = CASE WHEN v_accept_location AND v_coordinate_changed THEN v_now ELSE last_coordinate_change_at END,
    last_seen_at = v_now,
    updated_at = v_now
  WHERE id = p_driver_id;

  RETURN v_result;
END;
$function$

