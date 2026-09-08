-- Rollback Phase A1. Restores the precise pre-change ACL:
-- authenticated and service_role EXECUTE on both signatures.
-- PUBLIC and anon were already denied and stay denied.
-- postgres owner access is not removed.

BEGIN;

GRANT EXECUTE ON FUNCTION public.reclaim_stale_onboarding_auth_user(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_stale_onboarding_auth_user(text) TO service_role;

GRANT EXECUTE ON FUNCTION public.repair_user_stale_auth_identities(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.repair_user_stale_auth_identities(uuid) TO service_role;

COMMIT;
