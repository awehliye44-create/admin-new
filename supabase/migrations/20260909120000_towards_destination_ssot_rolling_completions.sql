-- Towards Destination SSOT: rolling 24h completions, directional matching,
-- arrival radius, same-location protection. Do NOT apply until approved.
--
-- Gaps closed vs live prod (thazislrdkjpvvghtvzo audit):
-- 1) Usage consumed on activate → consume only on destination_reached completion
-- 2) Calendar-day counter (limit 3) → rolling 24h successful completions (limit 5)
-- 3) Matching = hardcoded 3km dropoff radius → directional progress filter
-- 4) No arrival / same-location → arrival radius (default 500m) + reject already_reached
-- 5) No session history → towards_destination_sessions table

-- ---------------------------------------------------------------------------
-- Config columns (global + per-SA)
-- ---------------------------------------------------------------------------
ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS towards_destination_arrival_radius_meters integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS towards_destination_min_progress_meters integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS towards_destination_max_pickup_detour_meters integer NOT NULL DEFAULT 8000;

ALTER TABLE public.dispatch_settings
  ADD COLUMN IF NOT EXISTS towards_destination_arrival_radius_meters integer NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS towards_destination_min_progress_meters integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS towards_destination_max_pickup_detour_meters integer NOT NULL DEFAULT 8000;

-- Align live defaults to approved contract (5 rolling completions; progress tolerance slack)
UPDATE public.global_dispatch_settings
SET
  towards_destination_daily_limit = 5,
  towards_destination_matching_tolerance_meters = 200,
  towards_destination_arrival_radius_meters = COALESCE(towards_destination_arrival_radius_meters, 500),
  towards_destination_min_progress_meters = COALESCE(towards_destination_min_progress_meters, 100),
  towards_destination_max_pickup_detour_meters = COALESCE(towards_destination_max_pickup_detour_meters, 8000)
WHERE singleton IS TRUE;

UPDATE public.dispatch_settings
SET
  towards_destination_daily_limit = 5,
  towards_destination_matching_tolerance_meters = 200
WHERE towards_destination_daily_limit IS DISTINCT FROM 5
   OR towards_destination_matching_tolerance_meters IS DISTINCT FROM 200;

ALTER TABLE public.global_dispatch_settings
  ALTER COLUMN towards_destination_daily_limit SET DEFAULT 5;

ALTER TABLE public.dispatch_settings
  ALTER COLUMN towards_destination_daily_limit SET DEFAULT 5;

COMMENT ON COLUMN public.global_dispatch_settings.towards_destination_daily_limit IS
  'Max successful Towards Destination completions (status=completed, reason=destination_reached) in a rolling 24-hour window. Activate/cancel do not consume.';
COMMENT ON COLUMN public.global_dispatch_settings.towards_destination_arrival_radius_meters IS
  'Metres from destination at which an active session completes (destination_reached). Default 500.';
COMMENT ON COLUMN public.global_dispatch_settings.towards_destination_matching_tolerance_meters IS
  'Directional match slack: dropoff_to_dest < driver_to_dest + tolerance.';
COMMENT ON COLUMN public.global_dispatch_settings.towards_destination_min_progress_meters IS
  'Minimum metres of progress toward destination required for a trip to qualify.';
COMMENT ON COLUMN public.global_dispatch_settings.towards_destination_max_pickup_detour_meters IS
  'Max driver→pickup distance while TD filter is active (0 disables).';

-- Optional destination metadata on live filter row
ALTER TABLE public.driver_settings
  ADD COLUMN IF NOT EXISTS towards_destination_postcode text,
  ADD COLUMN IF NOT EXISTS towards_destination_place_id text,
  ADD COLUMN IF NOT EXISTS towards_destination_session_id uuid;

