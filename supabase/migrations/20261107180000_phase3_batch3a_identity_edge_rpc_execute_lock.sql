-- ============================================================
-- Phase 3 Batch 3A: identity/auth Edge-only RPC EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function body, signature, return type, RLS, or data change.
--
-- Proven callers are Edge Functions using SUPABASE_SERVICE_ROLE_KEY.
-- No Customer/Driver/Admin/Corporate/Guest .rpc(), no cron, no trigger,
-- no SECURITY INVOKER nested caller. handle_new_customer mentions
-- finalize_customer_onboarding in a comment only and does not call it.
-- Historical migration 20260612160000 is already applied and is not a live caller.
-- ============================================================

BEGIN;

-- Edge identity writers / lookups: service_role (+ postgres owner) only
REVOKE ALL ON FUNCTION public.reset_auth_user_email_unconfirmed(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_auth_user_email_unconfirmed(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reset_auth_user_email_unconfirmed(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reset_auth_user_email_unconfirmed(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_user_id_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_id_by_email(text) FROM anon;
REVOKE ALL ON FUNCTION public.get_user_id_by_email(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_id_by_email(text) TO service_role;

REVOKE ALL ON FUNCTION public.mark_account_email_verified(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_account_email_verified(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.mark_account_email_verified(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mark_account_email_verified(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.stage_phone_change(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stage_phone_change(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.stage_phone_change(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.stage_phone_change(uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.stage_email_change(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stage_email_change(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.stage_email_change(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.stage_email_change(uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.clear_phone_change_pending(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_phone_change_pending(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.clear_phone_change_pending(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.clear_phone_change_pending(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.complete_phone_change_customer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_phone_change_customer(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.complete_phone_change_customer(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_phone_change_customer(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.complete_phone_change_driver(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_phone_change_driver(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.complete_phone_change_driver(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_phone_change_driver(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.complete_email_change_customer(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_email_change_customer(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.complete_email_change_customer(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_email_change_customer(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.complete_email_change_driver(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_email_change_driver(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.complete_email_change_driver(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_email_change_driver(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_customer_onboarding(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_customer_onboarding(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_customer_onboarding(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_customer_onboarding(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.sync_customer_phone_verification(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_customer_phone_verification(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.sync_customer_phone_verification(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sync_customer_phone_verification(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.sync_driver_phone_verification(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_driver_phone_verification(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.sync_driver_phone_verification(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sync_driver_phone_verification(uuid) TO service_role;

COMMIT;
