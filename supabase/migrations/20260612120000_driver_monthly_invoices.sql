-- Driver monthly invoice enhancements: breakdown columns, email/PDF fields, template email settings.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS card_trip_earnings_pence bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_trip_earnings_pence bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS airport_fee_earnings_pence bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_charge_earnings_pence bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS card_trips integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_trips integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invoice_pdf_url text,
  ADD COLUMN IF NOT EXISTS invoice_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS invoice_email_sent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS invoice_email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS invoice_email_status text,
  ADD COLUMN IF NOT EXISTS invoice_email_error text;

ALTER TABLE public.invoice_templates
  ADD COLUMN IF NOT EXISTS template_type text NOT NULL DEFAULT 'driver_monthly',
  ADD COLUMN IF NOT EXISTS email_subject text,
  ADD COLUMN IF NOT EXISTS email_body text,
  ADD COLUMN IF NOT EXISTS auto_email_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS footer_text text,
  ADD COLUMN IF NOT EXISTS company_website text;

CREATE TABLE IF NOT EXISTS public.driver_invoice_monthly_sequences (
  invoice_month text PRIMARY KEY,
  last_seq integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION public.generate_invoice_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ym text := to_char(timezone('UTC', now()), 'YYMM');
  seq int;
BEGIN
  LOOP
    UPDATE public.driver_invoice_monthly_sequences
    SET last_seq = last_seq + 1
    WHERE invoice_month = ym
    RETURNING last_seq INTO seq;

    IF FOUND THEN
      RETURN 'INV-' || ym || '-' || lpad(seq::text, 3, '0');
    END IF;

    BEGIN
      INSERT INTO public.driver_invoice_monthly_sequences (invoice_month, last_seq)
      VALUES (ym, 1)
      RETURNING last_seq INTO seq;
      RETURN 'INV-' || ym || '-' || lpad(seq::text, 3, '0');
    EXCEPTION
      WHEN unique_violation THEN
        NULL;
    END;
  END LOOP;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS invoices_driver_period_unique
  ON public.invoices (driver_id, region_id, period_start, period_end)
  WHERE status NOT IN ('cancelled');

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('driver-invoices', 'driver-invoices', false, 10485760)
ON CONFLICT (id) DO NOTHING;

UPDATE public.invoice_templates
SET
  email_subject = COALESCE(email_subject, 'Your ONECAB Monthly Earnings Statement - {{invoiceNo}}'),
  template_type = COALESCE(template_type, 'driver_monthly')
WHERE is_default = true;
