-- Receipt email evidence is written only by send-trip-receipt (service role).
-- App clients must not mark a trip Sent without an email.

CREATE OR REPLACE FUNCTION public.protect_trip_invoice_email_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_role text := auth.role();
BEGIN
  IF v_role IS NULL OR v_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF NEW.invoice_email_sent IS DISTINCT FROM OLD.invoice_email_sent
     OR NEW.invoice_email_sent_at IS DISTINCT FROM OLD.invoice_email_sent_at
     OR NEW.invoice_email_status IS DISTINCT FROM OLD.invoice_email_status
     OR NEW.invoice_email_error IS DISTINCT FROM OLD.invoice_email_error
     OR NEW.invoice_email_recipient IS DISTINCT FROM OLD.invoice_email_recipient
     OR NEW.invoice_email_sent_by IS DISTINCT FROM OLD.invoice_email_sent_by
     OR NEW.invoice_email_source IS DISTINCT FROM OLD.invoice_email_source
  THEN
    RAISE EXCEPTION 'invoice email fields are written only by the receipt sender'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_trip_invoice_email_columns ON public.trips;

CREATE TRIGGER trg_protect_trip_invoice_email_columns
  BEFORE UPDATE ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_trip_invoice_email_columns();

REVOKE UPDATE (
  invoice_email_sent,
  invoice_email_sent_at,
  invoice_email_status,
  invoice_email_error,
  invoice_email_recipient,
  invoice_email_sent_by,
  invoice_email_source
) ON public.trips FROM anon, authenticated;
