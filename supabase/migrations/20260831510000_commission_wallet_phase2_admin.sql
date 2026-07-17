-- P0 Phase 2 — Commission Wallet Admin credit + audit + RBAC.
-- Dispatch still disabled (no reserve / eligibility writers).

CREATE TABLE IF NOT EXISTS public.commission_wallet_admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL,
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  service_area_id uuid NOT NULL REFERENCES public.service_areas(id),
  action text NOT NULL,
  credit_type text,
  amount_minor integer,
  currency text,
  reason text,
  campaign_id uuid REFERENCES public.commission_wallet_campaigns(id),
  ledger_entry_id uuid REFERENCES public.driver_commission_wallet_ledger(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commission_wallet_admin_audit_driver_idx
  ON public.commission_wallet_admin_audit (driver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS commission_wallet_admin_audit_sa_idx
  ON public.commission_wallet_admin_audit (service_area_id, created_at DESC);

ALTER TABLE public.commission_wallet_admin_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commission_wallet_admin_audit_admin_read ON public.commission_wallet_admin_audit;
CREATE POLICY commission_wallet_admin_audit_admin_read
  ON public.commission_wallet_admin_audit
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
    )
  );

-- RBAC for Commission Wallet admin page
INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES
  ('super_admin', 'commission-wallet', true),
  ('admin', 'commission-wallet', true),
  ('finance_manager', 'commission-wallet', true)
ON CONFLICT (role, page_slug) DO UPDATE
SET can_access = EXCLUDED.can_access;
