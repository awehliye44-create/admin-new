-- ============================================================
-- Phase A8B2: upsert_pending_customer_signup EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- Proven caller: Edge create-onboarding-auth-user only
-- (service-role client; p_user_id from auth.admin.createUser).
-- No Admin/Customer/Driver/Corporate/SQL/trigger/cron mount.
-- ACL only. Body, signature, and data unchanged.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.upsert_pending_customer_signup(uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_pending_customer_signup(uuid, text, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_pending_customer_signup(uuid, text, text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_pending_customer_signup(uuid, text, text, text, text, text) TO service_role;

COMMIT;
