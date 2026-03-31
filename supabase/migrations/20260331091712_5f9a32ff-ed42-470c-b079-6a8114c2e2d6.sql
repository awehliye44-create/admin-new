
-- ============================================================
-- PHASE C: Tune performance alert thresholds
-- Current thresholds are too aggressive for early-stage product.
-- Adjust to realistic values that flag genuine problems only.
-- ============================================================

-- Admin Panel screens: raise warning to 3s, critical to 8s
UPDATE app_performance_thresholds SET warning_threshold = 3000, critical_threshold = 8000
WHERE app_name = 'admin_panel' AND metric_name = 'screen_load_time'
AND screen_name IN ('OpsIntelligence', 'AlertsTable', 'AlertDetail', 'GuestBookingTab', 
  'MoneyIntegrityTab', 'DispatchTab', 'DuplicationsTab', 'LogsExplorer', 'PerformanceTab',
  'Dashboard', 'DriversPage', 'RidersPage', 'TripHistory', 'DispatchPage', 'PaymentsPage');

-- Driver App financial screens: already 3000/8000 for earnings/payout, 
-- but AcceptTripScreen needs fast response (keep at 1000/3000)
-- Raise settlement/commission warning slightly
UPDATE app_performance_thresholds SET warning_threshold = 3000, critical_threshold = 8000
WHERE app_name = 'driver_app' AND metric_name = 'screen_load_time'
AND screen_name IN ('RatingsScreen', 'TripDetailsScreen', 'TripHistoryScreen', 
  'DocumentsScreen', 'CommissionScreen', 'InvoiceScreen');

-- Corporate Web: raise thresholds for complex pages
UPDATE app_performance_thresholds SET warning_threshold = 3000, critical_threshold = 8000
WHERE app_name = 'corporate_web' AND metric_name = 'screen_load_time'
AND screen_name IN ('BookingFlow', 'InvoicePage', 'TripHistory', 'AccountDashboard',
  'ReportsPage', 'EmployeeManagement');

-- Customer App: raise for complex screens
UPDATE app_performance_thresholds SET warning_threshold = 3000, critical_threshold = 8000
WHERE app_name = 'customer_app' AND metric_name = 'screen_load_time'
AND screen_name IN ('TripHistoryScreen', 'TripDetailsScreen', 'RatingsScreen',
  'WalletScreen', 'PaymentScreen', 'BookingConfirmation');

-- Guest Web: adjust checkout/payment
UPDATE app_performance_thresholds SET warning_threshold = 3000, critical_threshold = 8000
WHERE app_name = 'guest_web' AND metric_name = 'screen_load_time'
AND screen_name IN ('PaymentPage', 'CheckoutPage');
