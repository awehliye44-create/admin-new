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

  if (action === 'seed') {
    // Seed demo alerts
    const alerts = [
      { fingerprint: 'demo:payment_failed:trip-001', category: 'payment', severity: 'critical', source: 'system', app: 'backend', title: 'Payment Failed', description: 'Stripe returned card_declined for trip MK0042.', metadata: { stripe_error: 'card_declined', amount_pence: 1850 } },
      { fingerprint: 'demo:commission_missing:trip-002', category: 'commission', severity: 'critical', source: 'system', app: 'backend', title: 'Missing Commission', description: 'Completed trip has no commission in trip_finance. Fare: £22.50', metadata: { gross_fare_pence: 2250 } },
      { fingerprint: 'demo:earning_missing:trip-003', category: 'earning', severity: 'critical', source: 'system', app: 'backend', title: 'Missing Driver Earnings', description: 'Driver ledger has no entry for completed trip.', metadata: { gross_fare_pence: 1800 } },
      { fingerprint: 'demo:payout_failed:batch-001', category: 'payout', severity: 'critical', source: 'system', app: 'backend', title: 'Payout Batch Failed', description: 'Stripe payout batch failed for 3 drivers. Total: £450.00', metadata: { failed_count: 3, total_pence: 45000 } },
      { fingerprint: 'demo:dispatch_stuck:trip-004', category: 'dispatch', severity: 'warning', source: 'system', app: 'backend', title: 'Stuck Dispatch', description: 'Trip stuck in dispatch for 28 minutes.', metadata: { minutes_waiting: 28 } },
      { fingerprint: 'demo:guest_checkout', category: 'guest_booking', severity: 'critical', source: 'system', app: 'guest', title: 'Guest Checkout Failed', description: 'Guest booking on guest.onecab.net failed at checkout.', metadata: { page: '/checkout' } },
      { fingerprint: 'demo:api_500_spike', category: 'backend', severity: 'critical', source: 'system', app: 'backend', title: 'API 5xx Spike', description: '12 server errors in the last 5 minutes.', metadata: { error_count: 12 } },
      { fingerprint: 'demo:dup_payment:trip-005', category: 'duplication', severity: 'critical', source: 'system', app: 'backend', title: 'Duplicate Payment Detected', description: 'Trip has 2 successful payments totaling £37.00.', metadata: { payment_count: 2, total_pence: 3700 } },
      { fingerprint: 'demo:dup_booking:trip-006', category: 'duplication', severity: 'warning', source: 'system', app: 'guest', title: 'Duplicate Booking Detected', description: 'Same customer submitted 2 identical bookings within 3 seconds.', metadata: { time_diff_seconds: 3 } },
      { fingerprint: 'demo:dup_dispatch', category: 'duplication', severity: 'warning', source: 'system', app: 'backend', title: 'Duplicate Dispatch Request', description: 'Same trip dispatched twice to driver pool.', metadata: {} },
    ];

    for (const a of alerts) {
      await supabase.rpc('ops_upsert_alert', {
        p_fingerprint: a.fingerprint,
        p_category: a.category,
        p_severity: a.severity,
        p_source: a.source,
        p_app: a.app,
        p_title: a.title,
        p_description: a.description,
        p_metadata: a.metadata,
      });
    }

    // Seed demo logs
    const logs = [
      { level: 'error', source: 'complete-trip', app: 'backend', message: 'Failed to capture Stripe payment: card_declined', error_code: 'STRIPE_CARD_DECLINED', duration_ms: 1200, http_status: 402 },
      { level: 'error', source: 'dispatch-drivers', app: 'backend', message: 'No eligible drivers found in service area MK after 3 waves', error_code: 'NO_DRIVERS', duration_ms: 850, http_status: 200 },
      { level: 'warn', source: 'estimate-fare', app: 'guest', message: 'Fare estimation took 4200ms (threshold: 2000ms)', error_code: 'LATENCY_HIGH', duration_ms: 4200, http_status: 200 },
      { level: 'error', source: 'create-payment-intent', app: 'backend', message: 'Stripe API timeout after 30s', error_code: 'STRIPE_TIMEOUT', duration_ms: 30000, http_status: 504 },
      { level: 'info', source: 'schedule-dispatch', app: 'backend', message: 'Scheduled dispatch cron: 2 trips converted to urgent', duration_ms: 120, http_status: 200 },
      { level: 'fatal', source: 'admin-payout-batches', app: 'backend', message: 'Unhandled error in payout processing: connection reset', error_code: 'PAYOUT_CRASH', http_status: 500 },
      { level: 'info', source: 'accept-trip', app: 'driver', message: 'Driver UK-0042 accepted trip MK0058', duration_ms: 45, http_status: 200 },
      { level: 'error', source: 'qr-booking-config', app: 'guest', message: 'QR booking validation failed: expired QR code', error_code: 'QR_EXPIRED', duration_ms: 80, http_status: 400 },
    ];

    const { error: logError } = await supabase.from('ops_logs').insert(logs);

    return new Response(JSON.stringify({ success: true, alerts_seeded: alerts.length, logs_seeded: logs.length, log_error: logError }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Run detections
  if (action === 'detect') {
    const { data, error } = await supabase.rpc('ops_run_all_detections');
    return new Response(JSON.stringify({ success: !error, data, error }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
