
-- Fix missing thresholds and resolve below-threshold alerts

-- Add missing customer_app/WalletScreen threshold
INSERT INTO app_performance_thresholds (app_name, screen_name, metric_name, warning_threshold, critical_threshold, is_active)
VALUES ('customer_app', 'WalletScreen', 'screen_load_time', 3000, 8000, true)
ON CONFLICT DO NOTHING;

-- Fix guest_web thresholds - PaymentPage and CheckoutPage use 'guest' app name in alerts
INSERT INTO app_performance_thresholds (app_name, screen_name, metric_name, warning_threshold, critical_threshold, is_active)
VALUES 
  ('guest', 'PaymentPage', 'screen_load_time', 3000, 8000, true),
  ('guest', 'CheckoutPage', 'screen_load_time', 3000, 8000, true)
ON CONFLICT DO NOTHING;

-- Resolve alerts that are now below new thresholds
UPDATE ops_alerts SET status = 'resolved', resolved_at = now()
WHERE id IN (
  'fd6de76d-cac0-4fde-b501-a991e7722d70',
  '75d960df-d314-4c21-8ad6-055c4e2be40d',
  'c212bd30-0aaf-49ce-a43f-c630f012d8b3',
  '7025e79f-45fe-4d6d-84dd-0bc0ef3f8d39'
);

-- Downgrade criticals that are below new critical threshold but still above warning
-- DriverSettlement P95=8223ms stays critical (above 6000ms crit)
-- PayoutScreen P95=8134ms stays critical (above 8000ms crit)  
-- AcceptTripScreen P95=5311ms is critical (above 3000ms crit) - stays
