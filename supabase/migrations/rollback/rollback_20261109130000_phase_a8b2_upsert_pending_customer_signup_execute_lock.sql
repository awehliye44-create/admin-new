-- Rollback Phase A8B2. Restores the captured production ACL:
-- authenticated and service_role EXECUTE.
-- PUBLIC and anon stay denied.
-- Body and data are not changed. Function is not invoked.

BEGIN;

GRANT EXECUTE ON FUNCTION public.upsert_pending_customer_signup(uuid, text, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_pending_customer_signup(uuid, text, text, text, text, text) TO service_role;

COMMIT;
