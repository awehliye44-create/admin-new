-- ============================================================
-- Phase A8B12: ACL-lock ten identity / permission-helper /
-- internal SECURITY DEFINER functions (edge + postgres-internal).
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function body, signature, return type, defaults,
-- owner, volatility, RLS, cron, trigger, or search_path change.
--
-- EDGE_SERVICE_ONLY (revoke PUBLIC/anon/authenticated; retain service_role):
--   check_email_available_for_change(text, uuid)
--     Edge emailChangePolicy / emailChangeSsot via service_role only
--   check_phone_available_for_change(uuid, text, text)
--     Edge phoneChangeSsot via service_role only
--   staff_has_action(uuid, text)
--     Edge demandZoneRecomputeAuth via service_role; nested from
--     admin_* staff mutators as postgres owner
--
-- POSTGRES_INTERNAL_ONLY (revoke PUBLIC/anon/authenticated/service_role):
--   phone_is_pending_reserved(text, uuid)
--   phone_is_verified_protected(text, uuid)
--     ← is_stale_unverified_phone_identity (already postgres-only)
--   haversine_meters(float8, float8, float8, float8)
--     ← dispatch / TD / presence / nearby SQL parents only
--   dispatch_max_driver_find_minutes(uuid)
--     ← finalize_negotiation_failure / get_dispatch_settings /
--       sweep_stale_searching_trips
--   log_driver_availability_event(...)
--     ← force_driver_offline / go_online/offline / availability triggers
--   assert_driver_presence_online_eligible(uuid)
--     ← upsert_driver_presence / expire_stale_drivers / go_online
--   recalculate_driver_documents_approved(uuid)
--     ← recalc document compliance SQL parents / cron helpers
--
-- Explicitly excluded / HARD_STOP this phase (audit only):
--   admin_* staff mutators + sync_staff_user_role (AUTHENTICATED_REQUIRED;
--     mounted /roles — body gates already present)
--   approve_corporate_request (already body-gated; keep authenticated)
--   AccountRequests reject path (direct table UPDATE — NEEDS_CALLER_CHANGE)
--   force_driver_offline (AUTHENTICATED_REQUIRED; weak profiles.admin path)
--   admin_get_user_email / admin_decide_customer_identity /
--     admin_unlock_customer_name_edit / admin_live_chat_driver_identity
--     (AUTHENTICATED_REQUIRED Admin JWT)
--   ride_offer_dispatch_push_delivery / ride_offer_enqueue_reminders
--     (A8B5B2 / SDN reserved — do not ACL here)
--   submit_driver_location_sample (excluded until ownership proven)
--   has_role / is_super_admin / is_owner / has_corporate_access /
--     can_write_corporate / admin_user_directory / suspend_corporate_request
--   financial payout/wallet RPCs and FM helpers
--   A8B1–A8B11 already-handled signatures
--   six RLS-no-policy INFO findings
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: 148 → 138 (−10)
--   anon remains 0; mutable search_path remains 0; categories remain 2
-- ============================================================

BEGIN;

-- Body hashes at draft time (md5(prosrc)):
--   check_email_available_for_change: 53c43680a0de136e06465cf57fcd44db
--   check_phone_available_for_change: c36618f4a0f388bf546a3caefe1bf298
--   staff_has_action: ce3e87aaa7dbef84988f4de3f381a719
--   phone_is_pending_reserved: ded86cd02509fb53bb93246974fd66de
--   phone_is_verified_protected: a47afb82d2678526ec24008e3b566fac
--   haversine_meters: f7d37be23bf08b93628d672f22663ad7
--   dispatch_max_driver_find_minutes: 80f4de26597e7d9b725d88068168fa7a
--   log_driver_availability_event: 11ab19134c3753e15355cbf52e6bbe96
--   assert_driver_presence_online_eligible: 04fa4657ebaabb08623679496ff0652c
--   recalculate_driver_documents_approved: 9a6135c95ac40ac3d8e56e7c6cf78667

-- EDGE_SERVICE_ONLY
REVOKE ALL ON FUNCTION public.check_email_available_for_change(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_email_available_for_change(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.check_email_available_for_change(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_email_available_for_change(text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.check_phone_available_for_change(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_phone_available_for_change(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.check_phone_available_for_change(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_phone_available_for_change(uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.staff_has_action(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_has_action(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.staff_has_action(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.staff_has_action(uuid, text) TO service_role;

-- POSTGRES_INTERNAL_ONLY
REVOKE ALL ON FUNCTION public.phone_is_pending_reserved(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.phone_is_pending_reserved(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.phone_is_pending_reserved(text, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.phone_is_pending_reserved(text, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.phone_is_verified_protected(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.phone_is_verified_protected(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.phone_is_verified_protected(text, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.phone_is_verified_protected(text, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.haversine_meters(double precision, double precision, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.haversine_meters(double precision, double precision, double precision, double precision) FROM anon;
REVOKE ALL ON FUNCTION public.haversine_meters(double precision, double precision, double precision, double precision) FROM authenticated;
REVOKE ALL ON FUNCTION public.haversine_meters(double precision, double precision, double precision, double precision) FROM service_role;

REVOKE ALL ON FUNCTION public.dispatch_max_driver_find_minutes(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_max_driver_find_minutes(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.dispatch_max_driver_find_minutes(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.dispatch_max_driver_find_minutes(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.log_driver_availability_event(uuid, text, text, boolean, boolean, boolean, boolean, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_driver_availability_event(uuid, text, text, boolean, boolean, boolean, boolean, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.log_driver_availability_event(uuid, text, text, boolean, boolean, boolean, boolean, jsonb, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.log_driver_availability_event(uuid, text, text, boolean, boolean, boolean, boolean, jsonb, text) FROM service_role;

REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.recalculate_driver_documents_approved(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_driver_documents_approved(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.recalculate_driver_documents_approved(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.recalculate_driver_documents_approved(uuid) FROM service_role;

COMMIT;
