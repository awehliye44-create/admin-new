-- ============================================================
-- Phase A8B7: orphan / postgres-internal / edge dispatch mutator EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function body, signature, return type, RLS, cron,
-- trigger, or search_path change.
--
-- Classifications:
--   ORPHANED (revoke PUBLIC/anon/authenticated/service_role; postgres retains):
--     lock_driver_vehicle
--     mark_driver_background_unavailable
--     merge_ride_offer_push_log
--     driver_cancel_negotiation
--   POSTGRES_INTERNAL_ONLY (same revoke set; SECDEF/trigger/cron parents):
--     release_trip_negotiation_lock          ← driver_cancel_negotiation
--     stop_driver_commitment_session         ← trg_stop_commitment_on_trip_change /
--                                               detect_driver_commitment_monitoring (cron)
--     record_driver_commitment_warning       ← detect_driver_commitment_monitoring
--     sync_document_primary_file_url         ← submit_driver_document (auth SECDEF parent)
--   EDGE_SERVICE_ONLY (revoke PUBLIC/anon/authenticated; retain service_role):
--     log_dispatch_event                     ← auto-dispatch (+ expire_stale_offers)
--     record_dispatch_wave_snapshot          ← Edge dispatch helpers + SQL triggers
--
-- Explicitly excluded:
--   submit_driver_location_sample (Driver authenticated; NEEDS_BODY_AUTHORIZATION)
--   ops_retry_failed_payout* / return_failed_payout_to_wallet (Admin authenticated .rpc)
--   ride_offer_dispatch_push_delivery (A8B5B2 notification path)
--   admin_user_directory (AUTHENTICATED_REQUIRED; separate anon-EXECUTE regression)
--   has_role / is_super_admin / is_owner / has_corporate_access / can_write_corporate
--
-- Expected Advisor item reduction:
--   authenticated_security_definer_function_executable: 187 → 177 (−10).
--   Security Advisor category count remains 2.
-- ============================================================

BEGIN;

-- Body hashes at draft time (md5(prosrc)):
--   lock_driver_vehicle: 9fb0e1ee12fe0e7f73f89c1a7182124c
--   mark_driver_background_unavailable: fc6fb5995c824987744f7ecb7453fe3e
--   merge_ride_offer_push_log: c9721691bc6479ebf3e4b77e317b15f6
--   driver_cancel_negotiation: 4e5f4993f4635b2f89edfdefbfca4b14
--   release_trip_negotiation_lock: 122cbf5ce8432379d1470f4569b74fd8
--   stop_driver_commitment_session: 45637ce329b5ab08275d9a877e915f59
--   record_driver_commitment_warning: 3d9a30faacb484021b089f5ad135b4a9
--   sync_document_primary_file_url: 6fa17caec7ee7c4066972c3d22503de1
--   log_dispatch_event: 2ac48f877949567711007bc662a4f170
--   record_dispatch_wave_snapshot: 66a27adeb0c5bc3be452eb36817e5a27

-- ORPHANED / POSTGRES_INTERNAL_ONLY
REVOKE ALL ON FUNCTION public.lock_driver_vehicle(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_driver_vehicle(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.lock_driver_vehicle(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.lock_driver_vehicle(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.mark_driver_background_unavailable(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_driver_background_unavailable(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.mark_driver_background_unavailable(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.mark_driver_background_unavailable(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.merge_ride_offer_push_log(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.merge_ride_offer_push_log(uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.merge_ride_offer_push_log(uuid, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.merge_ride_offer_push_log(uuid, jsonb) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_cancel_negotiation(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_cancel_negotiation(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_cancel_negotiation(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_cancel_negotiation(uuid, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.release_trip_negotiation_lock(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_trip_negotiation_lock(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.release_trip_negotiation_lock(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.release_trip_negotiation_lock(uuid, text) FROM service_role;

REVOKE ALL ON FUNCTION public.stop_driver_commitment_session(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stop_driver_commitment_session(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.stop_driver_commitment_session(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.stop_driver_commitment_session(uuid, text) FROM service_role;

REVOKE ALL ON FUNCTION public.record_driver_commitment_warning(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_driver_commitment_warning(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_driver_commitment_warning(uuid, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.record_driver_commitment_warning(uuid, text, text) FROM service_role;

REVOKE ALL ON FUNCTION public.sync_document_primary_file_url(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_document_primary_file_url(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.sync_document_primary_file_url(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.sync_document_primary_file_url(uuid) FROM service_role;

-- EDGE_SERVICE_ONLY
REVOKE ALL ON FUNCTION public.log_dispatch_event(uuid, text, integer, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_dispatch_event(uuid, text, integer, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.log_dispatch_event(uuid, text, integer, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.log_dispatch_event(uuid, text, integer, uuid, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb) TO service_role;

COMMIT;
