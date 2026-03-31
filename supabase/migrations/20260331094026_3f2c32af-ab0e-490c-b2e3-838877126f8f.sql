
-- 1. Add is_synthetic column
ALTER TABLE app_performance_events ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false;

-- 2. Tag all existing demo data as synthetic
UPDATE app_performance_events SET is_synthetic = true WHERE session_id LIKE 'demo-%';

-- 3. Recreate app_health_summary view to exclude synthetic data
CREATE OR REPLACE VIEW app_health_summary AS
SELECT
  app_name,
  screen_name,
  metric_name,
  count(*) AS event_count,
  round(avg(metric_value)) AS avg_ms,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY metric_value)) AS median_ms,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) AS p95_ms,
  round(percentile_cont(0.99) WITHIN GROUP (ORDER BY metric_value)) AS p99_ms,
  round(min(metric_value)) AS min_ms,
  round(max(metric_value)) AS max_ms,
  max(created_at) AS last_event_at
FROM app_performance_events
WHERE created_at >= (now() - interval '1 hour')
  AND is_synthetic = false
GROUP BY app_name, screen_name, metric_name;

-- 4. Update ALL 5 detection functions to exclude synthetic data

CREATE OR REPLACE FUNCTION ops_detect_customer_app_issues() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT screen_name, round(avg(metric_value)) as avg_ms, count(*) as cnt,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) as p95_ms
    FROM app_performance_events
    WHERE app_name = 'customer_app' AND created_at >= now() - interval '1 hour'
      AND metric_name IN ('screen_load_time', 'api_latency')
      AND is_synthetic = false
    GROUP BY screen_name
    HAVING avg(metric_value) > 3000
  LOOP
    PERFORM ops_upsert_alert(
      ('customer_app_slow:' || lower(replace(rec.screen_name, ' ', '_')))::text,
      'customer_app'::text,
      (CASE WHEN rec.p95_ms > 8000 THEN 'critical' ELSE 'warning' END)::text,
      'detection'::text, 'customer_app'::text,
      ('Slow customer screen: ' || rec.screen_name)::text,
      ('Avg ' || rec.avg_ms || 'ms, P95 ' || rec.p95_ms || 'ms over ' || rec.cnt || ' events in last hour.')::text,
      p_metadata := jsonb_build_object('screen', rec.screen_name, 'avg_ms', rec.avg_ms, 'p95_ms', rec.p95_ms, 'count', rec.cnt));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('customer_app_issues', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('customer_app_issues', 0, 'note', 'table not found');
END;
$$;

CREATE OR REPLACE FUNCTION ops_detect_driver_app_issues() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT screen_name, round(avg(metric_value)) as avg_ms, count(*) as cnt,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) as p95_ms
    FROM app_performance_events
    WHERE app_name = 'driver_app' AND created_at >= now() - interval '1 hour'
      AND metric_name IN ('screen_load_time', 'api_latency')
      AND is_synthetic = false
    GROUP BY screen_name
    HAVING avg(metric_value) > 3000
  LOOP
    PERFORM ops_upsert_alert(
      ('driver_app_slow:' || lower(replace(rec.screen_name, ' ', '_')))::text,
      'driver_app'::text,
      (CASE WHEN rec.p95_ms > 8000 THEN 'critical' ELSE 'warning' END)::text,
      'detection'::text, 'driver_app'::text,
      ('Slow driver screen: ' || rec.screen_name)::text,
      ('Avg ' || rec.avg_ms || 'ms, P95 ' || rec.p95_ms || 'ms over ' || rec.cnt || ' events in last hour.')::text,
      p_metadata := jsonb_build_object('screen', rec.screen_name, 'avg_ms', rec.avg_ms, 'p95_ms', rec.p95_ms, 'count', rec.cnt));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('driver_app_issues', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('driver_app_issues', 0, 'note', 'table not found');
END;
$$;

CREATE OR REPLACE FUNCTION ops_detect_admin_panel_issues() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT screen_name, round(avg(metric_value)) as avg_ms, count(*) as cnt,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) as p95_ms
    FROM app_performance_events
    WHERE app_name = 'admin_panel' AND created_at >= now() - interval '1 hour'
      AND metric_name IN ('screen_load_time', 'api_latency')
      AND is_synthetic = false
    GROUP BY screen_name
    HAVING avg(metric_value) > 2000
  LOOP
    PERFORM ops_upsert_alert(
      ('admin_panel_slow:' || lower(replace(rec.screen_name, ' ', '_')))::text,
      'admin_panel'::text,
      (CASE WHEN rec.p95_ms > 5000 THEN 'critical' ELSE 'warning' END)::text,
      'detection'::text, 'admin_panel'::text,
      ('Admin Panel Slow: ' || rec.screen_name)::text,
      ('Avg ' || rec.avg_ms || 'ms, P95 ' || rec.p95_ms || 'ms over ' || rec.cnt || ' events.')::text,
      p_metadata := jsonb_build_object('screen', rec.screen_name, 'avg_ms', rec.avg_ms, 'p95_ms', rec.p95_ms, 'count', rec.cnt));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('admin_panel_issues', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('admin_panel_issues', 0, 'note', 'table not found');
END;
$$;

CREATE OR REPLACE FUNCTION ops_detect_guest_booking_failures() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT screen_name, round(avg(metric_value)) as avg_ms, count(*) as cnt,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) as p95_ms
    FROM app_performance_events
    WHERE app_name = 'guest_web' AND created_at >= now() - interval '1 hour'
      AND metric_name IN ('screen_load_time', 'api_latency')
      AND is_synthetic = false
    GROUP BY screen_name
    HAVING avg(metric_value) > 3000
  LOOP
    PERFORM ops_upsert_alert(
      ('guest_web_slow:' || lower(replace(rec.screen_name, ' ', '_')))::text,
      'guest_booking'::text,
      (CASE WHEN rec.p95_ms > 8000 THEN 'critical' ELSE 'warning' END)::text,
      'detection'::text, 'guest'::text,
      ('Slow guest screen: ' || rec.screen_name)::text,
      ('Avg ' || rec.avg_ms || 'ms, P95 ' || rec.p95_ms || 'ms over ' || rec.cnt || ' events.')::text,
      p_metadata := jsonb_build_object('screen', rec.screen_name, 'avg_ms', rec.avg_ms, 'p95_ms', rec.p95_ms, 'count', rec.cnt));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('guest_booking_issues', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('guest_booking_issues', 0, 'note', 'table not found');
END;
$$;

CREATE OR REPLACE FUNCTION ops_detect_corporate_web_issues() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT screen_name, round(avg(metric_value)) as avg_ms, count(*) as cnt,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) as p95_ms
    FROM app_performance_events
    WHERE app_name = 'corporate_web' AND created_at >= now() - interval '1 hour'
      AND metric_name IN ('screen_load_time', 'api_latency')
      AND is_synthetic = false
    GROUP BY screen_name
    HAVING avg(metric_value) > 3000
  LOOP
    PERFORM ops_upsert_alert(
      ('corporate_web_slow:' || lower(replace(rec.screen_name, ' ', '_')))::text,
      'corporate_web'::text,
      (CASE WHEN rec.p95_ms > 8000 THEN 'critical' ELSE 'warning' END)::text,
      'detection'::text, 'corporate_web'::text,
      ('Slow corporate screen: ' || rec.screen_name)::text,
      ('Avg ' || rec.avg_ms || 'ms, P95 ' || rec.p95_ms || 'ms over ' || rec.cnt || ' events.')::text,
      p_metadata := jsonb_build_object('screen', rec.screen_name, 'avg_ms', rec.avg_ms, 'p95_ms', rec.p95_ms, 'count', rec.cnt));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('corporate_web_issues', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('corporate_web_issues', 0, 'note', 'table not found');
END;
$$;

-- 5. Add index for the is_synthetic filter
CREATE INDEX IF NOT EXISTS idx_perf_events_not_synthetic 
ON app_performance_events (app_name, created_at) 
WHERE is_synthetic = false;
