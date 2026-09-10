-- EMERGENCY ROLLBACK for 20261109190000_phase_a8b7_orphan_dispatch_mutator_execute_lock.sql
-- Restores the precise pre-change ACL on all ten:
-- authenticated + service_role EXECUTE.
-- PUBLIC and anon were already denied and stay denied.
-- postgres owner access is not removed.
-- Does not alter bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.lock_driver_vehicle(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lock_driver_vehicle(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.mark_driver_background_unavailable(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_driver_background_unavailable(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.merge_ride_offer_push_log(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.merge_ride_offer_push_log(uuid, jsonb) TO service_role;

GRANT EXECUTE ON FUNCTION public.driver_cancel_negotiation(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_cancel_negotiation(uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.release_trip_negotiation_lock(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_trip_negotiation_lock(uuid, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.stop_driver_commitment_session(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stop_driver_commitment_session(uuid, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.record_driver_commitment_warning(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_driver_commitment_warning(uuid, text, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.sync_document_primary_file_url(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_document_primary_file_url(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.log_dispatch_event(uuid, text, integer, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_dispatch_event(uuid, text, integer, uuid, jsonb) TO service_role;

GRANT EXECUTE ON FUNCTION public.record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb) TO service_role;

COMMIT;
