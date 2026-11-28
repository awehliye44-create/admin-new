-- SN1 — Extend customer_trip_notification_deliveries for durable lifecycle intents.
-- pending = durable claim before HTTP success; sending = worker lease;
-- sent / skipped / ambiguous terminal; failed reclaimable.

ALTER TABLE public.customer_trip_notification_deliveries
  DROP CONSTRAINT IF EXISTS customer_trip_notification_deliveries_status_check;

ALTER TABLE public.customer_trip_notification_deliveries
  ADD CONSTRAINT customer_trip_notification_deliveries_status_check
  CHECK (
    status IN ('pending', 'sending', 'sent', 'skipped', 'failed', 'ambiguous')
  );

CREATE INDEX IF NOT EXISTS customer_trip_notification_deliveries_recovery_idx
  ON public.customer_trip_notification_deliveries (status, updated_at)
  WHERE status IN ('pending', 'sending', 'failed');

COMMENT ON TABLE public.customer_trip_notification_deliveries IS
  'Idempotent delivery ledger for customer trip lifecycle pushes (traffic_delay + SN1 scheduled lifecycle). UNIQUE(notification_id) is the concurrency claim. pending = durable intent before provider send.';
