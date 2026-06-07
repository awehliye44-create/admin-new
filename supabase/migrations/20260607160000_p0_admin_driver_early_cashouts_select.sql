-- Allow admins to read driver early cashouts for Payout Batches audit UI
DROP POLICY IF EXISTS "Admins can view all driver early cashouts" ON public.driver_early_cashouts;
CREATE POLICY "Admins can view all driver early cashouts"
  ON public.driver_early_cashouts
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));
