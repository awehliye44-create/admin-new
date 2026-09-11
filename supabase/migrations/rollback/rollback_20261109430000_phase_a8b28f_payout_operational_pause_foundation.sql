-- ============================================================
-- Rollback: 20261109430000_phase_a8b28f_payout_operational_pause_foundation
--
-- PRECONDITION: Safe ONLY while Stage A remains additive and BEFORE
-- Stage B or Stage C depend on payout_operational_paused / helpers.
-- If Stage B or Stage C have been applied, roll those back FIRST.
--
-- Does NOT:
--   - alter legacy drivers.payouts_enabled
--   - reverse provider verification / destination status
--   - mutate wallet ledger, payouts, payment sessions, or trips
--   - restore unsafe grants
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.driver_effective_payout_allowed(uuid);
DROP FUNCTION IF EXISTS public.driver_has_provider_verified_payout_destination(uuid);

ALTER TABLE public.drivers
  DROP COLUMN IF EXISTS payout_operational_paused;

COMMIT;
