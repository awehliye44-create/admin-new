DELETE FROM app_performance_events 
WHERE metric_name = 'screen_load_time' 
AND metric_value > 30000
AND is_synthetic = false;