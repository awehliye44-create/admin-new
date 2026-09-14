-- Rollback audit columns and the in-flight receipt index.
-- Does not restore automatic receipt email. That path stays disabled.

BEGIN;

DROP INDEX IF EXISTS public.invoice_email_outbox_one_inflight_receipt;

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_invoice_email_source_check;

ALTER TABLE public.trips
  DROP COLUMN IF EXISTS invoice_email_source,
  DROP COLUMN IF EXISTS invoice_email_sent_by,
  DROP COLUMN IF EXISTS invoice_email_recipient;

COMMIT;
