-- Fix Earnings online duration inflation from abandoned overnight sessions.
--
-- BEFORE (bug): carry open go_online from days earlier into Today/Week/Month,
-- so "forgot to go offline" counted ~18h from midnight + multi-day stretches
-- (e.g. 312h/month).
--
-- AFTER:
-- 1) Carry-in only if the open go_online is recent (within 2h of range start).
-- 2) Cap each continuous online stretch at 14h (covers a long shift; stops
--    abandoned multi-day intent from dominating Earnings).

CREATE OR REPLACE FUNCTION public.get_driver_own_online_duration_seconds(
  p_start timestamp with time zone,
  p_end timestamp with time zone
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_online boolean := false;
  v_open_at timestamptz := NULL;
  v_opened_at timestamptz := NULL;
  v_total_secs bigint := 0;
  v_stretch_secs bigint;
  r record;
  -- Carry an in-progress session across the range boundary only if the driver
  -- went online recently (night-shift friendly; rejects abandoned overnight).
  c_carry_max interval := interval '2 hours';
  -- Hard cap per continuous online stretch (intent left on for days).
  c_stretch_cap_secs bigint := 14 * 3600;
BEGIN
  v_driver_id := public.require_authenticated_driver_id();

  IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start THEN
    RETURN 0;
  END IF;

  v_start := p_start;
  v_end := LEAST(p_end, now());
  IF v_end <= v_start THEN
    RETURN 0;
  END IF;

  -- Find whether intent was on entering the range, and when that stretch opened.
  SELECT e.to_intent, e.created_at
  INTO v_online, v_opened_at
  FROM public.driver_availability_events e
  WHERE e.driver_id = v_driver_id
    AND e.created_at < v_start
    AND e.event_type IN ('go_online', 'go_offline')
  ORDER BY e.created_at DESC
  LIMIT 1;

  v_online := COALESCE(v_online, false);

  IF v_online THEN
    -- Opened at the first go_online after the last go_offline before range start.
    SELECT MIN(e.created_at)
    INTO v_opened_at
    FROM public.driver_availability_events e
    WHERE e.driver_id = v_driver_id
      AND e.created_at < v_start
      AND e.event_type IN ('go_online', 'go_offline')
      AND e.to_intent = true
      AND e.created_at > COALESCE(
        (
          SELECT MAX(x.created_at)
          FROM public.driver_availability_events x
          WHERE x.driver_id = v_driver_id
            AND x.created_at < v_start
            AND x.event_type IN ('go_online', 'go_offline')
            AND x.to_intent = false
        ),
        '-infinity'::timestamptz
      );

    IF v_opened_at IS NULL OR (v_start - v_opened_at) > c_carry_max THEN
      v_online := false;
      v_open_at := NULL;
    ELSE
      v_open_at := v_start;
    END IF;
  ELSE
    v_open_at := NULL;
  END IF;

  FOR r IN
    SELECT e.created_at, COALESCE(e.to_intent, false) AS to_intent
    FROM public.driver_availability_events e
    WHERE e.driver_id = v_driver_id
      AND e.created_at >= v_start
      AND e.created_at < v_end
      AND e.event_type IN ('go_online', 'go_offline')
    ORDER BY e.created_at ASC
  LOOP
    IF v_online AND NOT r.to_intent AND v_open_at IS NOT NULL THEN
      v_stretch_secs := GREATEST(
        0,
        (EXTRACT(EPOCH FROM (r.created_at - v_open_at)))::bigint
      );
      v_total_secs := v_total_secs + LEAST(v_stretch_secs, c_stretch_cap_secs);
      v_open_at := NULL;
    END IF;

    IF (NOT v_online) AND r.to_intent THEN
      v_open_at := r.created_at;
    END IF;

    -- Duplicate go_online while already online: keep stretch open (no reset).
    v_online := r.to_intent;
  END LOOP;

  IF v_online AND v_open_at IS NOT NULL THEN
    v_stretch_secs := GREATEST(
      0,
      (EXTRACT(EPOCH FROM (v_end - v_open_at)))::bigint
    );
    v_total_secs := v_total_secs + LEAST(v_stretch_secs, c_stretch_cap_secs);
  END IF;

  RETURN GREATEST(0, v_total_secs)::integer;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_driver_own_online_duration_seconds(
  timestamp with time zone, timestamp with time zone
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_own_online_duration_seconds(
  timestamp with time zone, timestamp with time zone
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_own_online_duration_seconds(
  timestamp with time zone, timestamp with time zone
) TO service_role;
