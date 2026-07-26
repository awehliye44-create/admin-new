-- P0: Remove Phase 8 Banadir-only Commission Wallet pilot lock.
-- Every Service Area may enable CW via its own financial_model + flags.
-- Does NOT change existing PLATFORM_COLLECTED Service Areas.

UPDATE public.commission_wallet_rollout
SET
  multi_sa_unlocked = true,
  unlocked_at = COALESCE(unlocked_at, now()),
  unlocked_note = COALESCE(
    unlocked_note,
    'P0 multi-SA unlock: Banadir pilot lock removed; Service Area config only'
  ),
  updated_at = now()
WHERE id IS TRUE
  AND multi_sa_unlocked IS DISTINCT FROM true;

COMMENT ON TABLE public.commission_wallet_rollout IS
  'Historical Commission Wallet rollout row. multi_sa_unlocked=true — enablement is per Service Area config only.';

DROP TRIGGER IF EXISTS trg_enforce_commission_wallet_pilot_lock ON public.service_areas;

-- Replace Banadir pilot lock with financial_model consistency only (no SA id/name).
CREATE OR REPLACE FUNCTION public.enforce_commission_wallet_financial_model()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.commission_wallet_enabled IS TRUE
     AND NEW.financial_model IS DISTINCT FROM 'DRIVER_COLLECTED_COMMISSION_WALLET'
  THEN
    RAISE EXCEPTION
      'COMMISSION_WALLET_CONFIG: commission_wallet_enabled requires financial_model=DRIVER_COLLECTED_COMMISSION_WALLET'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_commission_wallet_financial_model ON public.service_areas;
CREATE TRIGGER trg_enforce_commission_wallet_financial_model
  BEFORE INSERT OR UPDATE OF commission_wallet_enabled, financial_model
  ON public.service_areas
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_commission_wallet_financial_model();

COMMENT ON FUNCTION public.enforce_commission_wallet_financial_model() IS
  'Commission Wallet enabled requires DRIVER_COLLECTED_COMMISSION_WALLET. No service-area name/id lock.';

DROP FUNCTION IF EXISTS public.enforce_commission_wallet_pilot_lock();
