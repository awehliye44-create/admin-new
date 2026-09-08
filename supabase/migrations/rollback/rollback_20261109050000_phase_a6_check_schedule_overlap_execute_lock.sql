-- Rollback Phase A6. Restores the captured baseline ACL:
-- authenticated and service_role EXECUTE.
-- PUBLIC and anon stay denied.
-- Body and data are not changed.

BEGIN;

GRANT EXECUTE ON FUNCTION public.check_schedule_overlap(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_schedule_overlap(uuid, uuid) TO service_role;

COMMIT;
