-- ============================================================
-- Phase 3 Batch 3E1: cron sweep EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- postgres remains the cron credential for all five.
-- service_role is preserved only on expire_stale_drivers(integer),
-- the exact child called by Edge expire-stale-drivers.
-- Cron-only functions lose service_role. Nested SECDEF calls run
-- as the postgres owner and do not need a service_role grant.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.expire_stale_drivers(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_drivers(integer) FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_drivers(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_drivers(integer) TO service_role;

REVOKE ALL ON FUNCTION public.expire_stale_drivers_guarded(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_drivers_guarded(integer) FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_drivers_guarded(integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.expire_stale_drivers_guarded(integer) FROM service_role;

REVOKE ALL ON FUNCTION public.ops_cleanup_old_data() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_cleanup_old_data() FROM anon;
REVOKE ALL ON FUNCTION public.ops_cleanup_old_data() FROM authenticated;
REVOKE ALL ON FUNCTION public.ops_cleanup_old_data() FROM service_role;

REVOKE ALL ON FUNCTION public.ride_offer_retry_unacked_push_deliveries() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ride_offer_retry_unacked_push_deliveries() FROM anon;
REVOKE ALL ON FUNCTION public.ride_offer_retry_unacked_push_deliveries() FROM authenticated;
REVOKE ALL ON FUNCTION public.ride_offer_retry_unacked_push_deliveries() FROM service_role;

REVOKE ALL ON FUNCTION public.recalculate_drivers_compliance_london_daily() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_drivers_compliance_london_daily() FROM anon;
REVOKE ALL ON FUNCTION public.recalculate_drivers_compliance_london_daily() FROM authenticated;
REVOKE ALL ON FUNCTION public.recalculate_drivers_compliance_london_daily() FROM service_role;

COMMIT;
