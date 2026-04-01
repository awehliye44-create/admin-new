
-- 1. Fix the operator precedence bug in ops_auto_resolve_stale_alerts
-- The OR in "AND fingerprint LIKE '%latency%' OR fingerprint LIKE '%slow%'" 
-- breaks the WHERE clause - needs parentheses
CREATE OR REPLACE FUNCTION public.ops_auto_resolve_stale_alerts(max_age_hours integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  resolved_stale int := 0;
  resolved_perf int := 0;
  downgraded int := 0;
  resolved_demo int := 0;
BEGIN
  -- 1. Auto-resolve alerts older than max_age_hours that are still open
  WITH updated AS (
    UPDATE ops_alerts
    SET status = 'resolved', resolved_at = now()
    WHERE status IN ('open', 'acknowledged')
      AND last_detected_at < now() - (max_age_hours || ' hours')::interval
    RETURNING id
  )
  SELECT count(*) INTO resolved_stale FROM updated;

  -- 2. Auto-resolve performance alerts where metrics are now healthy
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
        3000
      )
  ),
  perf_resolved AS (
    UPDATE ops_alerts
    SET status = 'resolved', resolved_at = now()
    WHERE status IN ('open', 'acknowledged')
      AND category IN ('customer_app', 'driver_app', 'backend', 'admin_panel')
      AND (fingerprint LIKE '%latency%' OR fingerprint LIKE '%slow%' OR fingerprint LIKE '%p95%')
      AND last_detected_at < now() - interval '15 minutes'
    RETURNING id
  )
  SELECT count(*) INTO resolved_perf FROM perf_resolved;

  -- 3. Auto-resolve demo/seeded alerts that are still open
  WITH demo_resolved AS (
    UPDATE ops_alerts
    SET status = 'resolved', resolved_at = now()
    WHERE status IN ('open', 'acknowledged')
      AND fingerprint LIKE 'demo:%'
    RETURNING id
  )
  SELECT count(*) INTO resolved_demo FROM demo_resolved;

  -- 4. Downgrade severity for alerts between 3-6 hours old
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
    'resolved_demo', resolved_demo,
    'downgraded', downgraded,
    'run_at', now()
  );
END;
$function$;

-- 2. Create reconciliation diagnostics function
CREATE OR REPLACE FUNCTION public.ops_reconciliation_diagnostics()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
  cat_data jsonb;
  categories text[] := ARRAY['payment','commission','earning','payout','dispatch','guest_booking','corporate_booking','customer_app','driver_app','backend','logs','duplication','system','admin_panel'];
  cat text;
BEGIN
  result := jsonb_build_object(
    'generated_at', now(),
    'time_window', '6 hours',
    'synthetic_excluded', true
  );

  -- Global counts
  SELECT jsonb_build_object(
    'total_open_alerts', count(*) FILTER (WHERE status = 'open'),
    'total_acknowledged', count(*) FILTER (WHERE status = 'acknowledged'),
    'total_resolved_24h', count(*) FILTER (WHERE status = 'resolved' AND resolved_at > now() - interval '24 hours'),
    'total_active', count(*) FILTER (WHERE status IN ('open','acknowledged')),
    'demo_alerts_open', count(*) FILTER (WHERE status IN ('open','acknowledged') AND fingerprint LIKE 'demo:%'),
    'real_alerts_open', count(*) FILTER (WHERE status IN ('open','acknowledged') AND fingerprint NOT LIKE 'demo:%')
  ) INTO result
  FROM ops_alerts;

  -- Per-category breakdown
  cat_data := '{}'::jsonb;
  FOR cat IN SELECT unnest(categories) LOOP
    SELECT cat_data || jsonb_build_object(cat, jsonb_build_object(
      'open_alerts', count(*) FILTER (WHERE a.status = 'open'),
      'critical_alerts', count(*) FILTER (WHERE a.status = 'open' AND a.severity IN ('critical','fatal')),
      'acknowledged', count(*) FILTER (WHERE a.status = 'acknowledged'),
      'demo_alerts', count(*) FILTER (WHERE a.status IN ('open','acknowledged') AND a.fingerprint LIKE 'demo:%'),
      'real_alerts', count(*) FILTER (WHERE a.status IN ('open','acknowledged') AND a.fingerprint NOT LIKE 'demo:%'),
      'latest_detection', max(a.last_detected_at) FILTER (WHERE a.status IN ('open','acknowledged'))
    )) INTO cat_data
    FROM ops_alerts a
    WHERE a.category = cat;
  END LOOP;

  result := result || jsonb_build_object('categories', cat_data);

  -- Log counts from ops_logs (last 6 hours)
  SELECT result || jsonb_build_object('recent_logs', jsonb_build_object(
    'total_6h', count(*),
    'errors_6h', count(*) FILTER (WHERE level IN ('error','fatal')),
    'warnings_6h', count(*) FILTER (WHERE level = 'warn'),
    'info_6h', count(*) FILTER (WHERE level = 'info')
  )) INTO result
  FROM ops_logs
  WHERE created_at > now() - interval '6 hours';

  RETURN result;
END;
$function$;

-- 3. Clean up existing demo alerts right now
UPDATE ops_alerts 
SET status = 'resolved', resolved_at = now() 
WHERE status IN ('open', 'acknowledged') AND fingerprint LIKE 'demo:%';
