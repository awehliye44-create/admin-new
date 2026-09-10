-- ============================================================
-- Phase A8B20: is_admin body authorization lock
-- NOT APPLIED until explicitly approved.
--
-- Target: public.is_admin()
-- Baseline body_md5:  31925d8b75f95e780ed00846e788c399
-- Proposed body_md5:  63fcc2103c85dd3aeb1796bee8d8720e
--
-- Vulnerability: body trusted auth.users.raw_user_meta_data->>'role'
--   = 'admin' (customer-editable user_metadata class). Untrusted until
--   proven otherwise. Live meta_admin count = 0; meta-only escalators = 0.
--
-- Proven callers:
--   SQL SECURITY DEFINER parent only:
--     public.admin_driver_wallet_eligibility_balances(uuid[])
--       Gate already ORs is_admin() OR has_role(uid,'admin') OR active
--       staff_profiles. Nested call runs as postgres owner — authenticated
--       EXECUTE on is_admin is not required for the parent.
--   Admin web wallet SSOT calls the finance parent, not is_admin directly.
--   Admin AuthProvider uses public.user_roles (not is_admin rpc).
--   No Driver / Customer / Corporate / Guest / Edge / RLS / view / cron /
--     trigger / direct .rpc('is_admin') runtime caller.
--
-- Remediation (NEEDS_BODY_AUTHORIZATION — decision B):
--   Replace body with authoritative has_role(auth.uid(), 'admin').
--   Preserve signature (no args), defaults (none), return boolean,
--   owner postgres, LANGUAGE sql, STABLE, SECURITY DEFINER,
--   search_path=public, and baseline ACL
--   {postgres,authenticated,service_role}=X.
--   Do NOT revoke authenticated EXECUTE in this phase.
--   Do NOT modify the finance parent text (mandatory finance exclusion).
--   No current_user='postgres' exception. No service-role arbitrary-user
--   exception (function is already self-bound via auth.uid()).
--
-- Expected Advisor change:
--   authenticated_security_definer_function_executable: unchanged 110
--   anon remains 0; mutable search_path remains 0
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.has_role(auth.uid(), 'admin'::public.app_role)
$function$;

-- Preserve baseline EXECUTE grants (CREATE OR REPLACE keeps ACL; restate
-- explicitly without PUBLIC/anon).
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO service_role;

COMMIT;
