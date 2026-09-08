-- ============================================================
-- Phase 3 Batch 3E2: Edge maintenance EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- All eight have a direct Edge rpc on a SUPABASE_SERVICE_ROLE_KEY client.
-- Nested SQL callers of expire_trip_when_search_exhausted run as postgres
-- and do not replace that Edge requirement.
-- PUBLIC, anon and authenticated lose EXECUTE. service_role stays.
-- Do not change bodies, cron, or search_path.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.expire_stale_offers() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_offers() FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_offers() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_offers() TO service_role;

REVOKE ALL ON FUNCTION public.expire_trip_when_search_exhausted(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_trip_when_search_exhausted(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.expire_trip_when_search_exhausted(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_trip_when_search_exhausted(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.process_ride_offer_ack_timeouts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_ride_offer_ack_timeouts() FROM anon;
REVOKE ALL ON FUNCTION public.process_ride_offer_ack_timeouts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_ride_offer_ack_timeouts() TO service_role;

REVOKE ALL ON FUNCTION public.lost_property_expire_chats() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lost_property_expire_chats() FROM anon;
REVOKE ALL ON FUNCTION public.lost_property_expire_chats() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.lost_property_expire_chats() TO service_role;

REVOKE ALL ON FUNCTION public.lost_property_get_cases_for_photo_cleanup() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lost_property_get_cases_for_photo_cleanup() FROM anon;
REVOKE ALL ON FUNCTION public.lost_property_get_cases_for_photo_cleanup() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.lost_property_get_cases_for_photo_cleanup() TO service_role;

REVOKE ALL ON FUNCTION public.expire_due_call_masking_sessions() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_due_call_masking_sessions() FROM anon;
REVOKE ALL ON FUNCTION public.expire_due_call_masking_sessions() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_due_call_masking_sessions() TO service_role;

REVOKE ALL ON FUNCTION public.ops_auto_resolve_stale_alerts(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_auto_resolve_stale_alerts(integer) FROM anon;
REVOKE ALL ON FUNCTION public.ops_auto_resolve_stale_alerts(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ops_auto_resolve_stale_alerts(integer) TO service_role;

REVOKE ALL ON FUNCTION public.timeout_scheduled_offer(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.timeout_scheduled_offer(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.timeout_scheduled_offer(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.timeout_scheduled_offer(uuid, uuid) TO service_role;

COMMIT;
