-- ============================================================
-- Authenticated SECURITY DEFINER ACL lock for four dispatch/fare
-- helpers. Grants/revokes only. Does not change bodies, owners,
-- SECURITY DEFINER, volatility, or search_path. Does not invoke
-- any function.
--
-- POSTGRES_INTERNAL (revoke PUBLIC/anon/authenticated/service_role;
-- postgres owner retains EXECUTE; parents are SECURITY DEFINER):
--   resolve_negotiation_rebroadcast_fare(uuid)
--     ← finalize_negotiation_failure
--   ride_offer_dispatch_push_delivery(uuid, boolean)
--     ← tr_send_push_on_ride_offer_insert
--     ← ride_offer_retry_unacked_push_deliveries
--
-- ORPHAN (same revoke; no SQL, cron, trigger, policy, app, or Edge caller):
--   ride_offer_enqueue_reminders(uuid)
--
-- EDGE_SERVICE_ONLY (revoke PUBLIC/anon/authenticated; keep service_role):
--   resolve_zone_surge(uuid, double precision, double precision)
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.resolve_negotiation_rebroadcast_fare(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_negotiation_rebroadcast_fare(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_negotiation_rebroadcast_fare(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_negotiation_rebroadcast_fare(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.ride_offer_dispatch_push_delivery(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ride_offer_dispatch_push_delivery(uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.ride_offer_dispatch_push_delivery(uuid, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public.ride_offer_dispatch_push_delivery(uuid, boolean) FROM service_role;

REVOKE ALL ON FUNCTION public.ride_offer_enqueue_reminders(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ride_offer_enqueue_reminders(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ride_offer_enqueue_reminders(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.ride_offer_enqueue_reminders(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.resolve_zone_surge(uuid, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_zone_surge(uuid, double precision, double precision) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_zone_surge(uuid, double precision, double precision) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_zone_surge(uuid, double precision, double precision) TO service_role;

COMMIT;
