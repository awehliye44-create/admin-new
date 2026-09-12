-- Restores grants observed 2026-09-12. Does not change function bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.resolve_negotiation_rebroadcast_fare(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_negotiation_rebroadcast_fare(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.ride_offer_dispatch_push_delivery(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ride_offer_dispatch_push_delivery(uuid, boolean) TO service_role;

GRANT EXECUTE ON FUNCTION public.ride_offer_enqueue_reminders(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ride_offer_enqueue_reminders(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.resolve_zone_surge(uuid, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_zone_surge(uuid, double precision, double precision) TO service_role;

COMMIT;
