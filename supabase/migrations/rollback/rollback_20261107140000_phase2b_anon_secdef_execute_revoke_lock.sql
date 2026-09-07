-- ============================================================
-- EMERGENCY ROLLBACK for 20261107140000_phase2b_anon_secdef_execute_revoke_lock.sql
--
-- Restores ACLs captured 2026-09-06 on thazislrdkjpvvghtvzo
-- (Phase 2B baseline). Reintroduces anon EXECUTE on these
-- SECURITY DEFINER functions — emergency use only.
--
-- Does NOT touch the two BLOCKER functions excluded from the
-- forward migration (location_options / service_areas).
-- Does NOT modify function bodies or trigger definitions.
-- ============================================================

BEGIN;

-- admin_decide_customer_identity: {postgres,anon,authenticated,service_role}
REVOKE ALL ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) TO service_role;

-- admin_unlock_customer_name_edit
REVOKE ALL ON FUNCTION public.admin_unlock_customer_name_edit(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_unlock_customer_name_edit(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_unlock_customer_name_edit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unlock_customer_name_edit(uuid) TO service_role;

-- finalize_driver_onboarding_registration
REVOKE ALL ON FUNCTION public.finalize_driver_onboarding_registration(text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_driver_onboarding_registration(text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text) TO anon;
GRANT EXECUTE ON FUNCTION public.finalize_driver_onboarding_registration(text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_driver_onboarding_registration(text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text) TO service_role;

-- get_customer_identity_verification_gate
REVOKE ALL ON FUNCTION public.get_customer_identity_verification_gate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_customer_identity_verification_gate(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_customer_identity_verification_gate(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_identity_verification_gate(uuid) TO service_role;

-- sync_current_driver_document_approval
REVOKE ALL ON FUNCTION public.sync_current_driver_document_approval() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_current_driver_document_approval() TO anon;
GRANT EXECUTE ON FUNCTION public.sync_current_driver_document_approval() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_current_driver_document_approval() TO service_role;

-- staff_has_company_funds_read_access
REVOKE ALL ON FUNCTION public.staff_has_company_funds_read_access(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_has_company_funds_read_access(text) TO anon;
GRANT EXECUTE ON FUNCTION public.staff_has_company_funds_read_access(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_has_company_funds_read_access(text) TO service_role;

-- triggers (+ PUBLIC)
GRANT EXECUTE ON FUNCTION public.drivers_on_auth_detach() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.drivers_on_auth_detach() TO anon;
GRANT EXECUTE ON FUNCTION public.drivers_on_auth_detach() TO authenticated;
GRANT EXECUTE ON FUNCTION public.drivers_on_auth_detach() TO service_role;

GRANT EXECUTE ON FUNCTION public.drivers_release_vehicles_on_soft_delete() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.drivers_release_vehicles_on_soft_delete() TO anon;
GRANT EXECUTE ON FUNCTION public.drivers_release_vehicles_on_soft_delete() TO authenticated;
GRANT EXECUTE ON FUNCTION public.drivers_release_vehicles_on_soft_delete() TO service_role;

GRANT EXECUTE ON FUNCTION public.enforce_driver_privileged_column_guard() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_driver_privileged_column_guard() TO anon;
GRANT EXECUTE ON FUNCTION public.enforce_driver_privileged_column_guard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_driver_privileged_column_guard() TO service_role;

-- unused catalogues
GRANT EXECUTE ON FUNCTION public.list_driver_signup_countries() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_driver_signup_countries() TO anon;
GRANT EXECUTE ON FUNCTION public.list_driver_signup_countries() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_driver_signup_countries() TO service_role;

REVOKE ALL ON FUNCTION public.list_enabled_otp_country_codes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_enabled_otp_country_codes() TO anon;
GRANT EXECUTE ON FUNCTION public.list_enabled_otp_country_codes() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_enabled_otp_country_codes() TO service_role;

-- validate
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) TO anon;
GRANT EXECUTE ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) TO service_role;

COMMIT;
