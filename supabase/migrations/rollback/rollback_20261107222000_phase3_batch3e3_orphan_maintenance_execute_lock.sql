-- Rollback 3E3. Restores the precise pre-change ACL:
-- authenticated and service_role EXECUTE on all five.
-- PUBLIC and anon were already denied and stay denied.
-- postgres owner access is not removed.

BEGIN;

GRANT EXECUTE ON FUNCTION public.expire_stale_negotiations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_negotiations() TO service_role;

GRANT EXECUTE ON FUNCTION public.expire_stale_negotiations_guarded() TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_negotiations_guarded() TO service_role;

GRANT EXECUTE ON FUNCTION public.expire_stale_modification_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_modification_requests() TO service_role;

GRANT EXECUTE ON FUNCTION public.sweep_stale_searching_trips() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_stale_searching_trips() TO service_role;

GRANT EXECUTE ON FUNCTION public.expire_negotiation_offer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_negotiation_offer(uuid) TO service_role;

COMMIT;
