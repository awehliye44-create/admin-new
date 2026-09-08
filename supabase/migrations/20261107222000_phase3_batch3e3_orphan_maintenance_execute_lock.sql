-- ============================================================
-- Phase 3 Batch 3E3: orphan / retired maintenance EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- No direct Edge, cron, trigger, or app caller.
-- sweep_stale_searching_trips() is the authenticated wrapper that
-- calls expire_trip_when_search_exhausted as postgres. Deny it.
-- service_role is not retained: no proven direct Edge caller.
-- postgres owner access is not removed. Bodies are not changed.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.expire_stale_negotiations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_negotiations() FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_negotiations() FROM authenticated;
REVOKE ALL ON FUNCTION public.expire_stale_negotiations() FROM service_role;

REVOKE ALL ON FUNCTION public.expire_stale_negotiations_guarded() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_negotiations_guarded() FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_negotiations_guarded() FROM authenticated;
REVOKE ALL ON FUNCTION public.expire_stale_negotiations_guarded() FROM service_role;

REVOKE ALL ON FUNCTION public.expire_stale_modification_requests() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_modification_requests() FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_modification_requests() FROM authenticated;
REVOKE ALL ON FUNCTION public.expire_stale_modification_requests() FROM service_role;

REVOKE ALL ON FUNCTION public.sweep_stale_searching_trips() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sweep_stale_searching_trips() FROM anon;
REVOKE ALL ON FUNCTION public.sweep_stale_searching_trips() FROM authenticated;
REVOKE ALL ON FUNCTION public.sweep_stale_searching_trips() FROM service_role;

REVOKE ALL ON FUNCTION public.expire_negotiation_offer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_negotiation_offer(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.expire_negotiation_offer(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.expire_negotiation_offer(uuid) FROM service_role;

COMMIT;
