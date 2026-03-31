-- Phase B: Clean up demo-seeded ops_logs and their derived alerts

-- 1. Delete all demo-seeded ops_logs (they have formulaic messages from ops-seed)
DELETE FROM ops_logs WHERE message IN (
  'Payment capture failed: card_declined (attempt 1)',
  'Payment capture failed: card_declined (attempt 2)',
  'Payment capture failed: card_declined (attempt 3)',
  'Payment capture failed: card_declined (attempt 4)',
  'Payment capture failed: card_declined (attempt 5)',
  'Payment capture failed: card_declined (attempt 6)',
  'Stripe API gateway timeout (instance 1)',
  'Stripe API gateway timeout (instance 2)',
  'Stripe API gateway timeout (instance 3)',
  'Stripe API gateway timeout (instance 4)',
  'Unhandled error in payout processing: connection reset',
  'Fare estimation took 6000ms (threshold: 2000ms)',
  'Edge function crashed: out of memory (instance 1)',
  'Edge function crashed: out of memory (instance 2)',
  'Edge function crashed: out of memory (instance 3)',
  'Webhook handler failed: payment_intent.succeeded (instance 1)',
  'Webhook handler failed: payment_intent.succeeded (instance 2)',
  'Webhook handler failed: payment_intent.succeeded (instance 3)',
  'Webhook handler failed: payment_intent.succeeded (instance 4)',
  'Guest quote failed: fare engine returned null',
  'Guest checkout payment failed: card_declined',
  'Slow screen render: home took 8200ms',
  'Slow screen render: earnings took 6500ms',
  'Driver UK-0042 accepted trip MK0058',
  'Scheduled dispatch cron: 2 trips converted to urgent'
);

-- 2. Delete backend alerts derived from these demo logs
-- These have fingerprints like 5xx_spike:, latency_spike:, edge_fn_failure:, webhook_failure:, log_anomaly:
DELETE FROM ops_alerts WHERE category = 'backend' AND status IN ('open','acknowledged');

-- 3. Delete log-category alerts 
DELETE FROM ops_alerts WHERE category = 'logs' AND status IN ('open','acknowledged');

-- 4. Delete dispatch alerts (was 0 anyway, but clean state)
DELETE FROM ops_alerts WHERE category = 'dispatch' AND fingerprint LIKE 'demo:%';