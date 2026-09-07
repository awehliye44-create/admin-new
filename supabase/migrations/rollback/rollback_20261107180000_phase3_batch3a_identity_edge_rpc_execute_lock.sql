-- EMERGENCY ROLLBACK for 20261107180000_phase3_batch3a_identity_edge_rpc_execute_lock.sql
-- Restores the exact pre-Batch3A authenticated EXECUTE grants.
-- Does not restore PUBLIC or anon (baseline had neither).
-- Does not alter function bodies. Re-opens the identity RPC holes — emergency only.

BEGIN;

GRANT EXECUTE ON FUNCTION public.reset_auth_user_email_unconfirmed(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_id_by_email(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_account_email_verified(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stage_phone_change(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stage_email_change(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_phone_change_pending(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_phone_change_customer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_phone_change_driver(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_email_change_customer(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_email_change_driver(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_customer_onboarding(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_customer_phone_verification(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_driver_phone_verification(uuid) TO authenticated;

COMMIT;
