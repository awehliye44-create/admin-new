-- P0 location-publish diagnostics (observational only).
-- Survives trip completion; does NOT store lat/lng.
-- Retention: 72 hours (pg_cron purge). Not an SSOT.

CREATE TABLE IF NOT EXISTS public.driver_location_publish_diagnostics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- rpc | driver_client | customer_client
  origin text NOT NULL,
  driver_id uuid NULL,
  trip_id uuid NULL,
  app_state text NULL,
  source text NULL,
  gps_recorded_at timestamptz NULL,
  location_sequence bigint NULL,
  online_intent boolean NULL,
  background_task_delivery boolean NULL,
  publish_attempted boolean NULL,
  publish_result text NULL,
  presence_updated boolean NULL,
  trip_mirror_attempted boolean NULL,
  trip_mirrored boolean NULL,
  -- Explicit reason codes (see submit_driver_location_sample / client).
  reason_code text NOT NULL,
  trip_id_source text NULL, -- DURABLE_LATCH | ACTIVE_STORE | RECONCILED_BACKEND | NONE | RPC
  active_trip_latch_present boolean NULL,
  rpc_error_code text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE public.driver_location_publish_diagnostics IS
  'Short-lived operational evidence for ONLINE location publish / trip mirror. Not SSOT. Retained 72h. No coordinates.';

CREATE INDEX IF NOT EXISTS driver_location_publish_diagnostics_created_at_idx
  ON public.driver_location_publish_diagnostics (created_at DESC);

CREATE INDEX IF NOT EXISTS driver_location_publish_diagnostics_driver_created_idx
  ON public.driver_location_publish_diagnostics (driver_id, created_at DESC)
  WHERE driver_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS driver_location_publish_diagnostics_trip_created_idx
  ON public.driver_location_publish_diagnostics (trip_id, created_at DESC)
  WHERE trip_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS driver_location_publish_diagnostics_reason_idx
  ON public.driver_location_publish_diagnostics (reason_code, created_at DESC);

ALTER TABLE public.driver_location_publish_diagnostics ENABLE ROW LEVEL SECURITY;

-- Admins / service_role read; authenticated drivers insert own rows only.
DROP POLICY IF EXISTS "Admins read location publish diagnostics"
  ON public.driver_location_publish_diagnostics;
CREATE POLICY "Admins read location publish diagnostics"
  ON public.driver_location_publish_diagnostics
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "Drivers insert own location publish diagnostics"
  ON public.driver_location_publish_diagnostics;
CREATE POLICY "Drivers insert own location publish diagnostics"
  ON public.driver_location_publish_diagnostics
  FOR INSERT TO authenticated
  WITH CHECK (
    origin = 'driver_client'
    AND driver_id IS NOT NULL
    AND driver_id = public.current_driver_id()
  );

DROP POLICY IF EXISTS "Customers insert trip location publish diagnostics"
  ON public.driver_location_publish_diagnostics;
CREATE POLICY "Customers insert trip location publish diagnostics"
  ON public.driver_location_publish_diagnostics
  FOR INSERT TO authenticated
  WITH CHECK (
    origin = 'customer_client'
    AND trip_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.trips t
      WHERE t.id = trip_id
        AND t.passenger_id = auth.uid()
    )
  );

-- RPC inserts (origin=rpc) use SECURITY DEFINER — bypass RLS.


GRANT SELECT, INSERT ON public.driver_location_publish_diagnostics TO authenticated;
GRANT ALL ON public.driver_location_publish_diagnostics TO service_role;

