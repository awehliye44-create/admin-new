-- ============================================================
-- Phase A8B18: ACL-lock five authenticated SECURITY DEFINER
-- helpers with no live runtime callers (ORPHANED).
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function body, signature, return type, defaults,
-- owner, volatility, RLS, cron, trigger, or search_path change.
--
-- ORPHANED (revoke PUBLIC/anon/authenticated/service_role; postgres retains):
--   list_driver_trip_history(integer)
--     Superseded by list_driver_own_trip_history; Driver app uses own_* only
--   create_driver_vehicle(uuid, text, text, integer, text, text)
--     Driver contract verified:false; Create Account uses
--     finalize_driver_onboarding_registration only
--   get_driver_feedback_analytics(uuid)
--     Driver Standards SSOT is get_driver_standards; no live .rpc caller
--   set_corporate_account_service_area(uuid, uuid)
--     Hub uses Edge set-corporate-service-area (service table update);
--     RPC has no Admin/Customer/Driver/Corporate/Guest/Edge .rpc caller
--   get_booking_quote_inputs(double precision, double precision)
--     No Admin/Customer/Driver/Corporate/Guest/Edge .rpc caller;
--     no SQL parent / trigger / RLS / view / cron
--
-- Explicitly excluded / HARD_STOP this phase:
--   Mounted JWT admin_*/driver_*/customer_*/corporate_* RPCs
--   RLS helpers (has_role, can_passenger_*, current_driver_profile_id, …)
--   Finance / wallet / CW / payout / Revolut / commission helpers
--   Notification / Vault / record_booking_delivery / ride_offer_* push
--   submit_driver_location_sample / force_driver_offline / A8B13D
--   is_driver / get_trip_passenger_details / can_corporate_user_view_driver
--   driver_can_view_trip_via_offer / resolve_zone_surge /
--     search_onecab_location_landmarks / is_location_search_ssot_enabled
--   is_admin (POSTGRES_INTERNAL under finance parent; user_metadata body)
--   get_driver_resume_delta (no callers, but trip/offer lifecycle-shaped)
--   Active trip/offer/scheduled/waiting/rematch without complete proof
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: 116 → 111 (−5)
--   anon remains 0; mutable search_path remains 0
-- ============================================================

BEGIN;

-- Body hashes at draft time (md5(prosrc)):
--   list_driver_trip_history: f6d68a4b21c4debde3352290922f6045
--   create_driver_vehicle: 975936ecd766413f6e582f1b4165843c
--   get_driver_feedback_analytics: eddd9e01ad2db3b2569b23756451daa8
--   set_corporate_account_service_area: 6a046e1bb27c573a6cc18f7e5b395dc9
--   get_booking_quote_inputs: a83d567af63ee8b22fc49dc0763365e3

REVOKE ALL ON FUNCTION public.list_driver_trip_history(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_driver_trip_history(integer) FROM anon;
REVOKE ALL ON FUNCTION public.list_driver_trip_history(integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.list_driver_trip_history(integer) FROM service_role;

REVOKE ALL ON FUNCTION public.create_driver_vehicle(uuid, text, text, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_driver_vehicle(uuid, text, text, integer, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.create_driver_vehicle(uuid, text, text, integer, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.create_driver_vehicle(uuid, text, text, integer, text, text) FROM service_role;

REVOKE ALL ON FUNCTION public.get_driver_feedback_analytics(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_feedback_analytics(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_feedback_analytics(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_driver_feedback_analytics(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.get_booking_quote_inputs(double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_booking_quote_inputs(double precision, double precision) FROM anon;
REVOKE ALL ON FUNCTION public.get_booking_quote_inputs(double precision, double precision) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_booking_quote_inputs(double precision, double precision) FROM service_role;

-- Retain postgres owner EXECUTE (implicit via ownership).

COMMIT;
