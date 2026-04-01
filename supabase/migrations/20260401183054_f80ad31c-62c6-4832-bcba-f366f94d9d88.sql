-- Drop and recreate the app_health_summary view with a 24-hour window
CREATE OR REPLACE VIEW public.app_health_summary AS
SELECT
  app_name,
  screen_name,
  metric_name,
  count(*) AS event_count,
  round(avg(metric_value)) AS avg_ms,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY metric_value::double precision)) AS median_ms,
  round(percentile_cont(0.95) WITHIN GROUP (ORDER BY metric_value::double precision)) AS p95_ms,
  round(percentile_cont(0.99) WITHIN GROUP (ORDER BY metric_value::double precision)) AS p99_ms,
  round(min(metric_value)) AS min_ms,
  round(max(metric_value)) AS max_ms,
  max(created_at) AS last_event_at
FROM app_performance_events
WHERE created_at >= (now() - interval '24 hours')
  AND is_synthetic = false
GROUP BY app_name, screen_name, metric_name;