-- Phase 3D.3 — Connect auto-payout lockdown audit trail

CREATE TABLE IF NOT EXISTS public.stripe_connect_payout_schedule_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid REFERENCES public.drivers(id),
  stripe_account_id text NOT NULL,
  action text NOT NULL,
  before_interval text,
  before_delay_days int,
  after_interval text,
  after_delay_days int,
  in_flight_payout_ids jsonb,
  connect_available_pence int,
  connect_pending_pence int,
  performed_by uuid,
  dry_run boolean NOT NULL DEFAULT false,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_connect_payout_audit_driver
  ON public.stripe_connect_payout_schedule_audit(driver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stripe_connect_payout_audit_account
  ON public.stripe_connect_payout_schedule_audit(stripe_account_id, created_at DESC);

COMMENT ON TABLE public.stripe_connect_payout_schedule_audit IS
  'Phase 3D.3 — before/after Connect payout schedule changes (manual lockdown).';

ALTER TABLE public.stripe_connect_payout_schedule_audit ENABLE ROW LEVEL SECURITY;

CREATE POLICY stripe_connect_payout_audit_service_role
  ON public.stripe_connect_payout_schedule_audit
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY stripe_connect_payout_audit_admin_read
  ON public.stripe_connect_payout_schedule_audit
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
    )
  );
