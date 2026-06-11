-- Customer trip invoice fields, sequences, event log, and storage bucket.

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS invoice_no text,
  ADD COLUMN IF NOT EXISTS invoice_pdf_url text,
  ADD COLUMN IF NOT EXISTS invoice_pdf_path text,
  ADD COLUMN IF NOT EXISTS invoice_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS invoice_pdf_error text,
  ADD COLUMN IF NOT EXISTS invoice_email_sent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS invoice_email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS invoice_email_status text,
  ADD COLUMN IF NOT EXISTS invoice_email_error text,
  ADD COLUMN IF NOT EXISTS invoice_regenerated_at timestamptz,
  ADD COLUMN IF NOT EXISTS invoice_total_paid_pence integer;

CREATE UNIQUE INDEX IF NOT EXISTS trips_invoice_no_unique
  ON public.trips (invoice_no)
  WHERE invoice_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.trip_invoice_daily_sequences (
  invoice_date date PRIMARY KEY,
  last_seq integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION public.next_trip_invoice_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d date := (timezone('UTC', now()))::date;
  ymd text := to_char(d, 'YYMMDD');
  seq int;
BEGIN
  LOOP
    UPDATE public.trip_invoice_daily_sequences
    SET last_seq = last_seq + 1
    WHERE invoice_date = d
    RETURNING last_seq INTO seq;

    IF FOUND THEN
      RETURN 'INV-' || ymd || '-' || lpad(seq::text, 3, '0');
    END IF;

    BEGIN
      INSERT INTO public.trip_invoice_daily_sequences (invoice_date, last_seq)
      VALUES (d, 1)
      RETURNING last_seq INTO seq;
      RETURN 'INV-' || ymd || '-' || lpad(seq::text, 3, '0');
    EXCEPTION
      WHEN unique_violation THEN
        NULL;
    END;
  END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS public.trip_invoice_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  status text,
  message text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_invoice_events_trip_id_idx
  ON public.trip_invoice_events (trip_id, created_at DESC);

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('trip-invoices', 'trip-invoices', false, 10485760)
ON CONFLICT (id) DO NOTHING;

COMMENT ON COLUMN public.trips.invoice_pdf_url IS 'Public or signed URL for the customer invoice PDF';
COMMENT ON COLUMN public.trips.invoice_pdf_path IS 'Storage path inside trip-invoices bucket';
