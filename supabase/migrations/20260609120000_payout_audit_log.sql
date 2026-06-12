-- Payout audit log for early cash-out validation and provider failures.

CREATE TABLE IF NOT EXISTS public.payout_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid REFERENCES public.drivers(id) ON DELETE SET NULL,
  payout_type text NOT NULL DEFAULT 'early_cashout',
  event_type text NOT NULL,
  requested_amount_pence integer,
  provider_balance_pence integer,
  provider_error_code text,
  provider_error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payout_audit_log_driver_created
  ON public.payout_audit_log(driver_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payout_audit_log_event_type
  ON public.payout_audit_log(event_type, created_at DESC);

ALTER TABLE public.payout_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY payout_audit_log_service_role
  ON public.payout_audit_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.payout_audit_log IS
  'Diagnostics for payout validation failures (min amount, provider balance, Stripe errors).';
