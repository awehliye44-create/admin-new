-- Phase: JWT bind + jsonb diagnostics on submit_driver_location_sample
--
-- Extends 20261112210000 soft-trip-mirror:
-- 1) authenticated callers must match current_driver_id() = p_driver_id
-- 2) RETURNS jsonb with trip_mirrored / trip_mirror_skipped for client recovery
--    (presence still advances on soft-skip; Customer mirror only when live)

DROP FUNCTION IF EXISTS public.submit_driver_location_sample(
  uuid, double precision, double precision, timestamptz,
  double precision, double precision, double precision,
  text, text, text, uuid, bigint, double precision
);

CREATE FUNCTION public.submit_driver_location_sample(
  p_driver_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_gps_recorded_at timestamp with time zone,
  p_accuracy double precision DEFAULT NULL::double precision,
  p_heading double precision DEFAULT NULL::double precision,
  p_speed double precision DEFAULT NULL::double precision,
  p_app_state text DEFAULT NULL::text,
  p_platform text DEFAULT NULL::text,
  p_source text DEFAULT NULL::text,
  p_trip_id uuid DEFAULT NULL::uuid,
  p_location_sequence bigint DEFAULT NULL::bigint,
  p_altitude double precision DEFAULT NULL::double precision
)
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
  v_caller_driver_id uuid;
BEGIN
  IF p_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_id required';
  END IF;
  IF p_gps_recorded_at IS NULL THEN
    RAISE EXCEPTION 'gps_recorded_at required';
  END IF;

  -- Authenticated Driver JWT must match p_driver_id. service_role / null uid skip.
  IF auth.uid() IS NOT NULL THEN
    v_caller_driver_id := public.current_driver_id();
    IF v_caller_driver_id IS NULL OR v_caller_driver_id IS DISTINCT FROM p_driver_id THEN
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
      RAISE LOG
        'submit_driver_location_sample: trip mirror skipped (stale/invalid) driver=% trip=%',
        p_driver_id,
        p_trip_id;
    END IF;
  END IF;

  SELECT * INTO v_prev FROM public.driver_presence WHERE driver_id = p_driver_id;

  IF p_location_sequence IS NOT NULL
     AND v_prev.location_sequence IS NOT NULL
     AND p_location_sequence < v_prev.location_sequence
  THEN
    RETURN jsonb_build_object(
      'trip_mirrored', false,
      'trip_mirror_skipped', v_trip_mirror_skipped,
      'trip_id_requested', p_trip_id,
      'presence', to_jsonb(v_prev)
    );
  END IF;

  IF p_location_sequence IS NOT NULL
     AND v_prev.location_sequence IS NOT NULL
     AND p_location_sequence = v_prev.location_sequence
     AND v_prev.last_gps_recorded_at IS NOT NULL
     AND v_prev.last_gps_recorded_at = p_gps_recorded_at
  THEN
    RETURN jsonb_build_object(
      'trip_mirrored', false,
      'trip_mirror_skipped', v_trip_mirror_skipped,
      'trip_id_requested', p_trip_id,
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
    RETURN jsonb_build_object(
      'trip_mirrored', false,
      'trip_mirror_skipped', v_trip_mirror_skipped,
      'trip_id_requested', p_trip_id,
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
    RETURN jsonb_build_object(
      'trip_mirrored', false,
      'trip_mirror_skipped', v_trip_mirror_skipped,
      'trip_id_requested', p_trip_id,
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
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'trip_mirrored',
      (v_mirror_trip_id IS NOT NULL
       AND v_result.last_gps_recorded_at IS NOT DISTINCT FROM p_gps_recorded_at),
    'trip_mirror_skipped', v_trip_mirror_skipped,
    'trip_id_requested', p_trip_id,
    'presence', to_jsonb(v_result)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_driver_location_sample(
  uuid, double precision, double precision, timestamptz,
  double precision, double precision, double precision,
  text, text, text, uuid, bigint, double precision
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.submit_driver_location_sample(
  uuid, double precision, double precision, timestamptz,
  double precision, double precision, double precision,
  text, text, text, uuid, bigint, double precision
) TO authenticated;

GRANT EXECUTE ON FUNCTION public.submit_driver_location_sample(
  uuid, double precision, double precision, timestamptz,
  double precision, double precision, double precision,
  text, text, text, uuid, bigint, double precision
) TO service_role;
