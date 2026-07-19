ALTER TABLE public.company_transfer_payment_reference_counters ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.company_transfer_payment_reference_counters FROM anon, authenticated;
GRANT ALL ON public.company_transfer_payment_reference_counters TO service_role;

DROP POLICY IF EXISTS "service_role_full_access" ON public.company_transfer_payment_reference_counters;
CREATE POLICY "service_role_full_access"
  ON public.company_transfer_payment_reference_counters
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);