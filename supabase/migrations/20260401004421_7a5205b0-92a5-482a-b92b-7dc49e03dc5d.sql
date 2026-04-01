
-- Auto-resolve stale alerts function
-- Resolves alerts that are older than a configurable window (default 6 hours)
-- and auto-resolves performance alerts when P95 metrics are now healthy
CREATE OR REPLACE FUNCTION public.ops_auto_resolve_stale_alerts(
  max_age_hours int DEFAULT 6
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  resolved_stale int := 0;
  resolved_perf int := 0;
  downgraded int := 0;
BEGIN
  -- 1. Auto-resolve alerts older than max_age_hours that are still open
  WITH updated AS (
    UPDATE ops_alerts
    SET status = 'resolved',
        resolved_at = now()
    WHERE status IN ('open', 'acknowledged')
      AND last_detected_at < now() - (max_age_hours || ' hours')::interval
    RETURNING id
  )
  SELECT count(*) INTO resolved_stale FROM updated;

  -- 2. Auto-resolve performance alerts where P95 is now healthy
  -- Check app_performance_events from the last 15 minutes
  -- If all recent metrics are below warning thresholds, resolve the alert
  WITH healthy_screens AS (
    SELECT e.app_name, e.screen_name, e.metric_name,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY e.metric_value) AS p95
    FROM app_performance_events e
    WHERE e.created_at > now() - interval '15 minutes'
      AND e.is_synthetic = false
    GROUP BY e.app_name, e.screen_name, e.metric_name
    HAVING percentile_cont(0.95) WITHIN GROUP (ORDER BY e.metric_value) <
      COALESCE(
        (SELECT t.warning_threshold FROM app_performance_thresholds t
         WHERE t.app_name = e.app_name AND t.metric_name = e.metric_name
           AND (t.screen_name IS NULL OR t.screen_name = e.screen_name)
           AND t.is_active = true
         LIMIT 1),
        3000 -- default 3s threshold
      )
  ),
  perf_resolved AS (
    UPDATE ops_alerts
    SET status = 'resolved',
        resolved_at = now()
    WHERE status IN ('open', 'acknowledged')
      AND category IN ('customer_app', 'driver_app', 'backend', 'admin_panel')
      AND fingerprint LIKE '%latency%' OR fingerprint LIKE '%slow%' OR fingerprint LIKE '%p95%'
      AND last_detected_at < now() - interval '15 minutes'
    RETURNING id
  )
  SELECT count(*) INTO resolved_perf FROM perf_resolved;

  -- 3. Downgrade severity for alerts between 3-6 hours old (critical -> warning)
  WITH dg AS (
    UPDATE ops_alerts
    SET severity = 'warning',
        metadata = metadata || '{"auto_downgraded": true}'::jsonb
    WHERE status = 'open'
      AND severity IN ('critical', 'fatal')
      AND last_detected_at < now() - interval '3 hours'
      AND last_detected_at >= now() - (max_age_hours || ' hours')::interval
    RETURNING id
  )
  SELECT count(*) INTO downgraded FROM dg;

  RETURN jsonb_build_object(
    'resolved_stale', resolved_stale,
    'resolved_perf', resolved_perf,
    'downgraded', downgraded,
    'run_at', now()
  );
END;
$$;
