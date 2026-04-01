
-- Resolve the 2 stale admin_panel performance alerts
UPDATE ops_alerts
SET status = 'resolved', updated_at = now()
WHERE status = 'open'
  AND category = 'admin_panel'
  AND fingerprint IN ('admin_panel_slow:dashboard', 'admin_panel_slow:opsintelligence');

-- Delete all synthetic logs that are polluting the dashboard
DELETE FROM ops_logs WHERE is_synthetic = true;
