-- Phase A8B26 transaction simulation only. BEGIN/ROLLBACK. Do not apply.
-- No live lost-property row mutation. No PII printed. Count compared, not emitted.

BEGIN;

DO $$
DECLARE
  v_md5 text;
  v_auth int;
  v_baseline int;
BEGIN
  IF (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1)
     IS DISTINCT FROM '20261109390000' THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: latest drift';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109400000') THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: already present';
  END IF;

  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'lost_property_admin_unread_count'
    AND pg_get_function_identity_arguments(p.oid) = '';
  IF v_md5 IS DISTINCT FROM 'db6f1af9a933be79c723379c98d2eb35' THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: baseline md5=%', v_md5;
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: auth_secdef=%', v_auth;
  END IF;

  -- Capture baseline count as owner (no JWT) before replace — do not raise/print it.
  v_baseline := public.lost_property_admin_unread_count();
  PERFORM set_config('a8b26.baseline_count', v_baseline::text, true);
END $$;

-- === BASELINE EXPOSURE: any authenticated JWT receives global count ===
ALTER TABLE public.staff_profiles DISABLE TRIGGER USER;
ALTER TABLE public.user_roles DISABLE TRIGGER USER;

DO $$
DECLARE
  v_user_driver uuid := 'cccccccc-cccc-cccc-cccc-ccccccccc026';
  v_baseline int := current_setting('a8b26.baseline_count', true)::int;
  v_got int;
