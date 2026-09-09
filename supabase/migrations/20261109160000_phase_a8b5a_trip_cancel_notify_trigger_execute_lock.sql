-- ============================================================
-- Phase A8B5A: trip-cancel notify trigger-chain EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- Runtime caller (only):
--   TRIGGER tr_trips_notify_cancel AFTER UPDATE OF status ON public.trips
--   → public.tr_trips_notify_cancel()  [postgres SECURITY DEFINER]
--   → public.notify_drivers_trip_cancelled(NEW.id, v_reason)
--
-- Local scratch proof: client UPDATE fires the chain after REVOKE of
-- authenticated/service_role EXECUTE on both functions (owner SECDEF path).
-- No direct app/Edge RPC mounts. Generated types only for notify child.
--
-- ACL only. Bodies, trigger definition, and credential unchanged.
-- Expected Advisor: authenticated SECURITY DEFINER 198 → 197
--   (notify child currently grants authenticated; trigger fn does not).
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) FROM service_role;

REVOKE ALL ON FUNCTION public.tr_trips_notify_cancel() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_trips_notify_cancel() FROM anon;
REVOKE ALL ON FUNCTION public.tr_trips_notify_cancel() FROM authenticated;
REVOKE ALL ON FUNCTION public.tr_trips_notify_cancel() FROM service_role;

COMMIT;
