-- Rollback Phase A7A. Restores the captured baseline ACL:
-- authenticated and service_role EXECUTE.
-- PUBLIC and anon stay denied.
-- Body and data are not changed.

BEGIN;

GRANT EXECUTE ON FUNCTION public.get_user_corporate_accounts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_corporate_accounts(uuid) TO service_role;

COMMIT;
