-- ============================================================
-- Phase A1: identity reclaim RPC EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- reclaim_stale_onboarding_auth_user(text) can delete an unverified
-- auth.users row selected by caller-supplied email. It calls
-- repair_user_stale_auth_identities(uuid) as postgres, so both lose
-- authenticated EXECUTE together.
-- Direct callers are Edge functions on SUPABASE_SERVICE_ROLE_KEY.
-- PUBLIC, anon and authenticated lose EXECUTE. service_role stays.
-- Do not change bodies, search_path, RLS, or helpers.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.reclaim_stale_onboarding_auth_user(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reclaim_stale_onboarding_auth_user(text) FROM anon;
REVOKE ALL ON FUNCTION public.reclaim_stale_onboarding_auth_user(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_stale_onboarding_auth_user(text) TO service_role;

REVOKE ALL ON FUNCTION public.repair_user_stale_auth_identities(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repair_user_stale_auth_identities(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.repair_user_stale_auth_identities(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.repair_user_stale_auth_identities(uuid) TO service_role;

COMMIT;
