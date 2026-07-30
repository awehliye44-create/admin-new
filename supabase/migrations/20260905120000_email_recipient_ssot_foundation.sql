-- Email recipient SSOT foundation (NOT applied to production in this change set).
-- Adds provider message persistence, invoice delivery status vocabulary,
-- and documents uniqueness expectations for trip invoices.

BEGIN;

-- 1) Persist Resend message id on email-change requests
ALTER TABLE public.account_email_change_requests
  ADD COLUMN IF NOT EXISTS provider_message_id text;

CREATE UNIQUE INDEX IF NOT EXISTS account_email_change_requests_provider_message_id_uidx
  ON public.account_email_change_requests (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- 2) Explicit trip invoice delivery status (additive; existing nulls remain until backfill)
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS invoice_delivery_status text;

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS invoice_recipient_email_snapshot text;

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS invoice_recipient_user_id uuid;

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS invoice_provider_message_id text;

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_invoice_delivery_status_check;

ALTER TABLE public.trips
  ADD CONSTRAINT trips_invoice_delivery_status_check
  CHECK (
    invoice_delivery_status IS NULL
    OR invoice_delivery_status IN (
      'not_ready',
      'queued',
      'generating',
      'generated',
      'sending',
      'sent',
      'delivered',
      'recipient_missing',
      'recipient_unverified',
      'recipient_policy_violation',
      'generation_failed',
      'delivery_failed',
      'bounced',
      'suppressed'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS trips_invoice_provider_message_id_uidx
  ON public.trips (invoice_provider_message_id)
  WHERE invoice_provider_message_id IS NOT NULL;

-- trips.invoice_no already unique where not null (trips_invoice_no_unique).
-- One trip row = one invoice by design (no separate invoices.trip_id table).

-- 3) Outbox status vocabulary expansion
ALTER TABLE public.invoice_email_outbox
  DROP CONSTRAINT IF EXISTS invoice_email_outbox_status_check;

ALTER TABLE public.invoice_email_outbox
  ADD CONSTRAINT invoice_email_outbox_status_check
  CHECK (
    status IN (
      'not_ready',
      'queued',
      'generating',
      'generated',
      'sending',
      'sent',
      'delivered',
      'recipient_missing',
      'recipient_unverified',
      'recipient_policy_violation',
      'generation_failed',
      'delivery_failed',
      'bounced',
      'suppressed',
      -- legacy
      'pending',
      'failed'
    )
  );

ALTER TABLE public.invoice_email_outbox
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

ALTER TABLE public.invoice_email_outbox
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

ALTER TABLE public.invoice_email_outbox
  ADD COLUMN IF NOT EXISTS claimed_by text;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_email_outbox_provider_message_id_uidx
  ON public.invoice_email_outbox (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- 4) Delivery attempts (manual resend creates a new attempt, not a second invoice)
CREATE TABLE IF NOT EXISTS public.invoice_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  outbox_id uuid REFERENCES public.invoice_email_outbox(id) ON DELETE SET NULL,
  recipient_user_id uuid,
  recipient_email_snapshot text NOT NULL,
  recipient_source text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued','sending','sent','delivered','delivery_failed','bounced','suppressed',
      'recipient_missing','recipient_unverified','recipient_policy_violation'
    )),
  provider_message_id text,
  attempt_number integer NOT NULL DEFAULT 1,
  error_code text,
  error_message text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  created_by uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS invoice_delivery_attempts_provider_message_id_uidx
  ON public.invoice_delivery_attempts (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS invoice_delivery_attempts_trip_id_idx
  ON public.invoice_delivery_attempts (trip_id, created_at DESC);

-- 5) Feature flags (default off until production gate)
INSERT INTO public.admin_settings (setting_key, setting_value)
VALUES
  ('invoice_auto_send_enabled', 'false'::jsonb),
  ('invoice_outbox_worker_enabled', 'false'::jsonb),
  ('invoice_historical_send_enabled', 'false'::jsonb)
ON CONFLICT (setting_key) DO NOTHING;

COMMIT;