-- ---------------------------------------------------------------------------
-- Client / Edge append helper (observational; never throws to caller path)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_driver_location_publish_diag(
  p_origin text,
  p_reason_code text,
  p_driver_id uuid DEFAULT NULL,
  p_trip_id uuid DEFAULT NULL,
  p_app_state text DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_gps_recorded_at timestamptz DEFAULT NULL,
  p_location_sequence bigint DEFAULT NULL,
  p_online_intent boolean DEFAULT NULL,
  p_background_task_delivery boolean DEFAULT NULL,
  p_publish_attempted boolean DEFAULT NULL,
  p_publish_result text DEFAULT NULL,
  p_presence_updated boolean DEFAULT NULL,
  p_trip_mirror_attempted boolean DEFAULT NULL,
  p_trip_mirrored boolean DEFAULT NULL,
  p_trip_id_source text DEFAULT NULL,
  p_active_trip_latch_present boolean DEFAULT NULL,
  p_rpc_error_code text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_driver_id uuid := p_driver_id;
  v_origin text := lower(trim(COALESCE(p_origin, '')));
  v_reason text := upper(trim(COALESCE(p_reason_code, '')));
BEGIN
  IF v_origin NOT IN ('rpc', 'driver_client', 'customer_client') THEN
    RAISE EXCEPTION 'invalid_origin';
  END IF;
  IF v_reason = '' THEN
    RAISE EXCEPTION 'reason_code required';
  END IF;

  -- Authenticated drivers may only write as themselves.
  IF auth.uid() IS NOT NULL THEN
    IF v_origin = 'customer_client' THEN
      IF p_trip_id IS NULL THEN
        RAISE EXCEPTION 'trip_id required';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.trips t
        WHERE t.id = p_trip_id AND t.passenger_id = auth.uid()
      ) THEN
        RAISE EXCEPTION 'TRIP_ACCESS_DENIED' USING ERRCODE = 'P0001';
      END IF;
      v_driver_id := p_driver_id; -- optional; may be trip's driver
    ELSIF v_origin = 'driver_client' THEN
      v_driver_id := public.current_driver_id();
      IF v_driver_id IS NULL THEN
        RAISE EXCEPTION 'driver_id required';
      END IF;
      IF p_driver_id IS NOT NULL AND p_driver_id IS DISTINCT FROM v_driver_id THEN
        RAISE EXCEPTION 'DRIVER_ID_MISMATCH' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    -- origin=rpc typically via SECURITY DEFINER nested call (no auth.uid check needed)
  END IF;

  INSERT INTO public.driver_location_publish_diagnostics (
    origin,
    driver_id,
    trip_id,
    app_state,
    source,
    gps_recorded_at,
    location_sequence,
    online_intent,
    background_task_delivery,
    publish_attempted,
    publish_result,
    presence_updated,
    trip_mirror_attempted,
    trip_mirrored,
    reason_code,
    trip_id_source,
    active_trip_latch_present,
    rpc_error_code,
    metadata
  ) VALUES (
    v_origin,
    v_driver_id,
    p_trip_id,
    NULLIF(trim(COALESCE(p_app_state, '')), ''),
    NULLIF(trim(COALESCE(p_source, '')), ''),
    p_gps_recorded_at,
    p_location_sequence,
    p_online_intent,
    p_background_task_delivery,
    p_publish_attempted,
    NULLIF(trim(COALESCE(p_publish_result, '')), ''),
    p_presence_updated,
    p_trip_mirror_attempted,
    p_trip_mirrored,
    v_reason,
    NULLIF(trim(COALESCE(p_trip_id_source, '')), ''),
    p_active_trip_latch_present,
    NULLIF(trim(COALESCE(p_rpc_error_code, '')), ''),
    COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
EXCEPTION
  WHEN OTHERS THEN
    -- Observational only — never break publish/tracking callers.
    RAISE LOG 'record_driver_location_publish_diag failed: %', SQLERRM;
    RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_driver_location_publish_diag(
  text, text, uuid, uuid, text, text, timestamptz, bigint, boolean, boolean,
  boolean, text, boolean, boolean, boolean, text, boolean, text, jsonb
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.record_driver_location_publish_diag(
  text, text, uuid, uuid, text, text, timestamptz, bigint, boolean, boolean,
  boolean, text, boolean, boolean, boolean, text, boolean, text, jsonb
) TO authenticated;

GRANT EXECUTE ON FUNCTION public.record_driver_location_publish_diag(
  text, text, uuid, uuid, text, text, timestamptz, bigint, boolean, boolean,
  boolean, text, boolean, boolean, boolean, text, boolean, text, jsonb
) TO service_role;

-- ---------------------------------------------------------------------------
-- Retention: 72 hours
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_driver_location_publish_diagnostics(
  p_older_than interval DEFAULT interval '72 hours'
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.driver_location_publish_diagnostics
  WHERE created_at < now() - p_older_than;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.purge_driver_location_publish_diagnostics(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_driver_location_publish_diagnostics(interval) TO service_role;

DO $$
BEGIN
  PERFORM cron.unschedule('purge-driver-location-publish-diagnostics');
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'purge-driver-location-publish-diagnostics',
  '17 * * * *',
  $$SELECT public.purge_driver_location_publish_diagnostics(interval '72 hours')$$
);

-- ---------------------------------------------------------------------------
-- Instrument submit_driver_location_sample (same signature; richer jsonb + diag)
-- ---------------------------------------------------------------------------
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
  v_trip_mirror_reason text := NULL;
  v_caller_driver_id uuid;
  v_presence_updated boolean := false;
  v_trip_mirrored boolean := false;
  v_reason text := 'PRESENCE_ACCEPTED';
  v_online boolean := false;
BEGIN
  IF p_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_id required';
  END IF;
  IF p_gps_recorded_at IS NULL THEN
    RAISE EXCEPTION 'gps_recorded_at required';
  END IF;

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
  v_online := COALESCE(lower(v_prev.status) IN ('online', 'available'), false)
    OR COALESCE(v_prev.status, '') <> '';

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
      v_trip_mirrored := true;
      v_reason := 'TRIP_MIRRORED';
      v_trip_mirror_reason := 'TRIP_MIRRORED';
    ELSIF p_trip_id IS NULL THEN
      v_reason := 'PRESENCE_UPDATED_NO_ACTIVE_TRIP';
      v_trip_mirror_reason := COALESCE(v_trip_mirror_reason, 'NO_ACTIVE_TRIP');
    ELSE
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
