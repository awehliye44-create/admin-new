-- Rollback 3E1. Restores the precise pre-change ACL:
-- authenticated and service_role EXECUTE on all five.
-- PUBLIC and anon were already denied and stay denied.
-- postgres owner access is not removed.

BEGIN;

GRANT EXECUTE ON FUNCTION public.expire_stale_drivers(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_drivers(integer) TO service_role;

GRANT EXECUTE ON FUNCTION public.expire_stale_drivers_guarded(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_drivers_guarded(integer) TO service_role;

GRANT EXECUTE ON FUNCTION public.ops_cleanup_old_data() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_cleanup_old_data() TO service_role;

GRANT EXECUTE ON FUNCTION public.ride_offer_retry_unacked_push_deliveries() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ride_offer_retry_unacked_push_deliveries() TO service_role;

GRANT EXECUTE ON FUNCTION public.recalculate_drivers_compliance_london_daily() TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_drivers_compliance_london_daily() TO service_role;

COMMIT;
