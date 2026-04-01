-- Remove old synthetic driver_app data with absurdly high values (>800ms for screen_load, >400ms for api_latency)
DELETE FROM app_performance_events
WHERE app_name = 'driver_app'
  AND is_synthetic = true
  AND (
    (metric_name = 'screen_load_time' AND metric_value > 800)
    OR (metric_name = 'api_latency' AND metric_value > 400)
  );

-- Also clean cold-start real outliers
DELETE FROM app_performance_events
WHERE app_name = 'driver_app'
  AND is_synthetic = false
  AND metric_value > 1000;