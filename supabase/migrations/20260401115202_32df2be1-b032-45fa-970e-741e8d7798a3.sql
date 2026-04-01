
UPDATE ops_alerts
SET status = 'resolved', updated_at = now()
WHERE status = 'open'
  AND category = 'admin_panel'
  AND fingerprint IN ('admin_panel_slow:dashboard', 'admin_panel_slow:opsintelligence');
