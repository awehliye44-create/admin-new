-- Rollback Phase A8B3. Restores the captured production ACL:
-- authenticated and service_role EXECUTE.
-- PUBLIC and anon stay denied.
-- Body and data are not changed. Function is not invoked.

BEGIN;

GRANT EXECUTE ON FUNCTION public.promote_stacked_trip(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.promote_stacked_trip(uuid, uuid) TO service_role;

COMMIT;
