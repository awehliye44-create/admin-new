ALTER TABLE public.driver_wallet_ledger ADD COLUMN IF NOT EXISTS provider_payout_id text;
CREATE INDEX IF NOT EXISTS idx_driver_wallet_ledger_provider_payout_id ON public.driver_wallet_ledger(provider_payout_id) WHERE provider_payout_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.revolut_merchant_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revolut_payout_id text NOT NULL UNIQUE,
  state text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  scheduled_for timestamptz,
  completed_at timestamptz,
  reference text,
  raw jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.revolut_merchant_payouts TO authenticated;
GRANT ALL ON public.revolut_merchant_payouts TO service_role;

ALTER TABLE public.revolut_merchant_payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read merchant payouts"
  ON public.revolut_merchant_payouts
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE OR REPLACE FUNCTION public.set_updated_at_revolut_merchant_payouts()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS trg_revolut_merchant_payouts_updated_at ON public.revolut_merchant_payouts;
CREATE TRIGGER trg_revolut_merchant_payouts_updated_at
  BEFORE UPDATE ON public.revolut_merchant_payouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_revolut_merchant_payouts();