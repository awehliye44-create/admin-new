-- Gap-close for location-publish diagnostics (observational only).
-- Fixes: early-raise diags, online_intent = drivers.driver_online_intent,
-- accurate TRIP_MIRRORED (ROW_COUNT), NO_ACTIVE_TRIP reason_code.

CREATE OR REPLACE FUNCTION public.submit_driver_location_sample(p_driver_id uuid, p_lat double precision, p_lng double precision, p_gps_recorded_at timestamp with time zone, p_accuracy double precision DEFAULT NULL::double precision, p_heading double precision DEFAULT NULL::double precision, p_speed double precision DEFAULT NULL::double precision, p_app_state text DEFAULT NULL::text, p_platform text DEFAULT NULL::text, p_source text DEFAULT NULL::text, p_trip_id uuid DEFAULT NULL::uuid, p_location_sequence bigint DEFAULT NULL::bigint, p_altitude double precision DEFAULT NULL::double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev public.driver_presence%ROWTYPE;
  v_result public.driver_presence;
  v_source text := NULLIF(trim(COALESCE(p_source, '')), '');
  v_is_active_trip boolean := false;
  v_is_background boolean := false;
  v_prev_is_foreground boolean := false;
  v_mirror_trip_id uuid := NULL;
  v_trip_mirror_skipped boolean := false;
  v_trip_mirror_reason text := NULL;
  v_caller_driver_id uuid;
  v_presence_updated boolean := false;
  v_trip_mirrored boolean := false;
  v_reason text := 'PRESENCE_ACCEPTED';
  v_online boolean := false;
  v_tdll_rows integer := 0;
BEGIN
  IF p_driver_id IS NULL THEN
    PERFORM public.record_driver_location_publish_diag(
      'rpc', 'DRIVER_ID_REQUIRED', NULL, p_trip_id, p_app_state, p_source,
      p_gps_recorded_at, p_location_sequence, NULL, NULL, true, 'rejected',
      false, p_trip_id IS NOT NULL, false, 'RPC', NULL, 'driver_id_required',
      '{}'::jsonb
    );
    RAISE EXCEPTION 'driver_id required';
  END IF;
  IF p_gps_recorded_at IS NULL THEN
    PERFORM public.record_driver_location_publish_diag(
      'rpc', 'GPS_RECORDED_AT_REQUIRED', p_driver_id, p_trip_id, p_app_state, p_source,
      NULL, p_location_sequence, NULL, NULL, true, 'rejected',
      false, p_trip_id IS NOT NULL, false, 'RPC', NULL, 'gps_recorded_at_required',
      '{}'::jsonb
    );
    RAISE EXCEPTION 'gps_recorded_at required';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    v_caller_driver_id := public.current_driver_id();
    IF v_caller_driver_id IS NULL OR v_caller_driver_id IS DISTINCT FROM p_driver_id THEN
      PERFORM public.record_driver_location_publish_diag(
        'rpc', 'DRIVER_ID_MISMATCH', p_driver_id, p_trip_id, p_app_state, p_source,
        p_gps_recorded_at, p_location_sequence, NULL, NULL, true, 'rejected',
        false, p_trip_id IS NOT NULL, false, 'RPC', NULL, 'DRIVER_ID_MISMATCH',
        '{}'::jsonb
      );
      RAISE EXCEPTION 'DRIVER_ID_MISMATCH'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_is_active_trip :=
    v_source IS NOT NULL
    AND lower(v_source) LIKE 'active_trip%';

  IF v_is_active_trip AND p_trip_id IS NULL THEN
    v_is_active_trip := false;
    v_source := CASE
      WHEN lower(COALESCE(p_app_state, '')) IN ('background', 'backgrounded')
        THEN 'background_gps'
      ELSE COALESCE(v_source, 'foreground_gps')
    END;
  END IF;

  IF p_trip_id IS NOT NULL THEN
    IF public.driver_is_assigned_to_live_trip(p_driver_id, p_trip_id) THEN
      v_mirror_trip_id := p_trip_id;
    ELSE
      v_trip_mirror_skipped := true;
      -- Distinguish missing live vs mismatch using canonical helpers.
      IF NOT EXISTS (
        SELECT 1 FROM public.trips t
        WHERE t.id = p_trip_id
          AND public.trip_status_is_live_trackable(t.status)
      ) THEN
        v_trip_mirror_reason := 'TRIP_NOT_LIVE';
      ELSE
        v_trip_mirror_reason := 'TRIP_DRIVER_MISMATCH';
      END IF;
      RAISE LOG
        'submit_driver_location_sample: trip mirror skipped (%) driver=% trip=%',
        v_trip_mirror_reason,
        p_driver_id,
        p_trip_id;
    END IF;
  ELSE
    v_trip_mirror_reason := 'TRIP_ID_MISSING';
  END IF;

  SELECT * INTO v_prev FROM public.driver_presence WHERE driver_id = p_driver_id;
  -- online_intent column stores drivers.driver_online_intent (not presence status).
  SELECT COALESCE(d.driver_online_intent, false)
    INTO v_online
  FROM public.drivers d
  WHERE d.id = p_driver_id;
  IF NOT FOUND THEN
    v_online := false;
  END IF;

  IF p_location_sequence IS NOT NULL
     AND v_prev.location_sequence IS NOT NULL
     AND p_location_sequence < v_prev.location_sequence
  THEN
    v_reason := 'OUT_OF_ORDER_SAMPLE';
    PERFORM public.record_driver_location_publish_diag(
      'rpc', v_reason, p_driver_id, p_trip_id, p_app_state, COALESCE(v_source, p_source),
      p_gps_recorded_at, p_location_sequence, v_online, NULL, true, 'rejected',
      false, p_trip_id IS NOT NULL, false, 'RPC', NULL, NULL,
      jsonb_build_object('trip_mirror_reason', v_trip_mirror_reason)
    );
    RETURN jsonb_build_object(
      'trip_mirrored', false,
      'trip_mirror_skipped', v_trip_mirror_skipped,
      'trip_id_requested', p_trip_id,
      'presence_updated', false,
      'reason_code', v_reason,
      'trip_mirror_reason', v_trip_mirror_reason,
      'presence', to_jsonb(v_prev)
    );
  END IF;

  IF p_location_sequence IS NOT NULL
     AND v_prev.location_sequence IS NOT NULL
     AND p_location_sequence = v_prev.location_sequence
     AND v_prev.last_gps_recorded_at IS NOT NULL
     AND v_prev.last_gps_recorded_at = p_gps_recorded_at
  THEN
    v_reason := 'STALE_SAMPLE';
    PERFORM public.record_driver_location_publish_diag(
      'rpc', v_reason, p_driver_id, p_trip_id, p_app_state, COALESCE(v_source, p_source),
      p_gps_recorded_at, p_location_sequence, v_online, NULL, true, 'rejected',
      false, p_trip_id IS NOT NULL, false, 'RPC', NULL, NULL,
      jsonb_build_object('trip_mirror_reason', v_trip_mirror_reason, 'duplicate', true)
    );
    RETURN jsonb_build_object(
      'trip_mirrored', false,
      'trip_mirror_skipped', v_trip_mirror_skipped,
      'trip_id_requested', p_trip_id,
      'presence_updated', false,
      'reason_code', v_reason,
      'trip_mirror_reason', v_trip_mirror_reason,
      'presence', to_jsonb(v_prev)
    );
  END IF;

  IF v_prev.last_gps_recorded_at IS NOT NULL
     AND p_gps_recorded_at < v_prev.last_gps_recorded_at
     AND (
       p_location_sequence IS NULL
       OR v_prev.location_sequence IS NULL
       OR p_location_sequence <= v_prev.location_sequence
     )
  THEN
    v_reason := 'STALE_SAMPLE';
    PERFORM public.record_driver_location_publish_diag(
      'rpc', v_reason, p_driver_id, p_trip_id, p_app_state, COALESCE(v_source, p_source),
      p_gps_recorded_at, p_location_sequence, v_online, NULL, true, 'rejected',
      false, p_trip_id IS NOT NULL, false, 'RPC', NULL, NULL,
      jsonb_build_object('trip_mirror_reason', v_trip_mirror_reason)
    );
    RETURN jsonb_build_object(
      'trip_mirrored', false,
      'trip_mirror_skipped', v_trip_mirror_skipped,
      'trip_id_requested', p_trip_id,
      'presence_updated', false,
      'reason_code', v_reason,
      'trip_mirror_reason', v_trip_mirror_reason,
      'presence', to_jsonb(v_prev)
    );
  END IF;

  v_is_background :=
    lower(COALESCE(p_app_state, '')) IN ('background', 'backgrounded')
    OR (v_source IS NOT NULL AND lower(v_source) LIKE '%background%');

  v_prev_is_foreground :=
    lower(COALESCE(v_prev.app_state, '')) IN ('foreground', 'active')
    OR lower(COALESCE(v_prev.location_source, '')) LIKE '%foreground%';

  IF v_is_background
     AND v_prev_is_foreground
     AND v_prev.last_gps_recorded_at IS NOT NULL
     AND p_gps_recorded_at <= v_prev.last_gps_recorded_at
  THEN
    v_reason := 'PRESENCE_REJECTED';
    PERFORM public.record_driver_location_publish_diag(
      'rpc', v_reason, p_driver_id, p_trip_id, p_app_state, COALESCE(v_source, p_source),
      p_gps_recorded_at, p_location_sequence, v_online, true, true, 'rejected',
      false, p_trip_id IS NOT NULL, false, 'RPC', NULL, NULL,
      jsonb_build_object(
        'reject', 'bg_not_newer_than_fg',
        'trip_mirror_reason', v_trip_mirror_reason
      )
    );
    RETURN jsonb_build_object(
      'trip_mirrored', false,
      'trip_mirror_skipped', v_trip_mirror_skipped,
      'trip_id_requested', p_trip_id,
      'presence_updated', false,
      'reason_code', v_reason,
      'trip_mirror_reason', v_trip_mirror_reason,
      'presence', to_jsonb(v_prev)
    );
  END IF;

  v_result := public.upsert_driver_presence(
    p_driver_id => p_driver_id,
    p_lat => p_lat,
    p_lng => p_lng,
    p_heading => p_heading,
    p_speed => p_speed,
    p_app_state => p_app_state,
    p_platform => p_platform,
    p_accuracy => p_accuracy,
    p_gps_recorded_at => p_gps_recorded_at,
    p_source => COALESCE(v_source, p_source)
  );

  IF v_result.last_gps_recorded_at IS NOT DISTINCT FROM p_gps_recorded_at THEN
    v_presence_updated := true;
    UPDATE public.driver_presence
    SET
      location_sequence = COALESCE(p_location_sequence, location_sequence),
      altitude_m = COALESCE(p_altitude, altitude_m),
      updated_at = now()
    WHERE driver_id = p_driver_id;

    UPDATE public.drivers
    SET location_sequence = COALESCE(p_location_sequence, location_sequence)
    WHERE id = p_driver_id;

    SELECT * INTO v_result FROM public.driver_presence WHERE driver_id = p_driver_id;

    IF v_mirror_trip_id IS NOT NULL THEN
      INSERT INTO public.trip_driver_live_location AS tdll (
        trip_id,
        driver_id,
        latitude,
        longitude,
        gps_recorded_at,
        server_received_at,
        accuracy_m,
        speed,
        heading,
        altitude_m,
        location_sequence,
        updated_at
      ) VALUES (
        v_mirror_trip_id,
        p_driver_id,
        p_lat,
        p_lng,
        p_gps_recorded_at,
        now(),
        p_accuracy,
        p_speed,
        p_heading,
        p_altitude,
        p_location_sequence,
        now()
      )
      ON CONFLICT (trip_id) DO UPDATE SET
        driver_id = EXCLUDED.driver_id,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        gps_recorded_at = EXCLUDED.gps_recorded_at,
        server_received_at = EXCLUDED.server_received_at,
        accuracy_m = COALESCE(EXCLUDED.accuracy_m, tdll.accuracy_m),
        speed = COALESCE(EXCLUDED.speed, tdll.speed),
        heading = COALESCE(EXCLUDED.heading, tdll.heading),
        altitude_m = COALESCE(EXCLUDED.altitude_m, tdll.altitude_m),
        location_sequence = COALESCE(EXCLUDED.location_sequence, tdll.location_sequence),
        updated_at = now()
      WHERE
        EXCLUDED.gps_recorded_at >= tdll.gps_recorded_at
        AND (
          EXCLUDED.location_sequence IS NULL
          OR tdll.location_sequence IS NULL
          OR EXCLUDED.location_sequence >= tdll.location_sequence
        );
      GET DIAGNOSTICS v_tdll_rows = ROW_COUNT;
      IF v_tdll_rows > 0 THEN
        v_trip_mirrored := true;
        v_reason := 'TRIP_MIRRORED';
        v_trip_mirror_reason := 'TRIP_MIRRORED';
      ELSE
        v_trip_mirrored := false;
        v_reason := 'TRIP_MIRROR_STALE_SKIPPED';
        v_trip_mirror_reason := 'TRIP_MIRROR_STALE_SKIPPED';
        v_trip_mirror_skipped := true;
      END IF;
    ELSIF p_trip_id IS NULL THEN
      v_reason := 'NO_ACTIVE_TRIP';
      v_trip_mirror_reason := COALESCE(v_trip_mirror_reason, 'NO_ACTIVE_TRIP');
    ELSE
      -- Presence advanced; mirror skipped for explicit reason.
      v_reason := COALESCE(v_trip_mirror_reason, 'TRIP_MIRROR_SKIPPED');
    END IF;
  ELSE
    v_reason := 'PRESENCE_REJECTED';
  END IF;

  PERFORM public.record_driver_location_publish_diag(
    'rpc',
    v_reason,
    p_driver_id,
    p_trip_id,
    p_app_state,
    COALESCE(v_source, p_source),
    p_gps_recorded_at,
    p_location_sequence,
    v_online,
    v_is_background,
    true,
    CASE WHEN v_presence_updated THEN 'accepted' ELSE 'rejected' END,
    v_presence_updated,
    p_trip_id IS NOT NULL,
    v_trip_mirrored,
    'RPC',
    NULL,
    NULL,
    jsonb_build_object(
      'trip_mirror_reason', v_trip_mirror_reason,
      'trip_mirror_skipped', v_trip_mirror_skipped
    )
  );

  RETURN jsonb_build_object(
    'trip_mirrored', v_trip_mirrored,
    'trip_mirror_skipped', v_trip_mirror_skipped,
    'trip_id_requested', p_trip_id,
    'presence_updated', v_presence_updated,
    'reason_code', v_reason,
    'trip_mirror_reason', v_trip_mirror_reason,
    'presence', to_jsonb(v_result)
  );
END;
$function$


