-- ============================================================
-- Rollback Phase A8B25
-- Restores exact baseline active_super_admin_count body + ACL
-- (authenticated + service_role + postgres). Never grants PUBLIC/anon.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.active_super_admin_count()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT count(*)::int FROM public.staff_profiles
  WHERE role = 'super_admin' AND is_active = true
$function$;

REVOKE ALL ON FUNCTION public.active_super_admin_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.active_super_admin_count() FROM anon;
GRANT EXECUTE ON FUNCTION public.active_super_admin_count() TO authenticated;
GRANT EXECUTE ON FUNCTION public.active_super_admin_count() TO service_role;

DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='active_super_admin_count')
     IS DISTINCT FROM '58e091581d9ff11025e36901903d4eb7' THEN
    RAISE EXCEPTION 'A8B25 rollback HARD STOP: baseline md5 not restored';
  END IF;
END $$;

COMMIT;
