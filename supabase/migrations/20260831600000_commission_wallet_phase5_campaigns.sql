-- P0 Phase 5 — Commission Wallet campaign claims + one active top-up bonus per SA.

CREATE TABLE IF NOT EXISTS public.commission_wallet_campaign_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.commission_wallet_campaigns(id),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  service_area_id uuid NOT NULL REFERENCES public.service_areas(id),
  claim_kind text NOT NULL
    CHECK (claim_kind IN ('welcome', 'topup_bonus', 'manual')),
  topup_id uuid REFERENCES public.driver_commission_wallet_topups(id),
  ledger_entry_id uuid REFERENCES public.driver_commission_wallet_ledger(id),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS commission_wallet_campaign_claims_idempotency_uidx
  ON public.commission_wallet_campaign_claims (idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS commission_wallet_campaign_claims_topup_uidx
  ON public.commission_wallet_campaign_claims (campaign_id, topup_id)
  WHERE topup_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS commission_wallet_campaign_claims_welcome_uidx
  ON public.commission_wallet_campaign_claims (campaign_id, driver_id)
  WHERE claim_kind = 'welcome';

CREATE INDEX IF NOT EXISTS commission_wallet_campaign_claims_campaign_idx
  ON public.commission_wallet_campaign_claims (campaign_id, created_at DESC);

-- At most one active top-up bonus campaign per service area.
CREATE UNIQUE INDEX IF NOT EXISTS commission_wallet_campaigns_one_active_topup_bonus_uidx
  ON public.commission_wallet_campaigns (service_area_id)
  WHERE active = true
    AND campaign_type IN ('TOP_UP_PERCENT_BONUS', 'FIXED_TOP_UP_BONUS');

ALTER TABLE public.commission_wallet_campaign_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commission_wallet_campaign_claims_driver_read ON public.commission_wallet_campaign_claims;
CREATE POLICY commission_wallet_campaign_claims_driver_read
  ON public.commission_wallet_campaign_claims
  FOR SELECT
  TO authenticated
  USING (
    driver_id IN (SELECT id FROM public.drivers WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS commission_wallet_campaign_claims_admin_read ON public.commission_wallet_campaign_claims;
CREATE POLICY commission_wallet_campaign_claims_admin_read
  ON public.commission_wallet_campaign_claims
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

COMMENT ON TABLE public.commission_wallet_campaign_claims IS
  'Phase 5: race-safe claim tracking for welcome / top-up bonus / manual promo campaigns.';
