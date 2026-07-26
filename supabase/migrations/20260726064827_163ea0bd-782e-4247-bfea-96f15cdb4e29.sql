ALTER TABLE public.driver_id_allocation_exceptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.driver_id_allocation_exceptions FROM anon, authenticated;
GRANT SELECT ON public.driver_id_allocation_exceptions TO authenticated;
GRANT ALL ON public.driver_id_allocation_exceptions TO service_role;

CREATE POLICY "Admins can view driver id allocation exceptions"
  ON public.driver_id_allocation_exceptions
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));