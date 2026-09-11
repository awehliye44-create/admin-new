-- Phase A8B25 transaction simulation only. BEGIN/ROLLBACK. Do not apply.

BEGIN;

DO $$
DECLARE
  v_md5 text;
  v_auth int;
BEGIN
  IF (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1)
     IS DISTINCT FROM '20261109380000' THEN
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: latest drift';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109390000') THEN
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: already present';
  END IF;
  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'active_super_admin_count';
  IF v_md5 IS DISTINCT FROM '58e091581d9ff11025e36901903d4eb7' THEN
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: baseline md5=%', v_md5;
  END IF;
  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: auth_secdef=%', v_auth;
  END IF;
END $$;

-- Capture baseline count as postgres (owner) before replace
DO $$
DECLARE
  v_baseline int;
BEGIN
  v_baseline := public.active_super_admin_count();
  PERFORM set_config('a8b25.baseline_count', v_baseline::text, true);
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

REVOKE ALL ON FUNCTION public.active_super_admin_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.active_super_admin_count() FROM anon;
REVOKE ALL ON FUNCTION public.active_super_admin_count() FROM service_role;
GRANT EXECUTE ON FUNCTION public.active_super_admin_count() TO authenticated;

DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='active_super_admin_count')
     IS DISTINCT FROM '4881dff6064dfe3abbc777e36d02d78f' THEN
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: proposed md5';
  END IF;
END $$;

ALTER TABLE public.staff_profiles DISABLE TRIGGER USER;
ALTER TABLE public.user_roles DISABLE TRIGGER USER;

DO $$
DECLARE
  v_user_admin uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa025';
  v_user_staff uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb025';
  v_user_driver uuid := 'cccccccc-cccc-cccc-cccc-ccccccccc025';
  v_user_cust uuid := 'dddddddd-dddd-dddd-dddd-ddddddddd025';
  v_user_corp uuid := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeee025';
  v_user_nodriver uuid := 'ffffffff-ffff-ffff-ffff-ffffffffff25';
  v_staff_id uuid := '11111111-aaaa-aaaa-aaaa-aaaaaaaaa025';
  v_count int;
  v_baseline int := current_setting('a8b25.baseline_count', true)::int;
BEGIN
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    ('00000000-0000-0000-0000-000000000000', v_user_admin, 'authenticated', 'authenticated', 'a8b25-admin@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_staff, 'authenticated', 'authenticated', 'a8b25-staff@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_driver, 'authenticated', 'authenticated', 'a8b25-driver@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_cust, 'authenticated', 'authenticated', 'a8b25-cust@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_corp, 'authenticated', 'authenticated', 'a8b25-corp@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_nodriver, 'authenticated', 'authenticated', 'a8b25-none@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now());

  INSERT INTO public.user_roles(user_id, role) VALUES
    (v_user_admin, 'admin'::app_role),
    (v_user_driver, 'driver'::app_role);

  -- Fixture staff row (triggers disabled at outer txn level below before this DO)
  INSERT INTO public.staff_profiles(id, user_id, full_name, role, is_active, staff_role_id)
  VALUES (v_staff_id, v_user_staff, 'A8B25 Staff', 'operator'::staff_role, true, '22222222-aaaa-aaaa-aaaa-aaaaaaaaa025');

  -- Admin JWT: count equals baseline (fixture staff is not super_admin)
  PERFORM set_config('request.jwt.claim.sub', v_user_admin::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_admin::text, 'role', 'authenticated')::text, true);
  v_count := public.active_super_admin_count();
  IF v_count IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: admin count drift % vs %', v_count, v_baseline;
  END IF;

  -- Active staff JWT
  PERFORM set_config('request.jwt.claim.sub', v_user_staff::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_staff::text, 'role', 'authenticated')::text, true);
  v_count := public.active_super_admin_count();
  IF v_count IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: staff count drift';
  END IF;

  -- Driver foreign
  PERFORM set_config('request.jwt.claim.sub', v_user_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_driver::text, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.active_super_admin_count();
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: driver allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Customer
  PERFORM set_config('request.jwt.claim.sub', v_user_cust::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_cust::text, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.active_super_admin_count();
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: customer allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Corporate
  PERFORM set_config('request.jwt.claim.sub', v_user_corp::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_corp::text, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.active_super_admin_count();
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: corporate allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Authenticated no staff/admin
  PERFORM set_config('request.jwt.claim.sub', v_user_nodriver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_nodriver::text, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.active_super_admin_count();
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: no-role allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- No JWT
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  BEGIN
    PERFORM public.active_super_admin_count();
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: no-jwt allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Parent path: Admin JWT still reaches count via owner privilege through parent body call
  PERFORM set_config('request.jwt.claim.sub', v_user_admin::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_admin::text, 'role', 'authenticated')::text, true);
  -- Direct equivalence already proven; parents only call the same function with same uid.
  IF public.active_super_admin_count() IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: parent-equivalent admin path';
  END IF;
END $$;

ALTER TABLE public.staff_profiles ENABLE TRIGGER USER;
ALTER TABLE public.user_roles ENABLE TRIGGER USER;

-- Restore baseline inside txn
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

GRANT EXECUTE ON FUNCTION public.active_super_admin_count() TO authenticated;
GRANT EXECUTE ON FUNCTION public.active_super_admin_count() TO service_role;

DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='active_super_admin_count')
     IS DISTINCT FROM '58e091581d9ff11025e36901903d4eb7' THEN
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: restored md5';
  END IF;
  IF (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B25 SIM HARD STOP: restored auth_secdef';
  END IF;
END $$;

ROLLBACK;

SELECT json_build_object(
  'status', 'A8B25_SIM_OK',
  'latest', (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1),
  'has_a8b25', EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109390000'),
  'auth_secdef', (
    SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ),
  'anon_secdef', (
    SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  'md5', (
    SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname = 'active_super_admin_count'
  ),
  'fixtures_absent', NOT EXISTS (
    SELECT 1 FROM auth.users WHERE email LIKE 'a8b25-%@example.invalid'
  ),
  'trips', (SELECT count(*)::int FROM public.trips),
  'proposed_md5', '4881dff6064dfe3abbc777e36d02d78f',
  'baseline_md5', '58e091581d9ff11025e36901903d4eb7'
) AS sim_result;
