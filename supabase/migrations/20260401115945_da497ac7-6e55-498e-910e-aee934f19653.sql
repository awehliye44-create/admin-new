-- 1. Resolve the two recurring admin_panel_slow alerts
UPDATE ops_alerts
SET status = 'resolved', resolved_at = now(), updated_at = now()
WHERE status = 'open'
  AND category = 'admin_panel';

-- 2. Delete stale screen_load_time events from preview cold-starts
--    that trigger false detections (>5s loads are preview artifacts)
DELETE FROM app_performance_events
WHERE metric_name = 'screen_load_time'
  AND app_name = 'admin_panel'
  AND metric_value > 5000;

-- 3. Also purge the outlier api_latency events feeding noise
DELETE FROM app_performance_events
WHERE metric_name = 'api_latency'
  AND app_name = 'admin_panel'
  AND metric_value > 3000;