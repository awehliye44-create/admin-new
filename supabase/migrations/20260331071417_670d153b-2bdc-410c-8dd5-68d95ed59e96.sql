
-- Fix ops_detect_customer_app_issues - explicit text casts
CREATE OR REPLACE FUNCTION ops_detect_customer_app_issues() RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT screen_name, round(avg(metric_value)) as avg_ms, count(*) as cnt,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) as p95_ms
    FROM app_performance_events
    WHERE app_name = 'customer_app' AND created_at >= now() - interval '1 hour'
      AND metric_name IN ('screen_load_time', 'api_latency')
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

-- Fix ops_detect_driver_app_issues
CREATE OR REPLACE FUNCTION ops_detect_driver_app_issues() RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT screen_name, round(avg(metric_value)) as avg_ms, count(*) as cnt,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) as p95_ms
    FROM app_performance_events
    WHERE app_name = 'driver_app' AND created_at >= now() - interval '1 hour'
      AND metric_name IN ('screen_load_time', 'api_latency')
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

-- Fix ops_detect_admin_panel_issues
CREATE OR REPLACE FUNCTION ops_detect_admin_panel_issues() RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT screen_name, round(avg(metric_value)) as avg_ms, count(*) as cnt,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) as p95_ms
    FROM app_performance_events
    WHERE app_name = 'admin_panel' AND created_at >= now() - interval '1 hour'
      AND metric_name IN ('screen_load_time', 'api_latency')
    GROUP BY screen_name
    HAVING avg(metric_value) > 2000
  LOOP
    PERFORM ops_upsert_alert(
      ('admin_panel_slow:' || lower(replace(rec.screen_name, ' ', '_')))::text,
      'system'::text,
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

-- Fix ops_detect_corporate_web_issues
CREATE OR REPLACE FUNCTION ops_detect_corporate_web_issues() RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT screen_name, round(avg(metric_value)) as avg_ms, count(*) as cnt,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) as p95_ms
    FROM app_performance_events
    WHERE app_name = 'corporate_web' AND created_at >= now() - interval '1 hour'
      AND metric_name IN ('screen_load_time', 'api_latency')
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

-- Fix ops_detect_guest_booking_failures
CREATE OR REPLACE FUNCTION ops_detect_guest_booking_failures() RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT screen_name, round(avg(metric_value)) as avg_ms, count(*) as cnt,
      round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value)) as p95_ms
    FROM app_performance_events
    WHERE app_name = 'guest_web' AND created_at >= now() - interval '1 hour'
      AND metric_name IN ('screen_load_time', 'api_latency')
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

-- Fix ops_detect_log_anomalies
CREATE OR REPLACE FUNCTION ops_detect_log_anomalies() RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT source, count(*) as error_count
    FROM ops_logs
    WHERE level IN ('error', 'fatal') AND created_at >= now() - interval '1 hour'
    GROUP BY source
    HAVING count(*) >= 3
  LOOP
    PERFORM ops_upsert_alert(
      ('log_anomaly:' || rec.source)::text,
      'backend'::text,
      (CASE WHEN rec.error_count >= 10 THEN 'critical' ELSE 'warning' END)::text,
      'detection'::text, 'backend'::text,
      ('Error spike: ' || rec.source)::text,
      (rec.error_count || ' errors from ' || rec.source || ' in last hour.')::text,
      p_metadata := jsonb_build_object('source', rec.source, 'error_count', rec.error_count));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('log_anomalies', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('log_anomalies', 0, 'note', 'table not found');
END;
$$;
