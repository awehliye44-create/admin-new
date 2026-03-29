
-- Fix search_path on generate_invoice_number
CREATE OR REPLACE FUNCTION public.generate_invoice_number()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  RETURN 'INV-' || to_char(now(), 'YYYYMM') || '-' || lpad(nextval('public.invoice_number_seq')::text, 5, '0');
END;
$$;
