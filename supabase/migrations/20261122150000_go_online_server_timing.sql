-- Go Online Phase 1: observational server timing on driver_request_go_online.
-- Eligibility / presence / intent semantics UNCHANGED (fail-closed).
-- Timing keys are additive on the jsonb response for client waterfall telemetry.

CREATE OR REPLACE FUNCTION public.driver_request_go_online(
  p_lat double precision DEFAULT NULL::double precision,
  p_lng double precision DEFAULT NULL::double precision,
  p_heading double precision DEFAULT NULL::double precision,
  p_speed double precision DEFAULT NULL::double precision,
  p_accuracy double precision DEFAULT NULL::double precision,
  p_app_state text DEFAULT 'foreground'::text,
  p_platform text DEFAULT NULL::text,
  p_network_type text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
  v_driver public.drivers%ROWTYPE;
  v_eligibility jsonb;
  v_from_intent boolean;
  v_from_online boolean;
  v_now timestamptz := now();
  v_t0 timestamptz := clock_timestamp();
  v_t_elig timestamptz;
  v_t_done timestamptz;
  v_eligibility_ms integer;
  v_presence_ms integer;
  v_total_ms integer;
BEGIN
  v_driver_id := public.require_authenticated_driver_id();

  SELECT * INTO v_driver FROM public.drivers WHERE id = v_driver_id FOR UPDATE;

  v_from_intent := COALESCE(v_driver.driver_online_intent, false);
  v_from_online := COALESCE(v_driver.is_online, false);

  v_eligibility := public.assert_driver_presence_online_eligible(v_driver_id);
  v_t_elig := clock_timestamp();
  v_eligibility_ms := GREATEST(
    0,
    (EXTRACT(EPOCH FROM (v_t_elig - v_t0)) * 1000)::integer
  );

  IF COALESCE((v_eligibility ->> 'eligible')::boolean, false) <> true THEN
    v_t_done := clock_timestamp();
    v_total_ms := GREATEST(
      0,
      (EXTRACT(EPOCH FROM (v_t_done - v_t0)) * 1000)::integer
    );
    RETURN jsonb_build_object(
      'ok', false,
      'code', COALESCE(v_eligibility ->> 'code', 'ONLINE_ELIGIBILITY_BLOCKED'),
      'message', COALESCE(v_eligibility ->> 'message', 'Driver is not eligible to go online.'),
      'driver_id', v_driver_id,
      'driver_online_intent', v_from_intent,
      'is_online', v_from_online,
      'go_online_server_eligibility_ms', v_eligibility_ms,
      'go_online_server_presence_ms', 0,
      'go_online_server_total_ms', v_total_ms
    );
  END IF;

  PERFORM public.allow_driver_availability_write();

  UPDATE public.drivers
  SET driver_online_intent = true,
      is_online = true,
      online_since = CASE
        WHEN COALESCE(driver_online_intent, false) = true AND online_since IS NOT NULL THEN online_since
        ELSE v_now
      END,
      current_lat = COALESCE(p_lat, current_lat),
      current_lng = COALESCE(p_lng, current_lng),
      heading = COALESCE(p_heading, heading),
      speed = COALESCE(p_speed, speed),
      last_location_updated_at = CASE WHEN p_lat IS NOT NULL THEN v_now ELSE last_location_updated_at END,
      last_gps_sample_at = CASE WHEN p_lat IS NOT NULL THEN v_now ELSE last_gps_sample_at END,
      location_source = CASE WHEN p_lat IS NOT NULL THEN 'go_online' ELSE location_source END,
      last_coordinate_change_at = CASE WHEN p_lat IS NOT NULL THEN v_now ELSE last_coordinate_change_at END,
      last_seen_at = v_now,
      updated_at = v_now
  WHERE id = v_driver_id;

  INSERT INTO public.driver_presence (
    driver_id, status, presence_health, last_heartbeat_at, lat, lng, heading, speed,
    last_location_at, last_gps_recorded_at, last_gps_sample_at, location_source,
    last_coordinate_change_at, last_significant_move_at,
    last_significant_move_lat, last_significant_move_lng,
    app_state, platform, network_type, offline_reason, last_offline_at, updated_at
  ) VALUES (
    v_driver_id, 'online', 'healthy', v_now, p_lat, p_lng, p_heading, p_speed,
    CASE WHEN p_lat IS NOT NULL THEN v_now ELSE NULL END,
    NULL,
    CASE WHEN p_lat IS NOT NULL THEN v_now ELSE NULL END,
    CASE WHEN p_lat IS NOT NULL THEN 'go_online' ELSE NULL END,
    CASE WHEN p_lat IS NOT NULL THEN v_now ELSE NULL END,
    CASE WHEN p_lat IS NOT NULL THEN v_now ELSE NULL END,
    p_lat, p_lng,
    COALESCE(NULLIF(trim(p_app_state), ''), 'foreground'),
    p_platform, NULLIF(trim(COALESCE(p_network_type, '')), ''), NULL, NULL, v_now
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    status = 'online',
    presence_health = 'healthy',
    last_heartbeat_at = v_now,
    lat = COALESCE(EXCLUDED.lat, public.driver_presence.lat),
    lng = COALESCE(EXCLUDED.lng, public.driver_presence.lng),
    heading = COALESCE(EXCLUDED.heading, public.driver_presence.heading),
    speed = COALESCE(EXCLUDED.speed, public.driver_presence.speed),
    last_location_at = CASE WHEN EXCLUDED.lat IS NOT NULL THEN v_now ELSE public.driver_presence.last_location_at END,
    last_gps_sample_at = CASE WHEN EXCLUDED.lat IS NOT NULL THEN v_now ELSE public.driver_presence.last_gps_sample_at END,
    location_source = CASE WHEN EXCLUDED.lat IS NOT NULL THEN 'go_online' ELSE public.driver_presence.location_source END,
    last_coordinate_change_at = CASE WHEN EXCLUDED.lat IS NOT NULL THEN v_now ELSE public.driver_presence.last_coordinate_change_at END,
    last_significant_move_at = CASE WHEN EXCLUDED.lat IS NOT NULL THEN v_now ELSE public.driver_presence.last_significant_move_at END,
    last_significant_move_lat = CASE WHEN EXCLUDED.lat IS NOT NULL THEN EXCLUDED.lat ELSE public.driver_presence.last_significant_move_lat END,
    last_significant_move_lng = CASE WHEN EXCLUDED.lat IS NOT NULL THEN EXCLUDED.lng ELSE public.driver_presence.last_significant_move_lng END,
    app_state = COALESCE(EXCLUDED.app_state, public.driver_presence.app_state),
    platform = COALESCE(EXCLUDED.platform, public.driver_presence.platform),
    network_type = COALESCE(EXCLUDED.network_type, public.driver_presence.network_type),
    offline_reason = NULL,
    updated_at = v_now;

  PERFORM public.log_driver_availability_event(
    v_driver_id, 'go_online', 'driver_request_go_online',
    v_from_intent, true, v_from_online, true,
    jsonb_build_object('source', 'driver_request_go_online')
  );

  v_t_done := clock_timestamp();
  v_presence_ms := GREATEST(
    0,
    (EXTRACT(EPOCH FROM (v_t_done - v_t_elig)) * 1000)::integer
  );
  v_total_ms := GREATEST(
    0,
    (EXTRACT(EPOCH FROM (v_t_done - v_t0)) * 1000)::integer
  );

  RETURN jsonb_build_object(
    'ok', true, 'code', 'OK', 'message', '',
    'driver_id', v_driver_id,
    'driver_online_intent', true, 'is_online', true, 'status', 'online',
    'go_online_server_eligibility_ms', v_eligibility_ms,
    'go_online_server_presence_ms', v_presence_ms,
    'go_online_server_total_ms', v_total_ms
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.driver_request_go_online(
  double precision, double precision, double precision, double precision,
  double precision, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_request_go_online(
  double precision, double precision, double precision, double precision,
  double precision, text, text, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_request_go_online(
  double precision, double precision, double precision, double precision,
  double precision, text, text, text
) TO service_role;
