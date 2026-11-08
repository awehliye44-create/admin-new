-- Verify 20261231152000 Roles RLS hotfix.
-- Read-only assertions: no is_owner() in live policies; A7B EXECUTE lock held;
-- Roles JWT helpers callable by authenticated; Owner delete policy present.

DO $assert$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policy pol
  JOIN pg_class rel ON rel.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = rel.relnamespace
  WHERE n.nspname = 'public'
    AND (
      coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ILIKE '%is_owner(%'
      OR coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ILIKE '%is_owner(%'
    );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'roles hotfix: % live policies still call is_owner()', v_bad;
  END IF;

  IF has_function_privilege('authenticated', 'public.is_owner(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.is_owner(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'public.is_owner(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'roles hotfix: is_owner EXECUTE must stay revoked for authenticated/anon/public';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.staff_is_active_owner()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.staff_can_manage_roles(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'roles hotfix: authenticated must EXECUTE staff_is_active_owner / staff_can_manage_roles';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class rel ON rel.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname = 'audit_logs'
      AND pol.polname = 'Roles audit visible to owner only'
      AND pg_get_expr(pol.polqual, pol.polrelid) ILIKE '%staff_is_active_owner()%'
      AND pg_get_expr(pol.polqual, pol.polrelid) NOT ILIKE '%is_owner(%'
  ) THEN
    RAISE EXCEPTION 'roles hotfix: Roles audit policy must use staff_is_active_owner()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class rel ON rel.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname = 'user_roles'
      AND pol.polname = 'Admins can insert non-admin roles; owner any'
      AND coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ILIKE '%staff_is_active_owner()%'
  ) THEN
    RAISE EXCEPTION 'roles hotfix: user_roles INSERT policy must use staff_is_active_owner()';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class rel ON rel.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname = 'user_roles'
      AND pol.polname = 'Admins can delete non-admin roles; owner any'
      AND pg_get_expr(pol.polqual, pol.polrelid) ILIKE '%staff_is_active_owner()%'
      AND pg_get_expr(pol.polqual, pol.polrelid) ILIKE '%staff_can_manage_roles(user_id)%'
  ) THEN
    RAISE EXCEPTION 'roles hotfix: user_roles DELETE policy must use staff_is_active_owner + staff_can_manage_roles';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class rel ON rel.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname = 'profiles'
      AND pol.polname = 'Owner can delete profiles for role management'
      AND pg_get_expr(pol.polqual, pol.polrelid) ILIKE '%staff_is_active_owner()%'
  ) THEN
    RAISE EXCEPTION 'roles hotfix: Owner profiles DELETE policy missing';
  END IF;

  RAISE NOTICE 'hotfix_roles_rls_staff_is_active_owner_verify: OK';
END;
$assert$;