-- ---------------------------------------------------------------------------
-- Session history (SSOT for usage + lifecycle)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.towards_destination_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'cancelled')),
  completion_reason text
    CHECK (
      completion_reason IS NULL
      OR completion_reason IN (
        'destination_reached',
        'manual_clear',
        'replaced',
        'expired',
        'admin_terminate',
        'offline_cleared',
        'destination_already_reached'
      )
    ),
  address text NOT NULL,
  postcode text,
  place_id text,
  dest_lat double precision NOT NULL,
  dest_lng double precision NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  usage_consumed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS towards_destination_sessions_one_active_per_driver
  ON public.towards_destination_sessions (driver_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS towards_destination_sessions_usage_idx
  ON public.towards_destination_sessions (driver_id, completed_at DESC)
  WHERE status = 'completed'
    AND completion_reason = 'destination_reached'
    AND usage_consumed = true;

ALTER TABLE public.towards_destination_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS towards_destination_sessions_select_own ON public.towards_destination_sessions;
CREATE POLICY towards_destination_sessions_select_own
  ON public.towards_destination_sessions
  FOR SELECT
  TO authenticated
  USING (driver_id = public.current_driver_id());

-- Service role / SECURITY DEFINER writers; no direct client inserts.

-- ---------------------------------------------------------------------------
-- Resolve config (extended)
-- ---------------------------------------------------------------------------
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
  v_limit integer := 5;
  v_duration integer := 60;
  v_tolerance integer := 200;
  v_weight numeric := 12;
  v_arrival integer := 500;
  v_min_progress integer := 100;
  v_max_detour integer := 8000;
BEGIN
  SELECT * INTO v_global
  FROM public.global_dispatch_settings
  WHERE singleton IS TRUE
  LIMIT 1;

  IF FOUND THEN
    v_enabled := COALESCE(v_global.towards_destination_enabled, true);
    v_limit := COALESCE(v_global.towards_destination_daily_limit, 5);
    v_duration := COALESCE(v_global.towards_destination_duration_minutes, 60);
    v_tolerance := COALESCE(v_global.towards_destination_matching_tolerance_meters, 200);
    v_weight := COALESCE(v_global.towards_destination_priority_weight, 12);
    v_arrival := COALESCE(v_global.towards_destination_arrival_radius_meters, 500);
    v_min_progress := COALESCE(v_global.towards_destination_min_progress_meters, 100);
    v_max_detour := COALESCE(v_global.towards_destination_max_pickup_detour_meters, 8000);
  END IF;

  IF p_service_area_id IS NOT NULL THEN
    SELECT * INTO v_sa
    FROM public.dispatch_settings
    WHERE service_area_id = p_service_area_id
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1;

    IF FOUND THEN
      v_enabled := COALESCE(v_sa.towards_destination_enabled, v_enabled);
      v_limit := COALESCE(v_sa.towards_destination_daily_limit, v_limit);
      v_duration := COALESCE(v_sa.towards_destination_duration_minutes, v_duration);
      v_tolerance := COALESCE(v_sa.towards_destination_matching_tolerance_meters, v_tolerance);
      v_weight := COALESCE(v_sa.towards_destination_priority_weight, v_weight);
      v_arrival := COALESCE(v_sa.towards_destination_arrival_radius_meters, v_arrival);
      v_min_progress := COALESCE(v_sa.towards_destination_min_progress_meters, v_min_progress);
      v_max_detour := COALESCE(v_sa.towards_destination_max_pickup_detour_meters, v_max_detour);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'enabled', v_enabled,
    'daily_limit', v_limit,
    'limit', v_limit,
    'duration_minutes', v_duration,
    'matching_tolerance_meters', v_tolerance,
    'priority_weight', v_weight,
    'arrival_radius_meters', v_arrival,
    'min_progress_meters', v_min_progress,
    'max_pickup_detour_meters', v_max_detour,
    'window_type', 'rolling_24_hours'
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- Usage snapshot (rolling 24h completions only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.towards_destination_usage_snapshot(p_driver_id uuid, p_limit integer DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_limit integer := GREATEST(COALESCE(p_limit, 5), 0);
  v_completed integer := 0;
  v_oldest timestamptz;
  v_next timestamptz;
BEGIN
  SELECT COUNT(*)::integer,
         MIN(s.completed_at)
  INTO v_completed, v_oldest
  FROM public.towards_destination_sessions s
  WHERE s.driver_id = p_driver_id
    AND s.status = 'completed'
    AND s.completion_reason = 'destination_reached'
    AND s.usage_consumed = true
    AND s.completed_at > now() - interval '24 hours';

  IF v_completed >= v_limit AND v_oldest IS NOT NULL THEN
    v_next := v_oldest + interval '24 hours';
  END IF;

  RETURN jsonb_build_object(
    'limit', v_limit,
    'completed_last_24h', v_completed,
    'remaining', GREATEST(v_limit - v_completed, 0),
    'window_type', 'rolling_24_hours',
    'next_available_at', v_next
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- Directional trip qualify (coords only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.towards_destination_trip_qualifies(
  p_driver_lat double precision,
  p_driver_lng double precision,
  p_pickup_lat double precision,
  p_pickup_lng double precision,
  p_dropoff_lat double precision,
  p_dropoff_lng double precision,
  p_dest_lat double precision,
  p_dest_lng double precision,
  p_tolerance_meters numeric DEFAULT 200,
  p_min_progress_meters numeric DEFAULT 100,
  p_max_pickup_detour_meters numeric DEFAULT 8000
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_to_dest numeric;
  v_dropoff_to_dest numeric;
  v_driver_to_pickup numeric;
  v_progress numeric;
  v_tolerance numeric := GREATEST(COALESCE(p_tolerance_meters, 0), 0);
  v_min_progress numeric := GREATEST(COALESCE(p_min_progress_meters, 0), 0);
  v_max_detour numeric := GREATEST(COALESCE(p_max_pickup_detour_meters, 0), 0);
BEGIN
  IF p_driver_lat IS NULL OR p_driver_lng IS NULL
     OR p_pickup_lat IS NULL OR p_pickup_lng IS NULL
     OR p_dropoff_lat IS NULL OR p_dropoff_lng IS NULL
     OR p_dest_lat IS NULL OR p_dest_lng IS NULL
     OR abs(p_driver_lat) > 90 OR abs(p_driver_lng) > 180
     OR abs(p_pickup_lat) > 90 OR abs(p_pickup_lng) > 180
     OR abs(p_dropoff_lat) > 90 OR abs(p_dropoff_lng) > 180
     OR abs(p_dest_lat) > 90 OR abs(p_dest_lng) > 180
     -- Mirror shared TS coordsValid: reject Null Island on every point.
     OR (p_dest_lat = 0 AND p_dest_lng = 0)
     OR (p_driver_lat = 0 AND p_driver_lng = 0)
     OR (p_pickup_lat = 0 AND p_pickup_lng = 0)
     OR (p_dropoff_lat = 0 AND p_dropoff_lng = 0) THEN
    RETURN jsonb_build_object('qualifies', false, 'reason', 'invalid_coords');
  END IF;

  v_driver_to_dest := public.haversine_meters(p_driver_lat, p_driver_lng, p_dest_lat, p_dest_lng);
  v_dropoff_to_dest := public.haversine_meters(p_dropoff_lat, p_dropoff_lng, p_dest_lat, p_dest_lng);
  v_driver_to_pickup := public.haversine_meters(p_driver_lat, p_driver_lng, p_pickup_lat, p_pickup_lng);
  v_progress := v_driver_to_dest - v_dropoff_to_dest;

  IF NOT (v_dropoff_to_dest < v_driver_to_dest + v_tolerance AND v_progress >= v_min_progress) THEN
    RETURN jsonb_build_object(
      'qualifies', false,
      'reason', 'no_progress',
      'driver_to_dest_meters', v_driver_to_dest,
      'dropoff_to_dest_meters', v_dropoff_to_dest,
      'progress_meters', v_progress
    );
  END IF;

  IF v_max_detour > 0 AND v_driver_to_pickup > v_max_detour THEN
    RETURN jsonb_build_object(
      'qualifies', false,
      'reason', 'pickup_detour_exceeded',
      'driver_to_pickup_meters', v_driver_to_pickup,
      'max_pickup_detour_meters', v_max_detour
    );
  END IF;

  RETURN jsonb_build_object(
    'qualifies', true,
    'reason', 'ok',
    'driver_to_dest_meters', v_driver_to_dest,
    'dropoff_to_dest_meters', v_dropoff_to_dest,
    'driver_to_pickup_meters', v_driver_to_pickup,
    'progress_meters', v_progress
  );
END;
$function$;

-- Keep priority_bonus but align with progress semantics (dropoff nearer than tolerance slack)
CREATE OR REPLACE FUNCTION public.towards_destination_priority_bonus(
  p_dropoff_lat double precision,
  p_dropoff_lng double precision,
  p_dest_lat double precision,
  p_dest_lng double precision,
  p_active boolean,
  p_expires_at timestamp with time zone,
  p_enabled boolean,
  p_tolerance_meters numeric,
  p_priority_weight numeric
)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dist numeric;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT COALESCE(p_enabled, true) THEN RETURN 0; END IF;
  IF NOT COALESCE(p_active, false) THEN RETURN 0; END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at <= v_now THEN RETURN 0; END IF;
  IF p_dropoff_lat IS NULL OR p_dropoff_lng IS NULL OR p_dest_lat IS NULL OR p_dest_lng IS NULL THEN
    RETURN 0;
  END IF;
  IF abs(p_dropoff_lat) > 90 OR abs(p_dropoff_lng) > 180
     OR abs(p_dest_lat) > 90 OR abs(p_dest_lng) > 180 THEN
    RETURN 0;
  END IF;
  IF (p_dest_lat = 0 AND p_dest_lng = 0) THEN RETURN 0; END IF;

  -- Bonus only when dropoff is reasonably near dest (arrival-scale), not a 3km radius filter.
  v_dist := public.haversine_meters(p_dropoff_lat, p_dropoff_lng, p_dest_lat, p_dest_lng);
  IF v_dist IS NULL OR v_dist > GREATEST(COALESCE(p_tolerance_meters, 200), 0) + 1500 THEN
    RETURN 0;
  END IF;

  RETURN GREATEST(LEAST(COALESCE(p_priority_weight, 12), 100), 0);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Clear filter helper (shared by clear / complete / expire)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.towards_destination_clear_filter(p_driver_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.driver_settings
  SET towards_destination_active = false,
      towards_destination_address = NULL,
      towards_destination_lat = NULL,
      towards_destination_lng = NULL,
      towards_destination_postcode = NULL,
      towards_destination_place_id = NULL,
      towards_destination_activated_at = NULL,
      towards_destination_expires_at = NULL,
      towards_destination_session_id = NULL,
      updated_at = now()
  WHERE driver_id = p_driver_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Idempotent completion (destination_reached) — consumes one usage
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.towards_destination_complete_session(
  p_session_id uuid,
  p_reason text DEFAULT 'destination_reached'
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.towards_destination_sessions%ROWTYPE;
  v_sa uuid;
  v_cfg jsonb;
  v_usage jsonb;
  v_consume boolean := (p_reason = 'destination_reached');
BEGIN
  SELECT * INTO v_row
  FROM public.towards_destination_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;

  -- Idempotent: already completed with usage — still clear any stale filter.
  IF v_row.status = 'completed'
     AND v_row.completion_reason = 'destination_reached'
     AND v_row.usage_consumed = true THEN
    PERFORM public.towards_destination_clear_filter(v_row.driver_id);
    SELECT COALESCE(d.service_area_id, (
      SELECT dsa.service_area_id FROM public.driver_service_areas dsa
      WHERE dsa.driver_id = v_row.driver_id ORDER BY dsa.created_at NULLS LAST LIMIT 1
    )) INTO v_sa FROM public.drivers d WHERE d.id = v_row.driver_id;
    v_cfg := public.towards_destination_resolve_config(v_sa);
    v_usage := public.towards_destination_usage_snapshot(v_row.driver_id, (v_cfg->>'limit')::integer);
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'usage', v_usage);
  END IF;

  IF v_row.status <> 'active' THEN
    -- Stale filter may still point at a cancelled/expired session — clear it.
    PERFORM public.towards_destination_clear_filter(v_row.driver_id);
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_active', 'status', v_row.status);
  END IF;

  UPDATE public.towards_destination_sessions
  SET status = CASE WHEN v_consume THEN 'completed' ELSE 'cancelled' END,
      completion_reason = p_reason,
      completed_at = CASE WHEN v_consume THEN now() ELSE completed_at END,
      cancelled_at = CASE WHEN NOT v_consume THEN now() ELSE cancelled_at END,
      usage_consumed = v_consume,
      updated_at = now()
  WHERE id = p_session_id
    AND status = 'active';

  PERFORM public.towards_destination_clear_filter(v_row.driver_id);

  SELECT COALESCE(d.service_area_id, (
    SELECT dsa.service_area_id FROM public.driver_service_areas dsa
    WHERE dsa.driver_id = v_row.driver_id ORDER BY dsa.created_at NULLS LAST LIMIT 1
  )) INTO v_sa FROM public.drivers d WHERE d.id = v_row.driver_id;
  v_cfg := public.towards_destination_resolve_config(v_sa);
  v_usage := public.towards_destination_usage_snapshot(v_row.driver_id, (v_cfg->>'limit')::integer);

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'status', CASE WHEN v_consume THEN 'completed' ELSE 'cancelled' END,
    'reason', p_reason,
    'usage', v_usage
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- Arrival check from live location
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.towards_destination_maybe_complete_on_location(
  p_driver_id uuid,
  p_lat double precision,
  p_lng double precision
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_settings public.driver_settings%ROWTYPE;
  v_sa uuid;
  v_cfg jsonb;
  v_usage jsonb;
  v_arrival integer;
  v_dist numeric;
  v_session_id uuid;
BEGIN
  IF p_driver_id IS NULL OR p_lat IS NULL OR p_lng IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_args');
  END IF;

  SELECT * INTO v_settings FROM public.driver_settings WHERE driver_id = p_driver_id;
  IF NOT FOUND OR NOT COALESCE(v_settings.towards_destination_active, false) THEN
    RETURN jsonb_build_object('ok', true, 'active', false);
  END IF;

  IF v_settings.towards_destination_expires_at IS NOT NULL
     AND v_settings.towards_destination_expires_at <= now() THEN
    -- Expire without consuming usage
    IF v_settings.towards_destination_session_id IS NOT NULL THEN
      PERFORM public.towards_destination_complete_session(
        v_settings.towards_destination_session_id, 'expired'
      );
    ELSE
      PERFORM public.towards_destination_clear_filter(p_driver_id);
    END IF;
    RETURN jsonb_build_object('ok', true, 'expired', true);
  END IF;

  IF v_settings.towards_destination_lat IS NULL OR v_settings.towards_destination_lng IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'active', true, 'reached', false);
  END IF;

  SELECT COALESCE(d.service_area_id, (
    SELECT dsa.service_area_id FROM public.driver_service_areas dsa
    WHERE dsa.driver_id = p_driver_id ORDER BY dsa.created_at NULLS LAST LIMIT 1
  )) INTO v_sa FROM public.drivers d WHERE d.id = p_driver_id;

  v_cfg := public.towards_destination_resolve_config(v_sa);
  v_arrival := GREATEST(COALESCE((v_cfg->>'arrival_radius_meters')::integer, 500), 0);
  v_dist := public.haversine_meters(
    p_lat, p_lng,
    v_settings.towards_destination_lat,
    v_settings.towards_destination_lng
  );

  IF v_dist IS NULL OR v_dist > v_arrival THEN
    RETURN jsonb_build_object(
      'ok', true,
      'active', true,
      'reached', false,
      'distance_meters', v_dist,
      'arrival_radius_meters', v_arrival
    );
  END IF;

  v_session_id := v_settings.towards_destination_session_id;
  IF v_session_id IS NULL THEN
    -- Recover session by active row if filter out of sync
    SELECT id INTO v_session_id
    FROM public.towards_destination_sessions
    WHERE driver_id = p_driver_id AND status = 'active'
    ORDER BY activated_at DESC
    LIMIT 1;
  END IF;

  IF v_session_id IS NULL THEN
    -- Corrupt filter with no session row: clear always. Only synthesize a
    -- destination_reached completion (and consume usage) when under the limit.
    v_usage := public.towards_destination_usage_snapshot(
      p_driver_id, (v_cfg->>'limit')::integer
    );
    IF COALESCE((v_usage->>'remaining')::integer, 0) <= 0 THEN
      PERFORM public.towards_destination_clear_filter(p_driver_id);
      RETURN jsonb_build_object(
        'ok', true,
        'reached', true,
        'usage_consumed', false,
        'reason', 'limit_already_reached',
        'usage', v_usage
      );
    END IF;

    INSERT INTO public.towards_destination_sessions (
      driver_id, status, completion_reason, address, postcode, place_id,
      dest_lat, dest_lng, activated_at, expires_at, completed_at, usage_consumed
    ) VALUES (
      p_driver_id, 'completed', 'destination_reached',
      COALESCE(v_settings.towards_destination_address, 'destination'),
      v_settings.towards_destination_postcode,
      v_settings.towards_destination_place_id,
      v_settings.towards_destination_lat,
      v_settings.towards_destination_lng,
      COALESCE(v_settings.towards_destination_activated_at, now()),
      v_settings.towards_destination_expires_at,
      now(), true
    )
    RETURNING id INTO v_session_id;
    PERFORM public.towards_destination_clear_filter(p_driver_id);
    RETURN jsonb_build_object(
      'ok', true,
      'reached', true,
      'session_id', v_session_id,
      'usage', public.towards_destination_usage_snapshot(
        p_driver_id, (v_cfg->>'limit')::integer
      )
    );
  END IF;

  RETURN public.towards_destination_complete_session(v_session_id, 'destination_reached');
END;
$function$;

CREATE OR REPLACE FUNCTION public.towards_destination_presence_arrival_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.lat IS NOT NULL AND NEW.lng IS NOT NULL THEN
    PERFORM public.towards_destination_maybe_complete_on_location(NEW.driver_id, NEW.lat, NEW.lng);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_td_arrival_on_presence ON public.driver_presence;
CREATE TRIGGER trg_td_arrival_on_presence
AFTER INSERT OR UPDATE OF lat, lng ON public.driver_presence
FOR EACH ROW
WHEN (NEW.lat IS NOT NULL AND NEW.lng IS NOT NULL)
EXECUTE FUNCTION public.towards_destination_presence_arrival_trigger();

-- Also hook update_driver_location (auth driver path)
CREATE OR REPLACE FUNCTION public.update_driver_location(
  p_driver_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_heading double precision DEFAULT NULL::double precision,
  p_speed double precision DEFAULT NULL::double precision
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result json;
BEGIN
  UPDATE public.drivers
  SET
    current_lat = p_lat,
    current_lng = p_lng,
    heading = p_heading,
    speed = p_speed,
    last_location_updated_at = now(),
    updated_at = now()
  WHERE id = p_driver_id
    AND user_id = auth.uid()
  RETURNING json_build_object(
    'id', id,
    'current_lat', current_lat,
    'current_lng', current_lng,
    'last_location_updated_at', last_location_updated_at
  ) INTO v_result;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'Driver not found or unauthorized';
  END IF;

  PERFORM public.towards_destination_maybe_complete_on_location(p_driver_id, p_lat, p_lng);

  RETURN v_result;
END;
$function$;

-- Disable calendar-day reset trigger (legacy counter no longer authoritative)
DROP TRIGGER IF EXISTS reset_destination_uses_trigger ON public.driver_settings;

-- ---------------------------------------------------------------------------
-- GET / SET / CLEAR driver RPCs
-- ---------------------------------------------------------------------------
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
  v_usage jsonb;
  v_active boolean;
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
  v_usage := public.towards_destination_usage_snapshot(v_driver_id, (v_cfg->>'limit')::integer);

  SELECT * INTO v_row FROM public.driver_settings WHERE driver_id = v_driver_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'active', false,
      'saved_destinations', '[]'::jsonb,
      'enabled', (v_cfg->>'enabled')::boolean,
      'duration_minutes', (v_cfg->>'duration_minutes')::integer,
      'arrival_radius_meters', (v_cfg->>'arrival_radius_meters')::integer,
      'usage', v_usage,
      -- Legacy aliases (remaining = rolling remaining)
      'uses_today', (v_usage->>'completed_last_24h')::integer,
      'remaining_uses_today', (v_usage->>'remaining')::integer,
      'daily_limit', (v_usage->>'limit')::integer,
      'window_type', 'rolling_24_hours'
    );
  END IF;

  v_active := COALESCE(v_row.towards_destination_active, false);
  IF v_active AND v_row.towards_destination_expires_at IS NOT NULL
     AND v_row.towards_destination_expires_at <= now() THEN
    IF v_row.towards_destination_session_id IS NOT NULL THEN
      PERFORM public.towards_destination_complete_session(v_row.towards_destination_session_id, 'expired');
    ELSE
      PERFORM public.towards_destination_clear_filter(v_driver_id);
    END IF;
    v_active := false;
    v_usage := public.towards_destination_usage_snapshot(v_driver_id, (v_cfg->>'limit')::integer);
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'active', v_active,
    'address', CASE WHEN v_active THEN v_row.towards_destination_address ELSE NULL END,
    'postcode', CASE WHEN v_active THEN v_row.towards_destination_postcode ELSE NULL END,
    'place_id', CASE WHEN v_active THEN v_row.towards_destination_place_id ELSE NULL END,
    'lat', CASE WHEN v_active THEN v_row.towards_destination_lat ELSE NULL END,
    'lng', CASE WHEN v_active THEN v_row.towards_destination_lng ELSE NULL END,
    'session_id', CASE WHEN v_active THEN v_row.towards_destination_session_id ELSE NULL END,
    'enabled', (v_cfg->>'enabled')::boolean,
    'expires_at', CASE WHEN v_active THEN v_row.towards_destination_expires_at ELSE NULL END,
    'activated_at', CASE WHEN v_active THEN v_row.towards_destination_activated_at ELSE NULL END,
    'duration_minutes', (v_cfg->>'duration_minutes')::integer,
    'arrival_radius_meters', (v_cfg->>'arrival_radius_meters')::integer,
    'usage', v_usage,
    'uses_today', (v_usage->>'completed_last_24h')::integer,
    'remaining_uses_today', (v_usage->>'remaining')::integer,
    'daily_limit', (v_usage->>'limit')::integer,
    'window_type', 'rolling_24_hours',
    'saved_destinations', COALESCE(v_row.saved_destinations, '[]'::jsonb)
  );
END;
$function$;

-- Drop legacy 3-arg overload so optional postcode/place_id defaults apply to one signature.
DROP FUNCTION IF EXISTS public.set_driver_own_towards_destination(text, double precision, double precision);

CREATE OR REPLACE FUNCTION public.set_driver_own_towards_destination(
  p_address text,
  p_lat double precision,
  p_lng double precision,
  p_postcode text DEFAULT NULL,
  p_place_id text DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_sa uuid;
  v_cfg jsonb;
  v_usage jsonb;
  v_limit integer;
  v_duration integer;
  v_arrival integer;
  v_activated_at timestamptz := now();
  v_expires_at timestamptz;
  v_session_id uuid;
  v_driver_lat double precision;
  v_driver_lng double precision;
  v_dist numeric;
  v_prev uuid;
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
  )),
  COALESCE(dp.lat, d.current_lat),
  COALESCE(dp.lng, d.current_lng)
  INTO v_sa, v_driver_lat, v_driver_lng
  FROM public.drivers d
  LEFT JOIN public.driver_presence dp ON dp.driver_id = d.id
  WHERE d.id = v_driver_id;

  v_cfg := public.towards_destination_resolve_config(v_sa);
  IF NOT COALESCE((v_cfg->>'enabled')::boolean, true) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'feature_disabled');
  END IF;

  v_limit := GREATEST(COALESCE((v_cfg->>'limit')::integer, 5), 0);
  v_duration := GREATEST(COALESCE((v_cfg->>'duration_minutes')::integer, 60), 5);
  v_arrival := GREATEST(COALESCE((v_cfg->>'arrival_radius_meters')::integer, 500), 0);
  v_expires_at := v_activated_at + make_interval(mins => v_duration);
  v_usage := public.towards_destination_usage_snapshot(v_driver_id, v_limit);

  -- Same-location protection: already inside arrival radius → reject, no session, no usage
  IF v_driver_lat IS NOT NULL AND v_driver_lng IS NOT NULL THEN
    v_dist := public.haversine_meters(v_driver_lat, v_driver_lng, p_lat, p_lng);
    IF v_dist IS NOT NULL AND v_dist <= v_arrival THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'destination_already_reached',
        'title', 'Choose another destination',
        'message', 'You are already near this destination. Please choose a destination farther away.',
        'usage', v_usage,
        'distance_meters', v_dist,
        'arrival_radius_meters', v_arrival,
        'remaining_uses_today', (v_usage->>'remaining')::integer,
        'daily_limit', v_limit
      );
    END IF;
  END IF;

  IF (v_usage->>'remaining')::integer <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'daily_limit_reached',
      'title', 'Trips towards destination',
      'message', format(
        'You''ve used all %s towards-destination sessions in the last 24 hours. Try again later or contact support.',
        v_limit
      ),
      'usage', v_usage,
      'uses_today', (v_usage->>'completed_last_24h')::integer,
      'remaining_uses_today', 0,
      'daily_limit', v_limit,
      'window_type', 'rolling_24_hours',
      'next_available_at', v_usage->'next_available_at'
    );
  END IF;

  -- Cancel any previous active session without consuming usage
  SELECT id INTO v_prev
  FROM public.towards_destination_sessions
  WHERE driver_id = v_driver_id AND status = 'active'
  LIMIT 1;
  IF v_prev IS NOT NULL THEN
    PERFORM public.towards_destination_complete_session(v_prev, 'replaced');
  END IF;

  INSERT INTO public.towards_destination_sessions (
    driver_id, status, address, postcode, place_id,
    dest_lat, dest_lng, activated_at, expires_at, usage_consumed
  ) VALUES (
    v_driver_id, 'active', trim(p_address),
    NULLIF(trim(COALESCE(p_postcode, '')), ''),
    NULLIF(trim(COALESCE(p_place_id, '')), ''),
    p_lat, p_lng, v_activated_at, v_expires_at, false
  )
  RETURNING id INTO v_session_id;

  INSERT INTO public.driver_settings AS ds (
    driver_id,
    towards_destination_active,
    towards_destination_address,
    towards_destination_postcode,
    towards_destination_place_id,
    towards_destination_lat,
    towards_destination_lng,
    towards_destination_activated_at,
    towards_destination_expires_at,
    towards_destination_session_id
  ) VALUES (
    v_driver_id,
    true,
    trim(p_address),
    NULLIF(trim(COALESCE(p_postcode, '')), ''),
    NULLIF(trim(COALESCE(p_place_id, '')), ''),
    p_lat,
    p_lng,
    v_activated_at,
    v_expires_at,
    v_session_id
  )
  ON CONFLICT (driver_id) DO UPDATE SET
    towards_destination_active = true,
    towards_destination_address = EXCLUDED.towards_destination_address,
    towards_destination_postcode = EXCLUDED.towards_destination_postcode,
    towards_destination_place_id = EXCLUDED.towards_destination_place_id,
    towards_destination_lat = EXCLUDED.towards_destination_lat,
    towards_destination_lng = EXCLUDED.towards_destination_lng,
    towards_destination_activated_at = EXCLUDED.towards_destination_activated_at,
    towards_destination_expires_at = EXCLUDED.towards_destination_expires_at,
    towards_destination_session_id = EXCLUDED.towards_destination_session_id,
    updated_at = now();

  -- Refresh usage (unchanged by activate)
  v_usage := public.towards_destination_usage_snapshot(v_driver_id, v_limit);

  RETURN jsonb_build_object(
    'ok', true,
    'active', true,
    'session_id', v_session_id,
    'address', trim(p_address),
    'postcode', NULLIF(trim(COALESCE(p_postcode, '')), ''),
    'place_id', NULLIF(trim(COALESCE(p_place_id, '')), ''),
    'lat', p_lat,
    'lng', p_lng,
    'activated_at', v_activated_at,
    'expires_at', v_expires_at,
    'duration_minutes', v_duration,
    'enabled', true,
    'usage', v_usage,
    'uses_today', (v_usage->>'completed_last_24h')::integer,
    'remaining_uses_today', (v_usage->>'remaining')::integer,
    'daily_limit', v_limit,
    'window_type', 'rolling_24_hours',
    'arrival_radius_meters', v_arrival
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
  v_usage jsonb;
  v_session_id uuid;
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

  SELECT towards_destination_session_id INTO v_session_id
  FROM public.driver_settings WHERE driver_id = v_driver_id;

  IF v_session_id IS NULL THEN
    SELECT id INTO v_session_id
    FROM public.towards_destination_sessions
    WHERE driver_id = v_driver_id AND status = 'active'
    ORDER BY activated_at DESC LIMIT 1;
  END IF;

  IF v_session_id IS NOT NULL THEN
    PERFORM public.towards_destination_complete_session(v_session_id, 'manual_clear');
  END IF;
  -- Always clear filter (complete_session already clears on success; this covers stale rows).
  PERFORM public.towards_destination_clear_filter(v_driver_id);

  v_usage := public.towards_destination_usage_snapshot(v_driver_id, (v_cfg->>'limit')::integer);

  RETURN jsonb_build_object(
    'ok', true,
    'active', false,
    'usage', v_usage,
    'uses_today', (v_usage->>'completed_last_24h')::integer,
    'remaining_uses_today', (v_usage->>'remaining')::integer,
    'daily_limit', (v_usage->>'limit')::integer,
    'window_type', 'rolling_24_hours'
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.towards_destination_usage_snapshot(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_trip_qualifies(
  double precision, double precision, double precision, double precision,
  double precision, double precision, double precision, double precision,
  numeric, numeric, numeric
) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_own_towards_destination() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_driver_own_towards_destination(text, double precision, double precision, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_driver_own_towards_destination() TO authenticated;
