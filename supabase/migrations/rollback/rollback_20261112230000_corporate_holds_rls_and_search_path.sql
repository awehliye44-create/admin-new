-- Rollback 20261112230000_corporate_holds_rls_and_search_path
-- Restores prior exposure — only for emergency rollback review.

BEGIN;

ALTER TABLE public.corporate_schedule_holds NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.corporate_schedule_holds DISABLE ROW LEVEL SECURITY;

-- Prior migration did not set explicit grants; leave service_role grants in place.

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

COMMIT;
