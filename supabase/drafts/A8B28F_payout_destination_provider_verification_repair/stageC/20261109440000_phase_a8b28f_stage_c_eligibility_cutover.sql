-- A8B28F Stage C — DRAFT / NOT APPLIED — DO NOT RUN BEFORE STAGE B IS LIVE
-- 20261109440000_phase_a8b28f_stage_c_eligibility_cutover.sql
--
-- Cutover ONLY:
--   Replace driver_wallet_eligibility_balances short-circuit:
--     FROM: IF coalesce(payouts_enabled,true) IS NOT TRUE THEN available=0; pending=live
--     TO:   IF coalesce(payout_operational_paused,false) IS TRUE THEN available=0; pending=live
--
-- Verification MUST NOT zero Available after Stage B UX ships.
-- Withdrawability continues via get_driver_own_wallet_summary / withdraw RPCs using
-- driver_effective_payout_allowed (Stage C updates that helper to drop legacy requirement).
--
-- Apply tooling must paste the FULL live function body and change only the gate +
-- update driver_effective_payout_allowed to:
--   remove "IF coalesce(v_legacy,false) IS NOT TRUE THEN RETURN false"
--   keep operational pause + provider verified + global + approval/suspend
--
-- Also update get_driver_own_wallet_summary early block:
--   REPLACE: payouts_enabled false → DRIVER_SUSPENDED
--   WITH:    payout_operational_paused true → map to a pause reason (not suspended)
--            AND keep PAYOUT_ACCOUNT_NOT_VERIFIED for !provider verified
--
-- Clearing math, PLATFORM vs DRIVER_COLLECTED exclusion, debt, reservations: unchanged.
-- MK0006 must remain non-withdrawable until provider verify succeeds post-deploy.

-- SUPERSEDED by draft:
--   supabase/drafts/A8B28F_stage_c/migrations/20261109470000_phase_a8b28f_stage_c_wallet_payout_eligibility_cutover.sql
-- Keep this file as a non-executable pointer only.

SELECT 'A8B28F_STAGE_C_PLACEHOLDER_SUPERSEDED_BY_20261109470000' AS status;
