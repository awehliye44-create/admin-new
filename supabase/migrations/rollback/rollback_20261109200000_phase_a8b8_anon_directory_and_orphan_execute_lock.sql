-- EMERGENCY ROLLBACK for 20261109200000_phase_a8b8_anon_directory_and_orphan_execute_lock.sql
-- Restores the legitimate pre-change grants:
--   authenticated + service_role EXECUTE on every target.
-- Does not restore the prior directory regression grant.
-- Does not alter bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.admin_user_directory() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_directory() TO service_role;

GRANT EXECUTE ON FUNCTION public.adjust_merchant_credits(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_merchant_credits(uuid, integer, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.approve_merchant_with_credits(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_merchant_with_credits(uuid, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_driver_wallet_balance(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_wallet_balance(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.ops_retry_failed_payout(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_retry_failed_payout(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.check_driver_documents_approved(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_driver_documents_approved(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.reject_roles_action(text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_roles_action(text, text, jsonb) TO service_role;

GRANT EXECUTE ON FUNCTION public.log_roles_audit(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_roles_audit(text, jsonb) TO service_role;

GRANT EXECUTE ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.dispatchable_reason(uuid, integer, boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispatchable_reason(uuid, integer, boolean, integer) TO service_role;

COMMIT;
