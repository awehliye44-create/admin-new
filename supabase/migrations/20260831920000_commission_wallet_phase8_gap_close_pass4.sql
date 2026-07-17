-- Phase 8 gap-close pass 4:
-- 1) Auto-grant commission_wallet_test_access for drivers assigned to the pilot SA
-- 2) Re-grant existing Banadir drivers (idempotent)
-- 3) Clear Banadir digital customer gateway so stale clients cannot open Stripe/Revolut
-- 4) Disable Banadir digital payment method flags

-- While multi_sa_unlocked=false, any driver whose service_area_id is the pilot SA
-- must have CW page/top-up access (Phase 3 flag). New Banadir drivers were missing this.
CREATE OR REPLACE FUNCTION public.auto_grant_commission_wallet_pilot_test_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rollout public.commission_wallet_rollout%ROWTYPE;
BEGIN
  SELECT * INTO v_rollout
  FROM public.commission_wallet_rollout
  WHERE id IS TRUE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_rollout.multi_sa_unlocked IS TRUE THEN
    RETURN NEW;
  END IF;

  IF NEW.service_area_id IS DISTINCT FROM v_rollout.pilot_service_area_id THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.commission_wallet_test_access, false) IS TRUE THEN
    RETURN NEW;
  END IF;

  -- Allow Phase 3 lock trigger regardless of firing order.
  PERFORM set_config('onecab.commission_wallet_test_access_admin', '1', true);
  NEW.commission_wallet_test_access := true;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_grant_cw_pilot_test_access ON public.drivers;
CREATE TRIGGER trg_auto_grant_cw_pilot_test_access
  BEFORE INSERT OR UPDATE OF service_area_id
  ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_grant_commission_wallet_pilot_test_access();

COMMENT ON FUNCTION public.auto_grant_commission_wallet_pilot_test_access() IS
  'Phase 8: auto-grant commission_wallet_test_access while driver is on the locked pilot SA.';

-- Idempotent re-grant for existing Banadir pilot drivers.
SELECT set_config('onecab.commission_wallet_test_access_admin', '1', true);
UPDATE public.drivers
SET commission_wallet_test_access = true
WHERE service_area_id = '29259edf-80eb-4c08-9089-352b8a305b81'
  AND commission_wallet_test_access IS DISTINCT FROM true;

-- Banadir is cash-upfront only — clear digital collection gateway.
-- commission_topup_provider (waafi_pay) is separate and unchanged.
UPDATE public.service_areas
SET
  payment_provider = NULL,
  customer_payment_gateway = NULL,
  driver_payout_gateway = NULL,
  updated_at = now()
WHERE id = '29259edf-80eb-4c08-9089-352b8a305b81';

UPDATE public.service_area_payment_methods
SET
  cash_enabled = true,
  card_enabled = false,
  wallet_enabled = false,
  apple_pay_enabled = false,
  google_pay_enabled = false,
  updated_at = now()
WHERE service_area_id = '29259edf-80eb-4c08-9089-352b8a305b81';

UPDATE public.commission_wallet_rollout
SET
  unlocked_note = 'Phase 8 gap-close pass 4: Banadir pilot only; auto test_access + no digital gateway',
  updated_at = now()
WHERE id IS TRUE;
