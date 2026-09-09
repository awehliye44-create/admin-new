-- Rollback Phase A8B5A. Restores the captured production ACLs:
-- notify_drivers_trip_cancelled: authenticated + service_role EXECUTE
-- tr_trips_notify_cancel: service_role EXECUTE only
-- PUBLIC and anon stay denied.
-- Bodies, trigger, and data are not changed. Functions are not invoked.

BEGIN;

GRANT EXECUTE ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.tr_trips_notify_cancel() TO service_role;

COMMIT;
