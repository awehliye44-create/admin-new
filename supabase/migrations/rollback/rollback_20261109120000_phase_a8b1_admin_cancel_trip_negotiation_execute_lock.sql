-- Rollback Phase A8B1. Restores the captured production ACL:
-- authenticated and service_role EXECUTE.
-- PUBLIC and anon stay denied.
-- Body and data are not changed. Function is not invoked.

BEGIN;

GRANT EXECUTE ON FUNCTION public.admin_cancel_trip_negotiation(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cancel_trip_negotiation(uuid, text) TO service_role;

COMMIT;
