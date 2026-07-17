-- Phase 8 gap-close:
-- 1) Lock financial_model=DRIVER_COLLECTED to pilot SA while multi_sa_unlocked=false
-- 2) Re-assert Banadir enable by id only (no fragile name guard)
-- 3) Grant commission_wallet_test_access to Banadir pilot drivers (page/top-up QA)

CREATE OR REPLACE FUNCTION public.enforce_commission_wallet_pilot_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rollout public.commission_wallet_rollout%ROWTYPE;
  v_other uuid;
  v_enabling_wallet boolean;
  v_adopting_africa_model boolean;
BEGIN
  SELECT * INTO v_rollout
  FROM public.commission_wallet_rollout
  WHERE id IS TRUE;

  IF NOT FOUND THEN
    -- Fail closed if wallet is being turned on without rollout row.
    IF NEW.commission_wallet_enabled IS TRUE
       AND (TG_OP = 'INSERT' OR OLD.commission_wallet_enabled IS DISTINCT FROM TRUE)
    THEN
      RAISE EXCEPTION
        'COMMISSION_WALLET_PILOT_LOCK: rollout row missing — cannot enable Commission Wallet'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF v_rollout.multi_sa_unlocked IS TRUE THEN
    RETURN NEW;
  END IF;

  v_enabling_wallet :=
    NEW.commission_wallet_enabled IS TRUE
    AND (
      TG_OP = 'INSERT'
      OR OLD.commission_wallet_enabled IS DISTINCT FROM TRUE
    );

  v_adopting_africa_model :=
    NEW.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
    AND (
      TG_OP = 'INSERT'
      OR OLD.financial_model IS DISTINCT FROM 'DRIVER_COLLECTED_COMMISSION_WALLET'
    );

  IF NOT v_enabling_wallet AND NOT v_adopting_africa_model THEN
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM v_rollout.pilot_service_area_id THEN
    RAISE EXCEPTION
      'COMMISSION_WALLET_PILOT_LOCK: only pilot service area % may adopt DRIVER_COLLECTED / enable Commission Wallet until reconciliation unlocks multi-SA',
      v_rollout.pilot_service_area_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_enabling_wallet THEN
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

-- Banadir by id only.
UPDATE public.service_areas
SET
  financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET',
  commission_wallet_enabled = true,
  commission_reserve_enabled = true,
  commission_wallet_currency = COALESCE(NULLIF(btrim(commission_wallet_currency), ''), 'USD'),
  commission_topup_provider = COALESCE(NULLIF(btrim(commission_topup_provider), ''), 'waafi_pay'),
  customer_payment_policy = 'DRIVER_COLLECTS_UPFRONT',
  cash_upfront_policy_notice = COALESCE(
    NULLIF(btrim(cash_upfront_policy_notice), ''),
    'Payment is payable directly to the driver upfront. The driver is responsible for collecting payment and may cancel the booking if payment is not provided.'
  ),
  updated_at = now()
WHERE id = '29259edf-80eb-4c08-9089-352b8a305b81';

UPDATE public.commission_wallet_rollout
SET
  pilot_service_area_id = '29259edf-80eb-4c08-9089-352b8a305b81',
  multi_sa_unlocked = false,
  unlocked_note = 'Phase 8 gap-close: Banadir pilot only until reconciliation passes',
  updated_at = now()
WHERE id IS TRUE;

-- Pilot drivers in Banadir need test access for CW page / Waafi sandbox top-up.
-- Session flag required: login-role SQL is not service_role.
SELECT set_config('onecab.commission_wallet_test_access_admin', '1', true);
UPDATE public.drivers
SET commission_wallet_test_access = true
WHERE service_area_id = '29259edf-80eb-4c08-9089-352b8a305b81'
  AND commission_wallet_test_access IS DISTINCT FROM true;
