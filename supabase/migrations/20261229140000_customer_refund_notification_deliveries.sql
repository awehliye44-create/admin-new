-- Per-channel idempotency for customer refund confirmation messages.
-- Keyed by provider refund id + channel so duplicate webhooks / retries cannot
-- resend a channel that already succeeded or was intentionally skipped.
-- Notification failures never mutate refund financial state.

CREATE TABLE IF NOT EXISTS public.customer_refund_notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_refund_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('push', 'email', 'sms')),
  trip_id uuid NULL REFERENCES public.trips(id) ON DELETE SET NULL,
  payment_session_id uuid NULL,
  amount_pence integer NOT NULL CHECK (amount_pence > 0),
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'skipped', 'failed')),
  skipped_reason text NULL,
  error_message text NULL,
  provider_message_id text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_refund_notification_deliveries_refund_channel_uid
    UNIQUE (provider_refund_id, channel)
);

CREATE INDEX IF NOT EXISTS customer_refund_notification_deliveries_trip_idx
  ON public.customer_refund_notification_deliveries (trip_id);

CREATE INDEX IF NOT EXISTS customer_refund_notification_deliveries_status_idx
  ON public.customer_refund_notification_deliveries (status);

ALTER TABLE public.customer_refund_notification_deliveries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.customer_refund_notification_deliveries FROM PUBLIC;
REVOKE ALL ON public.customer_refund_notification_deliveries FROM anon;
REVOKE ALL ON public.customer_refund_notification_deliveries FROM authenticated;
GRANT ALL ON public.customer_refund_notification_deliveries TO service_role;

COMMENT ON TABLE public.customer_refund_notification_deliveries IS
  'Idempotent push/email/SMS delivery ledger for provider-confirmed customer refunds.';