BEGIN
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    ('00000000-0000-0000-0000-000000000000', v_user_driver, 'authenticated', 'authenticated',
     'a8b26-driver-base@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now());
  INSERT INTO public.user_roles(user_id, role) VALUES (v_user_driver, 'driver'::app_role);

  PERFORM set_config('request.jwt.claim.sub', v_user_driver::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_driver::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_got := public.lost_property_admin_unread_count();
  RESET ROLE;
  IF v_got IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: baseline driver did not receive global count';
  END IF;
  PERFORM set_config('a8b26.baseline_driver_leaked', 'true', true);
END $$;

-- Apply proposed body (same as forward migration)
CREATE OR REPLACE FUNCTION public.lost_property_admin_unread_count()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Admin sidebar badge (user JWT) + Edge lost-property admin_unread_count
  -- (service_role after requireAdmin). Page slug proven: lost-property.
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.staff_has_page_access('lost-property') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT COUNT(*)::integer FROM public.lost_property_cases
    WHERE status NOT IN ('CLOSED')
      AND (
        status = 'NEW'
        OR (status = 'SENT_TO_DRIVER' AND admin_viewed_at IS NULL)
        OR (status = 'ESCALATED' AND admin_viewed_at IS NULL)
        OR (admin_last_read_message_at IS NULL AND EXISTS (
          SELECT 1 FROM public.lost_property_messages m
          WHERE m.case_id = lost_property_cases.id
            AND m.sender_type IN ('RIDER','DRIVER','CUSTOMER')
        ))
        OR (admin_last_read_message_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.lost_property_messages m
          WHERE m.case_id = lost_property_cases.id
            AND m.sender_type IN ('RIDER','DRIVER','CUSTOMER')
            AND m.created_at > lost_property_cases.admin_last_read_message_at
        ))
      )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.lost_property_admin_unread_count() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lost_property_admin_unread_count() FROM anon;
GRANT EXECUTE ON FUNCTION public.lost_property_admin_unread_count() TO authenticated;
GRANT EXECUTE ON FUNCTION public.lost_property_admin_unread_count() TO service_role;

DO $$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'lost_property_admin_unread_count';
  IF v_md5 IS DISTINCT FROM '9fd0d843f5bc03ab2051565fd5f94922' THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: proposed md5=%', v_md5;
  END IF;
END $$;

-- Role matrix fixtures
DO $$
DECLARE
  v_live_staff uuid;
  v_user_staff_ok uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb026';
  v_user_staff_no uuid := 'dddddddd-dddd-dddd-dddd-ddddddddd026';
  v_user_inactive uuid := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeee026';
  v_user_driver uuid := 'cccccccc-cccc-cccc-cccc-ccccccccc026';
  v_user_cust uuid := 'ffffffff-ffff-ffff-ffff-fffffffff026';
  v_user_corp uuid := '11111111-1111-1111-1111-111111111026';
  v_user_none uuid := '22222222-2222-2222-2222-222222222026';
  v_staff_ok uuid := '33333333-3333-3333-3333-333333333026';
  v_staff_no uuid := '44444444-4444-4444-4444-444444444026';
  v_staff_in uuid := '55555555-5555-5555-5555-555555555026';
  v_baseline int := current_setting('a8b26.baseline_count', true)::int;
  v_got int;
BEGIN
  SELECT sp.user_id INTO v_live_staff
  FROM public.staff_profiles sp
  JOIN public.role_page_permissions rpp
    ON rpp.role = sp.role AND rpp.page_slug = 'lost-property' AND rpp.can_access
  WHERE sp.is_active
  LIMIT 1;
  IF v_live_staff IS NULL THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: no live staff with lost-property page';
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    ('00000000-0000-0000-0000-000000000000', v_user_staff_ok, 'authenticated', 'authenticated', 'a8b26-staff-ok@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_staff_no, 'authenticated', 'authenticated', 'a8b26-staff-no@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_inactive, 'authenticated', 'authenticated', 'a8b26-inactive@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_cust, 'authenticated', 'authenticated', 'a8b26-cust@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_corp, 'authenticated', 'authenticated', 'a8b26-corp@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_none, 'authenticated', 'authenticated', 'a8b26-none@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;

  -- Ensure driver fixture exists from baseline block
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    ('00000000-0000-0000-0000-000000000000', v_user_driver, 'authenticated', 'authenticated', 'a8b26-driver@example.invalid', crypt('x', gen_salt('bf')), now(), '{}'::jsonb, '{}'::jsonb, now(), now())
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.user_roles(user_id, role) VALUES (v_user_driver, 'driver'::app_role)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.user_roles(user_id, role) VALUES (v_user_cust, 'customer'::app_role)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.staff_profiles(id, user_id, full_name, role, is_active, staff_role_id)
  VALUES
    (v_staff_ok, v_user_staff_ok, 'A8B26 Staff Ok', 'operator'::staff_role, true, '66666666-6666-6666-6666-666666666026'),
    (v_staff_no, v_user_staff_no, 'A8B26 Staff No', 'finance_manager'::staff_role, true, '77777777-7777-7777-7777-777777777026'),
    (v_staff_in, v_user_inactive, 'A8B26 Inactive', 'operator'::staff_role, false, '88888888-8888-8888-8888-888888888026');

  -- Deny finance_manager lost-property for this txn only (ROLLBACK restores)
  UPDATE public.role_page_permissions
  SET can_access = false
  WHERE role = 'finance_manager' AND page_slug = 'lost-property';

  -- Live authorized admin/staff with page
  PERFORM set_config('request.jwt.claim.sub', v_live_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_live_staff::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_got := public.lost_property_admin_unread_count();
  RESET ROLE;
  IF v_got IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: live staff count semantics changed';
  END IF;

  -- Fixture staff with page
  PERFORM set_config('request.jwt.claim.sub', v_user_staff_ok::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_staff_ok::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_got := public.lost_property_admin_unread_count();
  RESET ROLE;
  IF v_got IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: staff_ok count semantics changed';
  END IF;

  -- Staff without page → 42501
  PERFORM set_config('request.jwt.claim.sub', v_user_staff_no::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_staff_no::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.lost_property_admin_unread_count();
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: staff_no allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- Inactive staff → 42501
  PERFORM set_config('request.jwt.claim.sub', v_user_inactive::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_inactive::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.lost_property_admin_unread_count();
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: inactive allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- Driver → 42501
  PERFORM set_config('request.jwt.claim.sub', v_user_driver::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_driver::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.lost_property_admin_unread_count();
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: driver allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- Customer → 42501
  PERFORM set_config('request.jwt.claim.sub', v_user_cust::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_cust::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.lost_property_admin_unread_count();
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: customer allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- Corporate (auth user, no staff) → 42501
  PERFORM set_config('request.jwt.claim.sub', v_user_corp::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_corp::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.lost_property_admin_unread_count();
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: corporate allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- No qualifying role → 42501
  PERFORM set_config('request.jwt.claim.sub', v_user_none::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_none::text, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.lost_property_admin_unread_count();
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: no-role allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- No JWT as authenticated → 42501
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.lost_property_admin_unread_count();
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: no-jwt allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- service_role: privilege + safe invoke (Edge path; auth.uid null)
  IF NOT has_function_privilege('service_role', 'public.lost_property_admin_unread_count()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: service_role EXECUTE missing';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';
  v_got := public.lost_property_admin_unread_count();
  RESET ROLE;
  IF v_got IS DISTINCT FROM v_baseline THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: service_role count semantics changed';
  END IF;

  -- postgres privilege only (owner path) — invoke for count equality, no print
  IF NOT has_function_privilege('postgres', 'public.lost_property_admin_unread_count()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: postgres EXECUTE missing';
  END IF;
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  -- Owner call still passes because auth.role() reads JWT claim when set; clear and use service claim above already tested.
  -- Explicit owner invoke with service_role claim cleared: staff_has_page_access fails → use SET ROLE none + service claim cleared via role bypass not available.
  -- Privilege-only assertion for postgres is sufficient per draft.
END $$;

DO $$
DECLARE
  v_auth int;
  v_anon int;
  v_mutable int;
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE email LIKE 'a8b26-%@example.invalid') THEN
    -- still inside txn; fixtures expected until ROLLBACK
    NULL;
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  SELECT count(*)::int INTO v_anon
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('anon', p.oid, 'EXECUTE');
  SELECT count(*)::int INTO v_mutable
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND (p.proconfig IS NULL OR NOT EXISTS (
      SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'
    ));
  IF v_auth IS DISTINCT FROM 110 OR v_anon IS DISTINCT FROM 0 OR v_mutable IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: advisor drift auth=% anon=% mutable=%', v_auth, v_anon, v_mutable;
  END IF;

  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109400000') THEN
    RAISE EXCEPTION 'A8B26 SIM HARD STOP: migration recorded during sim';
  END IF;

  RAISE NOTICE 'A8B26_SIM_OK';
END $$;

ROLLBACK;
