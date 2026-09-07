-- ============================================================
-- Phase 3 Batch 3D4: invoice number authorization
-- NOT APPLIED until explicitly approved.
--
-- Retains authenticated EXECUTE. Body gate only. Signature and sequence logic unchanged.
-- ACL only unless this file explicitly replaces generate_invoice_number.
-- Does not touch the later cash completion draft.
-- Nested SECURITY DEFINER / trigger callers keep postgres EXECUTE.
-- ============================================================

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
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.staff_has_page_access('statement-runs') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

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

COMMENT ON FUNCTION public.generate_invoice_number() IS
  'Batch3D4: service_role OR staff_has_page_access(statement-runs). Fail closed. Sequence logic unchanged.';

COMMIT;
