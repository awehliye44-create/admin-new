
-- Add thresholds for all critical customer_app screens
INSERT INTO public.app_performance_thresholds (app_name, screen_name, metric_name, warning_threshold, critical_threshold, is_active)
VALUES
  -- Customer App screens
  ('customer_app', 'RatingsScreen', 'screen_load_time', 2000, 5000, true),
  ('customer_app', 'TripDetailsScreen', 'screen_load_time', 2000, 5000, true),
  ('customer_app', 'ProfileScreen', 'screen_load_time', 2000, 5000, true),
  ('customer_app', 'SettingsScreen', 'screen_load_time', 1500, 4000, true),
  ('customer_app', 'TripHistoryScreen', 'screen_load_time', 2000, 5000, true),
  ('customer_app', 'SupportScreen', 'screen_load_time', 2000, 5000, true),
  ('customer_app', 'NotificationsScreen', 'screen_load_time', 1500, 4000, true),
  ('customer_app', 'BookingConfirmation', 'screen_load_time', 2000, 5000, true),
  ('customer_app', 'RatingsScreen', 'api_latency', 1500, 4000, true),
  ('customer_app', 'PaymentScreen', 'transaction_time', 3000, 8000, true),
  -- Driver App screens
  ('driver_app', 'RatingsScreen', 'screen_load_time', 2000, 5000, true),
  ('driver_app', 'TripDetailsScreen', 'screen_load_time', 2000, 5000, true),
  ('driver_app', 'ProfileScreen', 'screen_load_time', 2000, 5000, true),
  ('driver_app', 'SettingsScreen', 'screen_load_time', 1500, 4000, true),
  ('driver_app', 'TripHistoryScreen', 'screen_load_time', 2000, 5000, true),
  ('driver_app', 'DocumentsScreen', 'screen_load_time', 2000, 5000, true),
  ('driver_app', 'CommissionScreen', 'screen_load_time', 2000, 5000, true),
  ('driver_app', 'DriverSettlement', 'screen_load_time', 2500, 6000, true),
  ('driver_app', 'InvoiceScreen', 'screen_load_time', 2000, 5000, true),
  ('driver_app', 'AcceptTripScreen', 'screen_load_time', 1000, 3000, true),
  ('driver_app', 'NavigationScreen', 'screen_load_time', 1500, 4000, true),
  ('driver_app', 'CommissionScreen', 'api_latency', 1500, 4000, true),
  ('driver_app', 'DriverSettlement', 'api_latency', 2000, 5000, true),
  ('driver_app', 'InvoiceScreen', 'api_latency', 1500, 4000, true)
ON CONFLICT DO NOTHING;
