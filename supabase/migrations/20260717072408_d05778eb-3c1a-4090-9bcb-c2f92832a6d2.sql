ALTER TABLE public.company_funding_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_transfer_payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_go_driver_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_email_confirm_reconcile_audit ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS; no anon/authenticated policies = deny by default.
-- Admins may read these financial/audit tables via a security-definer helper.
CREATE POLICY "Admins can view company funding holds"
  ON public.company_funding_holds FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can view company transfer payment intents"
  ON public.company_transfer_payment_intents FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can view scan go driver holds"
  ON public.scan_go_driver_holds FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can view customer email reconcile audit"
  ON public.customer_email_confirm_reconcile_audit FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));