-- Driver Earnings: own online duration for period stats (Online time / Avg per hour).
-- Sums go_online → go_offline intent intervals from driver_availability_events.
-- Fail-closed: returns 0 on bad range / no driver.

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
  v_cursor timestamptz;
  v_online boolean := false;
  v_total_ms bigint := 0;
  r record;
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

  SELECT COALESCE(e.to_intent, false)
  INTO v_online
  FROM public.driver_availability_events e
  WHERE e.driver_id = v_driver_id
    AND e.created_at < v_start
    AND e.event_type IN ('go_online', 'go_offline')
  ORDER BY e.created_at DESC
  LIMIT 1;

  v_online := COALESCE(v_online, false);
  v_cursor := v_start;

  FOR r IN
    SELECT e.created_at, COALESCE(e.to_intent, false) AS to_intent
    FROM public.driver_availability_events e
    WHERE e.driver_id = v_driver_id
      AND e.created_at >= v_start
      AND e.created_at < v_end
      AND e.event_type IN ('go_online', 'go_offline')
    ORDER BY e.created_at ASC
  LOOP
    IF v_online THEN
      v_total_ms := v_total_ms + GREATEST(
        0,
        (EXTRACT(EPOCH FROM (r.created_at - v_cursor)) * 1000)::bigint
      );
    END IF;
    v_online := r.to_intent;
    v_cursor := r.created_at;
  END LOOP;

  IF v_online THEN
    v_total_ms := v_total_ms + GREATEST(
      0,
      (EXTRACT(EPOCH FROM (v_end - v_cursor)) * 1000)::bigint
    );
  END IF;

  RETURN GREATEST(0, (v_total_ms / 1000)::integer);
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
