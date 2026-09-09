-- EMERGENCY ROLLBACK for 20261109180000_phase_a8b6_unauth_mutator_execute_lock.sql
-- Restores the precise pre-change ACL:
-- authenticated and service_role EXECUTE on all ten.
-- PUBLIC and anon were already denied and stay denied.
-- postgres owner access is not removed.
-- Does not alter bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.allocate_driver_reference(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_driver_reference(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.allocate_trip_reference(uuid, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_trip_reference(uuid, timestamp with time zone) TO service_role;

GRANT EXECUTE ON FUNCTION public.assign_trip_number(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_trip_number(uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.enrich_ride_offer_presets(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enrich_ride_offer_presets(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.ensure_trip_stops_for_assignment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_trip_stops_for_assignment(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb) TO service_role;

GRANT EXECUTE ON FUNCTION public.ops_retry_failed_dispatch(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_retry_failed_dispatch(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.recalculate_driver_display_rating(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_driver_display_rating(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.start_driver_commitment_session(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_driver_commitment_session(uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.upsert_driver_live_location(uuid, double precision, double precision, text, real, real) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_driver_live_location(uuid, double precision, double precision, text, real, real) TO service_role;

COMMIT;
