-- Rollback Phase A7B. Restores the captured baseline ACL:
-- authenticated and service_role EXECUTE.
-- PUBLIC and anon stay denied.
-- Body and data are not changed.

BEGIN;

GRANT EXECUTE ON FUNCTION public.is_owner(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_owner(uuid) TO service_role;

COMMIT;
