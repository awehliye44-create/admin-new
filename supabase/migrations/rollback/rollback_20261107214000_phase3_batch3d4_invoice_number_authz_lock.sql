-- Rollback Batch 3D4. Restores the unguarded generate_invoice_number body. Does not remove any grant.

BEGIN;

CREATE OR REPLACE FUNCTION public.generate_invoice_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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
$fn$;


COMMIT;
