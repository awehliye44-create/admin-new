-- ============================================================
-- Phase A8B25: active_super_admin_count body authorization lock
-- Applied to ACTIVE_HEALTHY as 20261109390000.
--
-- Target: public.active_super_admin_count()
-- Baseline body_md5:  58e091581d9ff11025e36901903d4eb7
-- Applied body_md5:   4881dff6064dfe3abbc777e36d02d78f
--
-- Vulnerability: SECURITY DEFINER integer count of active
--   super_admin staff_profiles with no auth.uid() gate.
--   Any authenticated client can enumerate active Super Admin headcount.
--
-- Proven callers:
--   Admin web useRoleCapabilities → supabase.rpc('active_super_admin_count')
--   SQL parents (Admin JWT, SECURITY DEFINER; auth.uid() remains staff):
--     admin_assign_staff_role / admin_remove_staff_member / admin_set_staff_active
--     (RolesPermissions.tsx)
--   No Edge / RLS / trigger / cron / Driver / Customer / Corporate caller.
--
-- Remediation (NEEDS_BODY_AUTHORIZATION):
--   Require auth.uid() + (has_role admin | is_super_admin(uid) |
--   active staff_profiles row). Preserve count semantics.
--   Revoke unused service_role EXECUTE (no proven service caller).
--
-- Expected authenticated SECDEF count: unchanged 110
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_md5 text;
  v_auth int;
BEGIN
  IF (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1)
     IS DISTINCT FROM '20261109380000' THEN
    RAISE EXCEPTION 'A8B25 HARD STOP: unexpected latest migration';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109390000') THEN
    RAISE EXCEPTION 'A8B25 HARD STOP: migration already recorded';
  END IF;

  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'active_super_admin_count'
    AND pg_get_function_identity_arguments(p.oid) = '';
  IF v_md5 IS DISTINCT FROM '58e091581d9ff11025e36901903d4eb7' THEN
    RAISE EXCEPTION 'A8B25 HARD STOP: baseline md5=%', v_md5;
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B25 HARD STOP: auth_secdef=%', v_auth;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.active_super_admin_count()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Staff/admin-only inventory count. Trusted Admin JWT parents
  -- (admin_assign_staff_role / admin_remove_staff_member / admin_set_staff_active)
  -- keep auth.uid() of the initiating staff JWT under SECURITY DEFINER.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.is_super_admin(auth.uid())
    OR EXISTS (
      SELECT 1
      FROM public.staff_profiles sp
      WHERE sp.user_id = auth.uid()
        AND sp.is_active = true
    )
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT count(*)::int
    FROM public.staff_profiles
    WHERE role = 'super_admin'
      AND is_active = true
  );
END;
$function$;

COMMENT ON FUNCTION public.active_super_admin_count() IS
  'Returns the count of active Super Admin staff profiles. Restricted to authenticated admin/staff actors (has_role admin, is_super_admin, or active staff_profiles).';

REVOKE ALL ON FUNCTION public.active_super_admin_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.active_super_admin_count() FROM anon;
REVOKE ALL ON FUNCTION public.active_super_admin_count() FROM service_role;
GRANT EXECUTE ON FUNCTION public.active_super_admin_count() TO authenticated;

DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='active_super_admin_count')
     IS DISTINCT FROM '4881dff6064dfe3abbc777e36d02d78f' THEN
    RAISE EXCEPTION 'A8B25 HARD STOP: proposed md5 mismatch';
  END IF;
  IF (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B25 HARD STOP: auth_secdef changed';
  END IF;
  IF has_function_privilege('service_role', 'public.active_super_admin_count()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B25 HARD STOP: service_role still executable';
  END IF;
END $$;

COMMIT;
