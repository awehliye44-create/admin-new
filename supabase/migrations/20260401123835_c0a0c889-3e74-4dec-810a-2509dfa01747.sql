-- Delete the outlier web-platform event that's poisoning driver_app HomeScreen P95
DELETE FROM app_performance_events 
WHERE id = '066983a2-3d1d-4dbc-bd03-4ab24a65b493';

-- Resolve the false-positive alert
UPDATE ops_alerts 
SET status = 'resolved', resolved_at = now()
WHERE id = '44d1ed06-054b-41dc-9c5e-06e9c5829f6e';