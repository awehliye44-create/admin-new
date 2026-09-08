-- Rollback 3E2. Restores the precise pre-change ACL:
-- authenticated and service_role EXECUTE on all eight.
-- PUBLIC and anon were already denied and stay denied.
-- postgres owner access is not removed.

BEGIN;

GRANT EXECUTE ON FUNCTION public.expire_stale_offers() TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_offers() TO service_role;

GRANT EXECUTE ON FUNCTION public.expire_trip_when_search_exhausted(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_trip_when_search_exhausted(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.process_ride_offer_ack_timeouts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_ride_offer_ack_timeouts() TO service_role;

GRANT EXECUTE ON FUNCTION public.lost_property_expire_chats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.lost_property_expire_chats() TO service_role;

GRANT EXECUTE ON FUNCTION public.lost_property_get_cases_for_photo_cleanup() TO authenticated;
GRANT EXECUTE ON FUNCTION public.lost_property_get_cases_for_photo_cleanup() TO service_role;

GRANT EXECUTE ON FUNCTION public.expire_due_call_masking_sessions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_due_call_masking_sessions() TO service_role;

GRANT EXECUTE ON FUNCTION public.ops_auto_resolve_stale_alerts(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_auto_resolve_stale_alerts(integer) TO service_role;

GRANT EXECUTE ON FUNCTION public.timeout_scheduled_offer(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.timeout_scheduled_offer(uuid, uuid) TO service_role;

COMMIT;
