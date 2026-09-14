-- Manual trip receipt email.
-- Completing a trip or capturing payment must not email a receipt.
-- The invoice row/PDF may still be stored. Email is a later customer/admin action.

BEGIN;

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS invoice_email_recipient text,
  ADD COLUMN IF NOT EXISTS invoice_email_sent_by uuid,
  ADD COLUMN IF NOT EXISTS invoice_email_source text;

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_invoice_email_source_check;

ALTER TABLE public.trips
  ADD CONSTRAINT trips_invoice_email_source_check
  CHECK (
    invoice_email_source IS NULL
    OR invoice_email_source IN ('customer_app', 'admin_panel')
  );

COMMENT ON COLUMN public.trips.invoice_email_recipient IS
  'Last receipt email address a manual send attempted or completed.';
COMMENT ON COLUMN public.trips.invoice_email_sent_by IS
  'Auth user who requested the last manual receipt email.';
COMMENT ON COLUMN public.trips.invoice_email_source IS
  'customer_app or admin_panel. Never set by completion or capture.';

-- One in-flight receipt email per trip. A second rapid tap cannot insert another send.
DO $$
BEGIN
  IF to_regclass('public.invoice_email_outbox') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS invoice_email_outbox_one_inflight_receipt
      ON public.invoice_email_outbox (trip_id)
      WHERE status IN ('pending', 'sending')
        AND email_type IN (
          'customer_trip_receipt_manual',
          'customer_trip_receipt',
          'customer_trip_receipt_admin_resend'
        );
  END IF;
END $$;

-- Completion may ask the invoice function to store a PDF. It must not email.
CREATE OR REPLACE FUNCTION public.trg_trip_invoice_on_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.status = 'completed'
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.invoke_trip_invoice_process(NEW.id, 'generate_only');
  END IF;
  RETURN NEW;
END;
$fn$;

-- The existing cron job stays scheduled so it does not get recreated, but it must not email.
CREATE OR REPLACE FUNCTION public.sweep_trip_invoice_emails()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  RAISE LOG '[trip-invoice-sweep] suppressed reason=manual_receipt_only';
  RETURN;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.trg_trip_invoice_on_completion() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sweep_trip_invoice_emails() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_trip_invoice_emails() TO service_role;

COMMIT;
