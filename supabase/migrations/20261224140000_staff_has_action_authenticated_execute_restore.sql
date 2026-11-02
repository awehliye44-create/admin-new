-- Restore authenticated EXECUTE on public.staff_has_action(uuid, text).
--
-- Cause: 20261109240000_phase_a8b12_identity_helper_execute_lock.sql classified
-- staff_has_action as EDGE_SERVICE_ONLY and revoked authenticated EXECUTE.
-- Admin RLS policies still invoke it as the table invoker, e.g.
-- service_area_demand_zone_settings "Staff read demand zone settings":
--   is_super_admin OR has_role(admin) OR staff_has_action(...demand_zones.*)
-- That yields: permission denied for function staff_has_action (42501).
--
-- Nested SECURITY DEFINER admin_* RPCs keep working as the function owner;
-- RLS evaluation does not — authenticated must be able to EXECUTE the helper.
-- Keep PUBLIC/anon revoked. Retain service_role EXECUTE for Edge callers.

BEGIN;

REVOKE ALL ON FUNCTION public.staff_has_action(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_has_action(uuid, text) FROM anon;

GRANT EXECUTE ON FUNCTION public.staff_has_action(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_has_action(uuid, text) TO service_role;

COMMIT;
