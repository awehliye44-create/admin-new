-- ============================================================
-- EMERGENCY ROLLBACK for 20261107150000_phase2c_anon_secdef_execute_revoke_lock.sql
--
-- Restores ACLs captured 2026-09-06 / Phase 2B residual baseline
-- on thazislrdkjpvvghtvzo for the two signup catalogue RPCs.
-- Reintroduces anon + authenticated EXECUTE — emergency only.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) TO service_role;

REVOKE ALL ON FUNCTION public.get_driver_signup_service_areas(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_service_areas(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_service_areas(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_service_areas(uuid) TO service_role;

COMMIT;
