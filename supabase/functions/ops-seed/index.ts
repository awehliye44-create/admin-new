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
    // ── 1. Seed demo alerts via ops_upsert_alert ──
    const alerts = [
      // Payment failures
      { fingerprint: 'demo:payment_failed:trip-001', category: 'payment', severity: 'critical', source: 'system', app: 'backend', title: 'Payment Failed', description: 'Stripe returned card_declined for trip MK0042.', metadata: { stripe_error: 'card_declined', amount_pence: 1850 } },
      { fingerprint: 'demo:payment_failed:trip-007', category: 'payment', severity: 'critical', source: 'system', app: 'backend', title: 'Payment Failed', description: 'Stripe returned insufficient_funds for trip MK0099.', metadata: { stripe_error: 'insufficient_funds', amount_pence: 2400 } },
      // Commission / earning
      { fingerprint: 'demo:commission_missing:trip-002', category: 'commission', severity: 'critical', source: 'system', app: 'backend', title: 'Missing Commission', description: 'Completed trip has no commission in trip_finance. Fare: £22.50', metadata: { gross_fare_pence: 2250 } },
      { fingerprint: 'demo:earning_missing:trip-003', category: 'earning', severity: 'critical', source: 'system', app: 'backend', title: 'Missing Driver Earnings', description: 'Driver ledger has no entry for completed trip.', metadata: { gross_fare_pence: 1800 } },
      // Payout
      { fingerprint: 'demo:payout_failed:batch-001', category: 'payout', severity: 'critical', source: 'system', app: 'backend', title: 'Payout Batch Failed', description: 'Stripe payout batch failed for 3 drivers. Total: £450.00', metadata: { failed_count: 3, total_pence: 45000 } },
      // Dispatch
      { fingerprint: 'demo:dispatch_stuck:trip-004', category: 'dispatch', severity: 'warning', source: 'system', app: 'backend', title: 'Stuck Dispatch', description: 'Trip stuck in dispatch for 28 minutes.', metadata: { minutes_waiting: 28 } },
      // ── Guest booking failures (3 distinct) ──
      { fingerprint: 'demo:guest_quote_fail:sess-001', category: 'guest_booking', severity: 'critical', source: 'system', app: 'guest', title: 'Guest Quote Failed', description: 'Guest on guest.onecab.net received error during fare estimation. Session: sess-001', metadata: { page: '/quote', error: 'fare_engine_timeout' } },
      { fingerprint: 'demo:guest_checkout_fail:sess-002', category: 'guest_booking', severity: 'critical', source: 'system', app: 'guest', title: 'Guest Checkout Failed', description: 'Guest booking on guest.onecab.net failed at payment checkout. Session: sess-002', metadata: { page: '/checkout', error: 'stripe_card_declined' } },
      { fingerprint: 'demo:guest_not_confirmed:sess-003', category: 'guest_booking', severity: 'warning', source: 'system', app: 'guest', title: 'Guest Booking Not Confirmed', description: 'Guest completed payment but booking was not confirmed within 60s. Session: sess-003', metadata: { page: '/confirmation', wait_seconds: 60 } },
      // ── Duplicate payments (3 distinct) ──
      { fingerprint: 'demo:dup_payment:trip-005', category: 'duplication', severity: 'critical', source: 'system', app: 'backend', title: 'Duplicate Payment Detected', description: 'Trip MK0055 has 2 successful payments totaling £37.00.', metadata: { payment_count: 2, total_pence: 3700, trip_ref: 'MK0055' } },
      { fingerprint: 'demo:dup_payment:trip-008', category: 'duplication', severity: 'critical', source: 'system', app: 'backend', title: 'Duplicate Payment Detected', description: 'Trip MK0071 has 3 successful payments totaling £54.00.', metadata: { payment_count: 3, total_pence: 5400, trip_ref: 'MK0071' } },
      { fingerprint: 'demo:dup_payment:trip-009', category: 'duplication', severity: 'critical', source: 'system', app: 'backend', title: 'Duplicate Payment Detected', description: 'Trip MK0088 has 2 successful payments totaling £19.50.', metadata: { payment_count: 2, total_pence: 1950, trip_ref: 'MK0088' } },
      // Other duplications
      { fingerprint: 'demo:dup_booking:trip-006', category: 'duplication', severity: 'warning', source: 'system', app: 'guest', title: 'Duplicate Booking Detected', description: 'Same customer submitted 2 identical bookings within 3 seconds.', metadata: { time_diff_seconds: 3 } },
      { fingerprint: 'demo:dup_dispatch:trip-010', category: 'duplication', severity: 'warning', source: 'system', app: 'backend', title: 'Duplicate Dispatch Request', description: 'Same trip dispatched twice to driver pool.', metadata: {} },
      // ── API / backend errors (3 distinct) ──
      { fingerprint: 'demo:api_500_spike:backend:1h', category: 'backend', severity: 'critical', source: 'system', app: 'backend', title: 'API 5xx Spike', description: '12 server errors from complete-trip in the last 15 minutes.', metadata: { error_count: 12, source_fn: 'complete-trip' } },
      { fingerprint: 'demo:error_spike:create-payment-intent', category: 'backend', severity: 'critical', source: 'system', app: 'backend', title: 'Error Spike: create-payment-intent', description: '8 errors from create-payment-intent in the last hour.', metadata: { error_count: 8, source_fn: 'create-payment-intent' } },
      { fingerprint: 'demo:fatal_log:admin-payout-batches', category: 'backend', severity: 'critical', source: 'system', app: 'backend', title: 'Fatal Error in Payout Processing', description: 'Fatal crash in admin-payout-batches: connection reset.', metadata: { error_code: 'PAYOUT_CRASH' } },
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
      alertResults.push({ fp: a.fingerprint, error: error?.message || null });
    }

    // ── 2. Seed ops_logs with patterns that trigger log-based detections ──
    const now = new Date();
    const logs = [];

    // 6 errors from same source in 1hr → triggers ops_detect_error_spikes
    for (let i = 0; i < 6; i++) {
      const ts = new Date(now.getTime() - i * 3 * 60 * 1000).toISOString();
      logs.push({ level: 'error', source: 'complete-trip', app: 'backend', message: `Payment capture failed: card_declined (attempt ${i + 1})`, error_code: 'STRIPE_CARD_DECLINED', duration_ms: 1200 + i * 100, http_status: 402, created_at: ts });
    }

    // 4 x 5xx from same source in 15min → triggers ops_detect_5xx_spikes
    for (let i = 0; i < 4; i++) {
      const ts = new Date(now.getTime() - i * 2 * 60 * 1000).toISOString();
      logs.push({ level: 'error', source: 'create-payment-intent', app: 'backend', message: `Stripe API gateway timeout (instance ${i + 1})`, error_code: 'STRIPE_TIMEOUT', duration_ms: 30000, http_status: 500 + (i % 3), created_at: ts });
    }

    // 1 fatal log → triggers ops_detect_fatal_logs
    logs.push({ level: 'fatal', source: 'admin-payout-batches', app: 'backend', message: 'Unhandled error in payout processing: connection reset', error_code: 'PAYOUT_CRASH', http_status: 500, created_at: now.toISOString() });

    // 3 high-latency logs → triggers ops_detect_latency_spikes (need 3+ with duration_ms > 5000)
    for (let i = 0; i < 3; i++) {
      const ts = new Date(now.getTime() - i * 5 * 60 * 1000).toISOString();
      logs.push({ level: 'warn', source: 'estimate-fare', app: 'guest', message: `Fare estimation took ${6000 + i * 1000}ms (threshold: 2000ms)`, error_code: 'LATENCY_HIGH', duration_ms: 6000 + i * 1000, http_status: 200, created_at: ts });
    }

    // 3 edge function errors → triggers ops_detect_edge_function_failures
    for (let i = 0; i < 3; i++) {
      const ts = new Date(now.getTime() - i * 4 * 60 * 1000).toISOString();
      logs.push({ level: 'error', source: 'dispatch-drivers', app: 'backend', message: `Edge function crashed: out of memory (instance ${i + 1})`, error_code: 'EDGE_OOM', duration_ms: 0, http_status: 546, created_at: ts });
    }

    // Guest booking logs
    logs.push({ level: 'error', source: 'estimate-fare', app: 'guest', message: 'Guest quote failed: fare engine returned null', error_code: 'QUOTE_FAIL', duration_ms: 3200, http_status: 500, created_at: now.toISOString() });
    logs.push({ level: 'error', source: 'create-payment-intent', app: 'guest', message: 'Guest checkout payment failed: card_declined', error_code: 'CHECKOUT_FAIL', duration_ms: 1100, http_status: 402, created_at: now.toISOString() });

    // Normal info logs for contrast
    logs.push({ level: 'info', source: 'accept-trip', app: 'driver', message: 'Driver UK-0042 accepted trip MK0058', duration_ms: 45, http_status: 200, created_at: now.toISOString() });
    logs.push({ level: 'info', source: 'schedule-dispatch', app: 'backend', message: 'Scheduled dispatch cron: 2 trips converted to urgent', duration_ms: 120, http_status: 200, created_at: now.toISOString() });

    const { error: logError } = await supabase.from('ops_logs').insert(logs);

    // ── 3. Run all detections to generate real alerts from seeded data ──
    const { data: detectionResult, error: detectionError } = await supabase.rpc('ops_run_all_detections');

    return new Response(JSON.stringify({
      success: true,
      alerts_seeded: alerts.length,
      alert_details: alertResults,
      logs_seeded: logs.length,
      log_error: logError?.message || null,
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

  return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
