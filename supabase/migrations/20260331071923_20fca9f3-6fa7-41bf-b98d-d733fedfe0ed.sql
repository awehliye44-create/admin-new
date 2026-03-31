
-- Fix admin panel detection to use 'admin_panel' category instead of 'system'
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

-- Also add corporate_web to the health cards category list
-- Update existing admin_panel alerts from 'system' to 'admin_panel' category
UPDATE ops_alerts SET category = 'admin_panel' WHERE app = 'admin_panel' AND category = 'system';
