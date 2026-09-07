-- ============================================================
-- Phase 2C: revoke client EXECUTE on the final two anonymous
-- SECURITY DEFINER signup catalogue RPCs.
--
-- Prerequisite: Driver Create Account loads catalogue via Edge
-- `driver-signup-location-options` (service_role server-side).
--
-- DO NOT APPLY until Driver Metro/device path is verified.
-- Grants/revokes only — no function body changes.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) TO service_role;

REVOKE ALL ON FUNCTION public.get_driver_signup_service_areas(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_signup_service_areas(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_signup_service_areas(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_service_areas(uuid) TO service_role;

COMMIT;
