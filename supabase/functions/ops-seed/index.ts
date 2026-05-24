import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { action } = await req.json().catch(() => ({ action: 'seed' }));

  // ── CLEAR: Remove all demo seed data ──
  if (action === 'clear') {
    await supabase.from('ops_ai_summaries').delete().like('alert_id', '%');
    const { data: demoAlerts } = await supabase.from('ops_alerts').select('id').like('fingerprint', 'demo:%');
    if (demoAlerts?.length) {
      const ids = demoAlerts.map(a => a.id);
      await supabase.from('ops_ai_summaries').delete().in('alert_id', ids);
      await supabase.from('ops_events').delete().in('alert_id', ids);
    }
    await supabase.from('ops_alerts').delete().like('fingerprint', 'demo:%');
    await supabase.from('ops_logs').delete().eq('is_synthetic', true);
    // Clear seeded telemetry
    await supabase.from('app_performance_events').delete().like('session_id', 'demo-%');

    return new Response(JSON.stringify({ success: true, cleared: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (action === 'seed') {
    // ── All 18 required seed scenarios via ops_upsert_alert ──
    const alerts = [
      // 1. Failed payment
      { fingerprint: 'demo:payment_failed:trip-001', category: 'payment', severity: 'critical', source: 'system', app: 'backend', title: 'Payment Failed', description: 'Stripe returned card_declined for trip MK0042.', metadata: { stripe_error: 'card_declined', amount_pence: 1850 } },
      // 2. Missing commission
      { fingerprint: 'demo:commission_missing:trip-002', category: 'commission', severity: 'critical', source: 'system', app: 'backend', title: 'Missing Commission', description: 'Completed trip has no commission in trip_finance. Fare: £22.50', metadata: { gross_fare_pence: 2250 } },
      // 3. Missing driver earning
      { fingerprint: 'demo:earning_missing:trip-003', category: 'earning', severity: 'critical', source: 'system', app: 'backend', title: 'Missing Driver Earnings', description: 'Driver ledger has no entry for completed trip.', metadata: { gross_fare_pence: 1800 } },
      // 4. Failed payout
      { fingerprint: 'demo:payout_failed:batch-001', category: 'payout', severity: 'critical', source: 'system', app: 'backend', title: 'Payout Batch Failed', description: 'Stripe payout batch failed for 3 drivers. Total: £450.00', metadata: { failed_count: 3, total_pence: 45000 } },
      // 5. Stuck dispatch
      { fingerprint: 'demo:dispatch_stuck:trip-004', category: 'dispatch', severity: 'warning', source: 'system', app: 'backend', title: 'Stuck Dispatch', description: 'Trip stuck in dispatch for 28 minutes with no driver accepting.', metadata: { minutes_waiting: 28 } },
      // 6. Slow customer app screen
      { fingerprint: 'demo:customer_app_slow:home', category: 'customer_app', severity: 'warning', source: 'system', app: 'customer', title: 'Slow Customer App Screen', description: 'Customer app home screen rendering took 8.2s (threshold: 3s).', metadata: { screen: 'HomeScreen', load_time_ms: 8200, threshold_ms: 3000 } },
      { fingerprint: 'demo:customer_app_slow:payment', category: 'customer_app', severity: 'critical', source: 'system', app: 'customer', title: 'Customer Payment Screen Slow', description: 'PaymentScreen load time spiked to 7.8s on iOS 2.3.1.', metadata: { screen: 'PaymentScreen', load_time_ms: 7800, platform: 'ios' } },
      { fingerprint: 'demo:customer_app_slow:ratings', category: 'customer_app', severity: 'warning', source: 'system', app: 'customer', title: 'Customer Ratings Screen Slow', description: 'RatingsScreen took 5.4s avg — above 2s warning threshold.', metadata: { screen: 'RatingsScreen', load_time_ms: 5400, threshold_ms: 2000 } },
      { fingerprint: 'demo:customer_app_slow:tripdetails', category: 'customer_app', severity: 'warning', source: 'system', app: 'customer', title: 'Customer Trip Details Slow', description: 'TripDetailsScreen P95 at 6.1s on Android 2.3.0.', metadata: { screen: 'TripDetailsScreen', load_time_ms: 6100, platform: 'android' } },
      // 7. Slow driver app screens
      { fingerprint: 'demo:driver_app_slow:earnings', category: 'driver_app', severity: 'warning', source: 'system', app: 'driver', title: 'Slow Driver App Screen', description: 'Driver app earnings screen took 6.5s to load (threshold: 3s).', metadata: { screen: 'EarningsScreen', load_time_ms: 6500, threshold_ms: 3000 } },
      { fingerprint: 'demo:driver_app_slow:payout', category: 'driver_app', severity: 'critical', source: 'system', app: 'driver', title: 'Driver Payout Screen Critical', description: 'PayoutScreen avg 7.2s — drivers reporting frozen payout view.', metadata: { screen: 'PayoutScreen', load_time_ms: 7200 } },
      { fingerprint: 'demo:driver_app_slow:ratings', category: 'driver_app', severity: 'warning', source: 'system', app: 'driver', title: 'Driver Ratings Screen Slow', description: 'RatingsScreen took 4.8s avg on Android 3.0.8.', metadata: { screen: 'RatingsScreen', load_time_ms: 4800, platform: 'android' } },
      { fingerprint: 'demo:driver_app_slow:commission', category: 'driver_app', severity: 'warning', source: 'system', app: 'driver', title: 'Driver Commission Screen Slow', description: 'CommissionScreen API latency 4.2s — above threshold.', metadata: { screen: 'CommissionScreen', load_time_ms: 4200 } },
      { fingerprint: 'demo:driver_app_slow:settlement', category: 'driver_app', severity: 'critical', source: 'system', app: 'driver', title: 'Driver Settlement Screen Critical', description: 'DriverSettlement screen P95 at 8.1s on iOS.', metadata: { screen: 'DriverSettlement', load_time_ms: 8100, platform: 'ios' } },
      { fingerprint: 'demo:driver_app_slow:documents', category: 'driver_app', severity: 'warning', source: 'system', app: 'driver', title: 'Driver Documents Screen Slow', description: 'DocumentsScreen load time 5.1s when fetching expiry docs.', metadata: { screen: 'DocumentsScreen', load_time_ms: 5100 } },
      { fingerprint: 'demo:driver_app_slow:accept', category: 'driver_app', severity: 'critical', source: 'system', app: 'driver', title: 'Accept Trip Screen Critical', description: 'AcceptTripScreen took 3.8s — drivers missing offers due to delay.', metadata: { screen: 'AcceptTripScreen', load_time_ms: 3800, threshold_ms: 1000 } },
      // 8. Guest checkout failure
      { fingerprint: 'demo:guest_checkout_fail:sess-002', category: 'guest_booking', severity: 'critical', source: 'system', app: 'guest', title: 'Guest Checkout Failed', description: 'Guest booking on guest.onecab.net failed at payment checkout.', metadata: { page: '/checkout', error: 'stripe_card_declined' } },
      // 9. Guest quote failure
      { fingerprint: 'demo:guest_quote_fail:sess-001', category: 'guest_booking', severity: 'critical', source: 'system', app: 'guest', title: 'Guest Quote Failed', description: 'Guest on guest.onecab.net received error during fare estimation.', metadata: { page: '/quote', error: 'fare_engine_timeout' } },
      // 10. Repeated guest web errors
      { fingerprint: 'demo:guest_repeated_errors:web', category: 'guest_booking', severity: 'warning', source: 'system', app: 'guest', title: 'Repeated Guest Web Errors', description: '7 errors from guest.onecab.net in the last 30 minutes.', metadata: { error_count: 7, time_window_minutes: 30 } },
      // 11. Backend API 500 spike
      { fingerprint: 'demo:api_500_spike:backend:1h', category: 'backend', severity: 'critical', source: 'system', app: 'backend', title: 'API 5xx Spike', description: '12 server errors from complete-trip in the last 15 minutes.', metadata: { error_count: 12, source_fn: 'complete-trip' } },
      // 12. Fatal log
      { fingerprint: 'demo:fatal_log:payout', category: 'backend', severity: 'fatal', source: 'system', app: 'backend', title: 'Fatal Error in Payout Processing', description: 'Fatal crash in admin-payout-batches: connection reset.', metadata: { error_code: 'PAYOUT_CRASH' } },
      // 13. Webhook failure
      { fingerprint: 'demo:webhook_failure:stripe', category: 'backend', severity: 'critical', source: 'system', app: 'backend', title: 'Webhook Processing Failed', description: 'Stripe webhook handler returned 500 for 4 consecutive events.', metadata: { webhook_source: 'stripe', failure_count: 4, event_types: ['payment_intent.succeeded', 'charge.refunded'] } },
      // 14. Edge function failure
      { fingerprint: 'demo:edge_fn_crash:dispatch', category: 'backend', severity: 'critical', source: 'system', app: 'backend', title: 'Edge Function Crash: dispatch-trip', description: 'dispatch-trip edge function crashed 3 times with OOM error.', metadata: { function_name: 'dispatch-trip', error: 'out_of_memory', crash_count: 3 } },
      // 15. Duplicate booking
      { fingerprint: 'demo:dup_booking:trip-006', category: 'duplication', severity: 'warning', source: 'system', app: 'guest', title: 'Duplicate Booking Detected', description: 'Same customer submitted 2 identical bookings within 3 seconds.', metadata: { time_diff_seconds: 3 } },
      // 16. Duplicate payment
      { fingerprint: 'demo:dup_payment:trip-005', category: 'duplication', severity: 'critical', source: 'system', app: 'backend', title: 'Duplicate Payment Detected', description: 'Trip MK0055 has 2 successful payments totaling £37.00.', metadata: { payment_count: 2, total_pence: 3700, trip_ref: 'MK0055' } },
      // 17. Duplicate payout
      { fingerprint: 'demo:dup_payout:batch-002', category: 'duplication', severity: 'critical', source: 'system', app: 'backend', title: 'Duplicate Payout Detected', description: 'Driver DRV-044 received 2 payouts for the same period totaling £320.', metadata: { payout_count: 2, total_pence: 32000, driver_ref: 'DRV-044' } },
      // Admin panel alerts
      { fingerprint: 'demo:admin_panel_slow:logs', category: 'system', severity: 'warning', source: 'system', app: 'admin_panel', title: 'Admin Panel Slow: LogsExplorer', description: 'LogsExplorer screen_load_time avg 4200ms (threshold: 2000ms).', metadata: { screen: 'LogsExplorer', avg_ms: 4200 } },
      { fingerprint: 'demo:admin_panel_slow:perf', category: 'system', severity: 'warning', source: 'system', app: 'admin_panel', title: 'Admin Panel Slow: PerformanceTab', description: 'PerformanceTab screen_load_time avg 3800ms (threshold: 2000ms).', metadata: { screen: 'PerformanceTab', avg_ms: 3800 } },
      { fingerprint: 'demo:admin_panel_slow:dashboard', category: 'system', severity: 'warning', source: 'system', app: 'admin_panel', title: 'Admin Panel Slow: Dashboard', description: 'Dashboard screen_load_time avg 3500ms (threshold: 2000ms).', metadata: { screen: 'Dashboard', avg_ms: 3500 } },
      // 18. Duplicate dispatch request
      { fingerprint: 'demo:dup_dispatch:trip-010', category: 'duplication', severity: 'warning', source: 'system', app: 'backend', title: 'Duplicate Dispatch Request', description: 'Same trip dispatched twice to driver pool within 2 seconds.', metadata: { time_diff_seconds: 2 } },
    ];

    const alertResults = [];
    for (const a of alerts) {
      const { error } = await supabase.rpc('ops_upsert_alert', {
        p_fingerprint: a.fingerprint,
        p_category: a.category,
        p_severity: a.severity,
        p_source: a.source,
        p_app: a.app,
        p_title: a.title,
        p_description: a.description,
        p_metadata: a.metadata,
      });
      alertResults.push({ fp: a.fingerprint, ok: !error, err: error?.message || null });
    }

    // ── Seed ops_logs that trigger log-based detections ──
    const now = new Date();
    const logBase = { is_synthetic: true };
    const logs: any[] = [];

    // Error spike from complete-trip (6 errors in 1h)
    for (let i = 0; i < 6; i++) {
      logs.push({ ...logBase, level: 'error', source: 'complete-trip', app: 'backend', message: `Payment capture failed: card_declined (attempt ${i + 1})`, error_code: 'STRIPE_CARD_DECLINED', duration_ms: 1200 + i * 100, http_status: 402, created_at: new Date(now.getTime() - i * 3 * 60 * 1000).toISOString() });
    }

    // 5xx spike from create-payment-intent
    for (let i = 0; i < 4; i++) {
      logs.push({ ...logBase, level: 'error', source: 'create-payment-intent', app: 'backend', message: `Stripe API gateway timeout (instance ${i + 1})`, error_code: 'STRIPE_TIMEOUT', duration_ms: 30000, http_status: 500 + (i % 3), created_at: new Date(now.getTime() - i * 2 * 60 * 1000).toISOString() });
    }

    // Fatal log
    logs.push({ ...logBase, level: 'fatal', source: 'admin-payout-batches', app: 'backend', message: 'Unhandled error in payout processing: connection reset', error_code: 'PAYOUT_CRASH', http_status: 500, created_at: now.toISOString() });

    // Latency spikes (3+ with duration_ms > 5000)
    for (let i = 0; i < 3; i++) {
      logs.push({ ...logBase, level: 'warn', source: 'estimate-fare', app: 'guest', message: `Fare estimation took ${6000 + i * 1000}ms (threshold: 2000ms)`, error_code: 'LATENCY_HIGH', duration_ms: 6000 + i * 1000, http_status: 200, created_at: new Date(now.getTime() - i * 5 * 60 * 1000).toISOString() });
    }

    // Edge function crashes
    for (let i = 0; i < 3; i++) {
      logs.push({ ...logBase, level: 'error', source: 'dispatch-trip', app: 'backend', message: `Edge function crashed: out of memory (instance ${i + 1})`, error_code: 'EDGE_OOM', duration_ms: 0, http_status: 546, created_at: new Date(now.getTime() - i * 4 * 60 * 1000).toISOString() });
    }

    // Webhook failures
    for (let i = 0; i < 4; i++) {
      logs.push({ ...logBase, level: 'error', source: 'stripe-webhook', app: 'backend', message: `Webhook handler failed: payment_intent.succeeded (instance ${i + 1})`, error_code: 'WEBHOOK_FAIL', duration_ms: 800, http_status: 500, created_at: new Date(now.getTime() - i * 2 * 60 * 1000).toISOString() });
    }

    // Guest booking errors
    logs.push({ ...logBase, level: 'error', source: 'estimate-fare', app: 'guest', message: 'Guest quote failed: fare engine returned null', error_code: 'QUOTE_FAIL', duration_ms: 3200, http_status: 500, created_at: now.toISOString() });
    logs.push({ ...logBase, level: 'error', source: 'create-payment-intent', app: 'guest', message: 'Guest checkout payment failed: card_declined', error_code: 'CHECKOUT_FAIL', duration_ms: 1100, http_status: 402, created_at: now.toISOString() });

    // Slow app screens
    logs.push({ ...logBase, level: 'warn', source: 'customer-app', app: 'customer', message: 'Slow screen render: home took 8200ms', error_code: 'SLOW_RENDER', duration_ms: 8200, http_status: 200, created_at: now.toISOString() });
    logs.push({ ...logBase, level: 'warn', source: 'driver-app', app: 'driver', message: 'Slow screen render: earnings took 6500ms', error_code: 'SLOW_RENDER', duration_ms: 6500, http_status: 200, created_at: now.toISOString() });

    // Normal info logs for contrast
    logs.push({ ...logBase, level: 'info', source: 'accept-trip', app: 'driver', message: 'Driver UK-0042 accepted trip MK0058', duration_ms: 45, http_status: 200, created_at: now.toISOString() });
    logs.push({ ...logBase, level: 'info', source: 'schedule-dispatch', app: 'backend', message: 'Scheduled dispatch cron: 2 trips converted to urgent', duration_ms: 120, http_status: 200, created_at: now.toISOString() });

    const { error: logError } = await supabase.from('ops_logs').insert(logs);

    // ── Seed app_performance_events with realistic telemetry ──
    const telemetry: any[] = [];
    const versions: Record<string, string[]> = { customer_app: ['2.3.1', '2.3.0', '2.2.9'], driver_app: ['3.1.0', '3.0.8'], guest_web: ['1.0.0'], admin_panel: ['1.0.0'], corporate_web: ['1.2.0', '1.1.5'] };
    const platforms = ['ios', 'android'];

    const screens: Record<string, { name: string; baseMs: number; metric: string }[]> = {
      customer_app: [
        { name: 'HomeScreen', metric: 'screen_load_time', baseMs: 1200 },
        { name: 'PaymentScreen', metric: 'screen_load_time', baseMs: 4800 },
        { name: 'PaymentScreen', metric: 'api_latency', baseMs: 3500 },
        { name: 'PaymentScreen', metric: 'transaction_time', baseMs: 5200 },
        { name: 'RatingsScreen', metric: 'screen_load_time', baseMs: 5400 },
        { name: 'RatingsScreen', metric: 'api_latency', baseMs: 2800 },
        { name: 'TripDetailsScreen', metric: 'screen_load_time', baseMs: 4200 },
        { name: 'ProfileScreen', metric: 'screen_load_time', baseMs: 1800 },
        { name: 'SettingsScreen', metric: 'screen_load_time', baseMs: 1400 },
        { name: 'TripHistoryScreen', metric: 'screen_load_time', baseMs: 3800 },
        { name: 'SupportScreen', metric: 'screen_load_time', baseMs: 2400 },
        { name: 'NotificationsScreen', metric: 'screen_load_time', baseMs: 1600 },
        { name: 'BookingFlow', metric: 'screen_load_time', baseMs: 2100 },
        { name: 'BookingPayment', metric: 'transaction_time', baseMs: 5200 },
        { name: 'BookingConfirmation', metric: 'screen_load_time', baseMs: 2600 },
        { name: 'WalletScreen', metric: 'screen_load_time', baseMs: 3200 },
      ],
      driver_app: [
        { name: 'HomeScreen', metric: 'screen_load_time', baseMs: 1100 },
        { name: 'EarningsScreen', metric: 'screen_load_time', baseMs: 5500 },
        { name: 'EarningsScreen', metric: 'api_latency', baseMs: 3800 },
        { name: 'PayoutScreen', metric: 'screen_load_time', baseMs: 6200 },
        { name: 'PayoutScreen', metric: 'api_latency', baseMs: 4100 },
        { name: 'RatingsScreen', metric: 'screen_load_time', baseMs: 4800 },
        { name: 'TripDetailsScreen', metric: 'screen_load_time', baseMs: 3200 },
        { name: 'ProfileScreen', metric: 'screen_load_time', baseMs: 1600 },
        { name: 'SettingsScreen', metric: 'screen_load_time', baseMs: 1300 },
        { name: 'TripHistoryScreen', metric: 'screen_load_time', baseMs: 3600 },
        { name: 'DocumentsScreen', metric: 'screen_load_time', baseMs: 5100 },
        { name: 'CommissionScreen', metric: 'screen_load_time', baseMs: 4200 },
        { name: 'CommissionScreen', metric: 'api_latency', baseMs: 3500 },
        { name: 'DriverSettlement', metric: 'screen_load_time', baseMs: 6800 },
        { name: 'DriverSettlement', metric: 'api_latency', baseMs: 4500 },
        { name: 'InvoiceScreen', metric: 'screen_load_time', baseMs: 3800 },
        { name: 'InvoiceScreen', metric: 'api_latency', baseMs: 2800 },
        { name: 'AcceptTripScreen', metric: 'screen_load_time', baseMs: 3800 },
        { name: 'NavigationScreen', metric: 'screen_load_time', baseMs: 2200 },
      ],
      guest_web: [
        { name: 'QuotePage', metric: 'screen_load_time', baseMs: 2800 },
        { name: 'QuotePage', metric: 'api_latency', baseMs: 2200 },
        { name: 'CheckoutPage', metric: 'screen_load_time', baseMs: 4100 },
        { name: 'CheckoutPage', metric: 'api_latency', baseMs: 3200 },
        { name: 'CheckoutPage', metric: 'transaction_time', baseMs: 4800 },
        { name: 'BookingConfirmation', metric: 'screen_load_time', baseMs: 2400 },
        { name: 'PaymentPage', metric: 'screen_load_time', baseMs: 3600 },
        { name: 'PaymentPage', metric: 'api_latency', baseMs: 2800 },
        { name: 'LandingPage', metric: 'screen_load_time', baseMs: 1800 },
        { name: 'LandingPage', metric: 'ttfb', baseMs: 800 },
      ],
      corporate_web: [
        { name: 'LoginPage', metric: 'screen_load_time', baseMs: 1400 },
        { name: 'LoginPage', metric: 'api_latency', baseMs: 900 },
        { name: 'AccountDashboard', metric: 'screen_load_time', baseMs: 3200 },
        { name: 'AccountDashboard', metric: 'api_latency', baseMs: 2600 },
        { name: 'QuoteFlow', metric: 'screen_load_time', baseMs: 2800 },
        { name: 'QuoteFlow', metric: 'api_latency', baseMs: 2100 },
        { name: 'BookingFlow', metric: 'screen_load_time', baseMs: 3400 },
        { name: 'BookingFlow', metric: 'api_latency', baseMs: 2400 },
        { name: 'PaymentFlow', metric: 'screen_load_time', baseMs: 4200 },
        { name: 'PaymentFlow', metric: 'transaction_time', baseMs: 5100 },
        { name: 'BookingConfirmation', metric: 'screen_load_time', baseMs: 2200 },
        { name: 'InvoicePage', metric: 'screen_load_time', baseMs: 3000 },
        { name: 'InvoicePage', metric: 'api_latency', baseMs: 2300 },
        { name: 'TripHistory', metric: 'screen_load_time', baseMs: 3600 },
        { name: 'TripHistory', metric: 'api_latency', baseMs: 2800 },
        { name: 'EmployeeManagement', metric: 'screen_load_time', baseMs: 2600 },
        { name: 'PolicySettings', metric: 'screen_load_time', baseMs: 1800 },
        { name: 'ReportsPage', metric: 'screen_load_time', baseMs: 3800 },
        { name: 'ReportsPage', metric: 'api_latency', baseMs: 3200 },
      ],
      admin_panel: [
        { name: 'OpsIntelligence', metric: 'screen_load_time', baseMs: 3200 },
        { name: 'OpsIntelligence', metric: 'api_latency', baseMs: 2800 },
        { name: 'AlertsTable', metric: 'screen_load_time', baseMs: 2400 },
        { name: 'AlertsTable', metric: 'api_latency', baseMs: 1800 },
        { name: 'AlertDetail', metric: 'screen_load_time', baseMs: 1600 },
        { name: 'AlertDetail', metric: 'interaction_delay', baseMs: 1200 },
        { name: 'LogsExplorer', metric: 'screen_load_time', baseMs: 4200 },
        { name: 'LogsExplorer', metric: 'api_latency', baseMs: 3500 },
        { name: 'GuestBookingTab', metric: 'screen_load_time', baseMs: 1900 },
        { name: 'MoneyIntegrityTab', metric: 'screen_load_time', baseMs: 2100 },
        { name: 'DispatchTab', metric: 'screen_load_time', baseMs: 1800 },
        { name: 'PerformanceTab', metric: 'screen_load_time', baseMs: 3800 },
        { name: 'DuplicationsTab', metric: 'screen_load_time', baseMs: 1700 },
        { name: 'Dashboard', metric: 'screen_load_time', baseMs: 3500 },
        { name: 'Dashboard', metric: 'api_latency', baseMs: 2600 },
        { name: 'DriversPage', metric: 'screen_load_time', baseMs: 2800 },
        { name: 'RidersPage', metric: 'screen_load_time', baseMs: 2600 },
        { name: 'TripHistory', metric: 'screen_load_time', baseMs: 3100 },
        { name: 'DispatchPage', metric: 'screen_load_time', baseMs: 2900 },
        { name: 'PaymentsPage', metric: 'screen_load_time', baseMs: 2700 },
      ],
    };

    for (const [appName, screenList] of Object.entries(screens)) {
      const appVersions = versions[appName as keyof typeof versions] || ['1.0.0'];
      for (const screen of screenList) {
        // Generate 8-15 events per screen with realistic variance
        const count = 8 + Math.floor(Math.random() * 8);
        for (let i = 0; i < count; i++) {
          const jitter = (Math.random() - 0.3) * screen.baseMs * 0.6;
          const value = Math.max(100, Math.round(screen.baseMs + jitter));
          const ver = appVersions[Math.floor(Math.random() * appVersions.length)];
          const plat = (appName === 'guest_web' || appName === 'admin_panel' || appName === 'corporate_web') ? 'web' : platforms[Math.floor(Math.random() * platforms.length)];
          telemetry.push({
            app_name: appName,
            screen_name: screen.name,
            metric_name: screen.metric,
            metric_value: value,
            unit: 'ms',
            app_version: ver,
            platform: plat,
            session_id: `demo-${appName}-${i}`,
            is_synthetic: true,
            metadata: {},
            created_at: new Date(now.getTime() - Math.random() * 55 * 60 * 1000).toISOString(),
          });
        }
      }
    }

    const { error: telemetryError } = await supabase.from('app_performance_events').insert(telemetry);

    // Run all detections to generate real alerts from seeded data
    const { data: detectionResult, error: detectionError } = await supabase.rpc('ops_run_all_detections');

    return new Response(JSON.stringify({
      success: true,
      alerts_seeded: alerts.length,
      logs_seeded: logs.length,
      telemetry_seeded: telemetry.length,
      log_error: logError?.message || null,
      telemetry_error: telemetryError?.message || null,
      detection_result: detectionResult,
      detection_error: detectionError?.message || null,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Run detections only
  if (action === 'detect') {
    const { data, error } = await supabase.rpc('ops_run_all_detections');
    return new Response(JSON.stringify({ success: !error, data, error }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Invalid action. Use: seed, clear, detect' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
