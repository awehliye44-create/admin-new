-- Rollback Phase A8B4. Restores the captured production ACL:
-- authenticated and service_role EXECUTE.
-- PUBLIC and anon stay denied.
-- Body and data are not changed. Function is not invoked.

BEGIN;

GRANT EXECUTE ON FUNCTION public.apply_customer_decline_grace(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_customer_decline_grace(uuid, text) TO service_role;

COMMIT;
