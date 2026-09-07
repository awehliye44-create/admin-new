-- ============================================================
-- Phase 2B: revoke client EXECUTE on remaining anon-executable
-- SECURITY DEFINER functions (12 of 14).
--
-- EXCLUDED (BLOCKER — Driver Create Account calls these via the
-- anon-key Supabase client before Auth session exists):
--   public.get_driver_signup_location_options(double precision, double precision, text)
--   public.get_driver_signup_service_areas(uuid)
-- Do not revoke anon on those until the native app uses the
-- service_role Edge wrapper (driver-signup-location-options) or
-- an authenticated session for catalogue loads.
--
-- Does NOT modify function bodies, triggers, cron, Edge, RLS,
-- or Auth. Grants/revokes only.
-- ============================================================

BEGIN;

-- ---- Admin (fail-closed has_role admin; Admin UI = authenticated) ----
REVOKE ALL ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_unlock_customer_name_edit(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unlock_customer_name_edit(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.admin_unlock_customer_name_edit(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.admin_unlock_customer_name_edit(uuid) TO authenticated;

-- ---- Driver/customer post-auth (fail-closed auth.uid / current_driver_id) ----
REVOKE ALL ON FUNCTION public.finalize_driver_onboarding_registration(text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_driver_onboarding_registration(text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_driver_onboarding_registration(text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.finalize_driver_onboarding_registration(text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.get_customer_identity_verification_gate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_identity_verification_gate(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_customer_identity_verification_gate(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.get_customer_identity_verification_gate(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.sync_current_driver_document_approval() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_current_driver_document_approval() FROM anon;
REVOKE ALL ON FUNCTION public.sync_current_driver_document_approval() FROM service_role;
GRANT EXECUTE ON FUNCTION public.sync_current_driver_document_approval() TO authenticated;

-- ---- RLS helper (policies evaluate as authenticated staff) ----
REVOKE ALL ON FUNCTION public.staff_has_company_funds_read_access(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_has_company_funds_read_access(text) FROM anon;
REVOKE ALL ON FUNCTION public.staff_has_company_funds_read_access(text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.staff_has_company_funds_read_access(text) TO authenticated;

-- ---- Trigger-only (no client EXECUTE; triggers fire as table owner path) ----
REVOKE ALL ON FUNCTION public.drivers_on_auth_detach() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drivers_on_auth_detach() FROM anon;
REVOKE ALL ON FUNCTION public.drivers_on_auth_detach() FROM authenticated;
REVOKE ALL ON FUNCTION public.drivers_on_auth_detach() FROM service_role;

REVOKE ALL ON FUNCTION public.drivers_release_vehicles_on_soft_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drivers_release_vehicles_on_soft_delete() FROM anon;
REVOKE ALL ON FUNCTION public.drivers_release_vehicles_on_soft_delete() FROM authenticated;
REVOKE ALL ON FUNCTION public.drivers_release_vehicles_on_soft_delete() FROM service_role;

REVOKE ALL ON FUNCTION public.enforce_driver_privileged_column_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_driver_privileged_column_guard() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_driver_privileged_column_guard() FROM authenticated;
REVOKE ALL ON FUNCTION public.enforce_driver_privileged_column_guard() FROM service_role;

-- ---- Unused / internal catalogue helpers ----
REVOKE ALL ON FUNCTION public.list_driver_signup_countries() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_driver_signup_countries() FROM anon;
REVOKE ALL ON FUNCTION public.list_driver_signup_countries() FROM authenticated;
REVOKE ALL ON FUNCTION public.list_driver_signup_countries() FROM service_role;

REVOKE ALL ON FUNCTION public.list_enabled_otp_country_codes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_enabled_otp_country_codes() FROM anon;
REVOKE ALL ON FUNCTION public.list_enabled_otp_country_codes() FROM authenticated;
REVOKE ALL ON FUNCTION public.list_enabled_otp_country_codes() FROM service_role;

-- validate is invoked inside finalize (SECURITY DEFINER owner) and has no
-- live pre-auth client caller; keep authenticated for optional post-auth use.
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) TO authenticated;

COMMIT;
