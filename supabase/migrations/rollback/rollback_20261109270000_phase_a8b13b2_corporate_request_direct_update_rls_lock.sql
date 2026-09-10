-- Rollback Phase A8B13B2. Restores pre-closure Admin ALL policy.

DROP POLICY IF EXISTS "Admins can select account requests"
  ON public.corporate_account_requests;

CREATE POLICY "Admins can manage account requests"
  ON public.corporate_account_requests
  FOR ALL
  USING (public.has_role(auth.uid(), 'admin'::app_role));
