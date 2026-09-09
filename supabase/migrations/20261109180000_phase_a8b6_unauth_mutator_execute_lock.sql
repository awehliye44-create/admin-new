-- ============================================================
-- Phase A8B6: unauthenticated high-impact mutator EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function body, signature, return type, RLS, cron,
-- trigger, or search_path change.
--
-- Proven callers (no Admin/Customer/Driver/Corporate/Guest .rpc):
--   EDGE_SERVICE_ONLY (SUPABASE_SERVICE_ROLE_KEY):
--     ops_retry_failed_dispatch          → ops-ai-fix
--     upsert_driver_live_location        → upsert-driver-location
--     ensure_trip_stops_for_assignment   → rideAssignmentFinalize (+ accept_ride_offer SQL)
--     log_dispatch_eligibility           → auto-dispatch (+ dispatch_trip_offers SQL)
--     enrich_ride_offer_presets          → auto-dispatch / get-driver-offer-snapshot /
--                                          driver-fare-offer (+ dispatch_trip_offers SQL)
--     assign_trip_number                 → create-trip / create-trip-after-payment
--                                          bookingPostCommit
--   POSTGRES_INTERNAL_ONLY (trigger / SECDEF parent; auth_exec already false on parents):
--     allocate_driver_reference          → generate_driver_code
--     allocate_trip_reference            → generate_trip_code
--     recalculate_driver_display_rating  → trigger_recalculate_driver_rating
--     start_driver_commitment_session    → trg_start_commitment_on_offer_accept
--
-- PUBLIC / anon / authenticated lose EXECUTE. service_role retained.
-- postgres owner access is not revoked.
--
-- Expected Advisor item reduction for
-- authenticated_security_definer_function_executable: 197 → 187 (−10).
-- Security Advisor category count remains 2.
-- ============================================================

BEGIN;

-- Body hashes at draft time (md5(prosrc)); simulation must reconfirm unchanged:
--   allocate_driver_reference: 4657ceb6492a858defc384a767a1852d
--   allocate_trip_reference: 4fc954d0dcdc6fcf816d050687e54c9a
--   assign_trip_number: 54f05e1793faf723a690d88e3b643e32
--   enrich_ride_offer_presets: 146ee27fc94d0f42a5b7e7206a20901a
--   ensure_trip_stops_for_assignment: 504e6ecf61d239155df07c81aac43737
--   log_dispatch_eligibility: b6e1b8d56bc7b851db05392bc0576b1b
--   ops_retry_failed_dispatch: dd96c125966be010383945dcd050fa32
--   recalculate_driver_display_rating: 2ca3a9045fd667801b2215d403f1eaae
--   start_driver_commitment_session: 0858396c49b98875d5d712c1c52d65e1
--   upsert_driver_live_location: 6320cc6f61cade85abc45bc1f9412d3b

REVOKE ALL ON FUNCTION public.allocate_driver_reference(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.allocate_driver_reference(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.allocate_driver_reference(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_driver_reference(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.allocate_trip_reference(uuid, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.allocate_trip_reference(uuid, timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.allocate_trip_reference(uuid, timestamp with time zone) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_trip_reference(uuid, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.assign_trip_number(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_trip_number(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assign_trip_number(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assign_trip_number(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.enrich_ride_offer_presets(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enrich_ride_offer_presets(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.enrich_ride_offer_presets(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.enrich_ride_offer_presets(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.ensure_trip_stops_for_assignment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_trip_stops_for_assignment(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_trip_stops_for_assignment(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_trip_stops_for_assignment(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.ops_retry_failed_dispatch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_retry_failed_dispatch(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ops_retry_failed_dispatch(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ops_retry_failed_dispatch(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.recalculate_driver_display_rating(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_driver_display_rating(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.recalculate_driver_display_rating(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_driver_display_rating(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.start_driver_commitment_session(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_driver_commitment_session(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.start_driver_commitment_session(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_driver_commitment_session(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.upsert_driver_live_location(uuid, double precision, double precision, text, real, real) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_driver_live_location(uuid, double precision, double precision, text, real, real) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_driver_live_location(uuid, double precision, double precision, text, real, real) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_driver_live_location(uuid, double precision, double precision, text, real, real) TO service_role;

COMMIT;
