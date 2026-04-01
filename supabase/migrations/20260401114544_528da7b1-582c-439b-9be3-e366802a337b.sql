
-- These are seeded logs with identical messages that weren't properly tagged
UPDATE ops_logs
SET is_synthetic = true
WHERE is_synthetic = false
  AND level = 'warn'
  AND error_code = 'LATENCY_HIGH'
  AND source = 'estimate-fare'
  AND message LIKE 'Fare estimation took %ms (threshold: 2000ms)';
