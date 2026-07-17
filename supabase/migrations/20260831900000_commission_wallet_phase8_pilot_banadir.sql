-- Phase 8: enable ONE African pilot Service Area (Banadir / Mogadishu) only.
-- Block enabling any other SA until multi_sa_unlocked after reconciliation.

CREATE TABLE IF NOT EXISTS public.commission_wallet_rollout (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  pilot_service_area_id uuid NOT NULL REFERENCES public.service_areas (id),
  multi_sa_unlocked boolean NOT NULL DEFAULT false,
  reconciliation_passed_at timestamptz,
  unlocked_at timestamptz,
  unlocked_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.commission_wallet_rollout IS
  'Phase 8 Commission Wallet rollout lock. multi_sa_unlocked=false → only pilot_service_area_id may have commission_wallet_enabled.';

ALTER TABLE public.commission_wallet_rollout ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commission_wallet_rollout_admin_read ON public.commission_wallet_rollout;
CREATE POLICY commission_wallet_rollout_admin_read
  ON public.commission_wallet_rollout
  FOR SELECT
  TO authenticated
  USING (true);

-- Banadir (Mogadishu region) — sole Phase 8 pilot.
UPDATE public.service_areas
SET
  financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET',
  commission_wallet_enabled = true,
  commission_reserve_enabled = true,
  commission_wallet_currency = 'USD',
  commission_topup_provider = 'waafi_pay',
  customer_payment_policy = 'DRIVER_COLLECTS_UPFRONT',
  cash_upfront_policy_notice = COALESCE(
    NULLIF(btrim(cash_upfront_policy_notice), ''),
    'Payment is payable directly to the driver upfront. The driver is responsible for collecting payment and may cancel the booking if payment is not provided.'
  ),
  updated_at = now()
WHERE id = '29259edf-80eb-4c08-9089-352b8a305b81'
  AND name = 'Banadir';

INSERT INTO public.commission_wallet_rollout (
  id,
  pilot_service_area_id,
  multi_sa_unlocked,
  unlocked_note
)
VALUES (
  true,
  '29259edf-80eb-4c08-9089-352b8a305b81',
  false,
  'Phase 8: Banadir (Mogadishu) pilot only until reconciliation passes'
)
ON CONFLICT (id) DO UPDATE
SET
  pilot_service_area_id = EXCLUDED.pilot_service_area_id,
  multi_sa_unlocked = false,
  unlocked_note = EXCLUDED.unlocked_note,
  updated_at = now();

-- Ensure no non-pilot SA is enabled (idempotent safety).
UPDATE public.service_areas
SET
  commission_wallet_enabled = false,
  commission_reserve_enabled = false,
  financial_model = 'PLATFORM_COLLECTED',
  customer_payment_policy = 'PLATFORM_PREPAID',
  updated_at = now()
WHERE id <> '29259edf-80eb-4c08-9089-352b8a305b81'
  AND (
    commission_wallet_enabled IS TRUE
    OR financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
  );

CREATE OR REPLACE FUNCTION public.enforce_commission_wallet_pilot_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rollout public.commission_wallet_rollout%ROWTYPE;
  v_other uuid;
BEGIN
  IF NEW.commission_wallet_enabled IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Already enabled: allow other field updates on the same SA.
  IF TG_OP = 'UPDATE' AND OLD.commission_wallet_enabled IS TRUE THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_rollout
  FROM public.commission_wallet_rollout
  WHERE id IS TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'COMMISSION_WALLET_PILOT_LOCK: rollout row missing — cannot enable Commission Wallet'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_rollout.multi_sa_unlocked IS TRUE THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM v_rollout.pilot_service_area_id THEN
    RAISE EXCEPTION
      'COMMISSION_WALLET_PILOT_LOCK: only pilot service area % may enable Commission Wallet until reconciliation unlocks multi-SA',
      v_rollout.pilot_service_area_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT sa.id INTO v_other
  FROM public.service_areas sa
  WHERE sa.commission_wallet_enabled IS TRUE
    AND sa.id IS DISTINCT FROM NEW.id
  LIMIT 1;

  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION
      'COMMISSION_WALLET_PILOT_LOCK: another service area (%) already has Commission Wallet enabled',
      v_other
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_commission_wallet_pilot_lock ON public.service_areas;
CREATE TRIGGER trg_enforce_commission_wallet_pilot_lock
  BEFORE INSERT OR UPDATE OF commission_wallet_enabled, financial_model
  ON public.service_areas
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_commission_wallet_pilot_lock();
