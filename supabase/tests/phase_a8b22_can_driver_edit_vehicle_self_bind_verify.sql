-- Phase A8B22 transaction simulation only. BEGIN/ROLLBACK. Do not apply.

BEGIN;

DO $$
DECLARE
  v_latest text;
  v_auth int;
  v_md5 text;
  v_acl text;
BEGIN
  SELECT version INTO v_latest
  FROM supabase_migrations.schema_migrations
  ORDER BY version DESC LIMIT 1;
  IF v_latest IS DISTINCT FROM '20261109360000' THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: latest=%', v_latest;
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109370000') THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: already present';
  END IF;
  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: auth_secdef=%', v_auth;
  END IF;
  IF (SELECT count(*)::int FROM public.trips) IS DISTINCT FROM 480 THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: trips drift';
  END IF;
  SELECT md5(p.prosrc), coalesce(p.proacl::text, 'NULL')
  INTO v_md5, v_acl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'can_driver_edit_vehicle'
    AND pg_get_function_identity_arguments(p.oid) = 'p_driver_id uuid';
  IF v_md5 IS DISTINCT FROM '49ee9d3d28b6b13d4e341f108eba79e5' THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: baseline md5=%', v_md5;
  END IF;
  IF v_acl IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: baseline acl=%', v_acl;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.can_driver_edit_vehicle(p_driver_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_vehicle_locked boolean;
  v_approval_status text;
BEGIN
  -- Authenticated callers may only evaluate their own driver row.
  -- Null auth.uid() preserves the vehicles trigger / service_role internal path
  -- (check_vehicle_edit_allowed); that path does not grant authenticated cross-driver reads.
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.drivers d
      WHERE d.id = p_driver_id
        AND d.user_id = auth.uid()
        AND d.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT vehicle_locked, approval_status
  INTO v_vehicle_locked, v_approval_status
  FROM drivers
  WHERE id = p_driver_id;

  -- Can edit if not locked OR if driver is still pending approval
  RETURN (NOT COALESCE(v_vehicle_locked, false)) OR (v_approval_status = 'pending');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.can_driver_edit_vehicle(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_driver_edit_vehicle(uuid) TO service_role;

DO $$
DECLARE
  v_md5 text;
  v_acl text;
  v_auth int;
  v_user_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa022';
  v_user_b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb022';
  v_user_c uuid := 'cccccccc-cccc-cccc-cccc-ccccccccc022';
  v_driver_a uuid := 'dddddddd-dddd-dddd-dddd-ddddddddd022';
  v_driver_b uuid := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeee022';
  v_region uuid;
  v_service_area uuid;
  v_ok boolean;
  v_result boolean;
BEGIN
  SELECT sa.region_id, sa.id
  INTO v_region, v_service_area
  FROM public.service_areas sa
  WHERE sa.region_id IS NOT NULL
  ORDER BY sa.created_at NULLS LAST, sa.id
  LIMIT 1;
  IF v_region IS NULL OR v_service_area IS NULL THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: no service_area/region fixture available';
  END IF;
  SELECT md5(p.prosrc), coalesce(p.proacl::text, 'NULL')
  INTO v_md5, v_acl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'can_driver_edit_vehicle'
    AND pg_get_function_identity_arguments(p.oid) = 'p_driver_id uuid';
  IF v_md5 IS DISTINCT FROM '25e0661516a3f94821b02a0fabe69cab' THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: proposed md5=%', v_md5;
  END IF;
  IF v_acl IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: mid acl=%', v_acl;
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: mid auth_secdef=%', v_auth;
  END IF;

  -- Trigger parent unchanged (hash is md5(prosrc); functiondef MD5 is 6537e6b1…)
  -- Parent still bypasses via has_role(auth.uid(),'admin') before calling the child.
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='check_vehicle_edit_allowed')
     IS DISTINCT FROM 'f75402c7ca6e1af186cc4656de927f2a' THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: trigger parent drifted';
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    phone, phone_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    ('00000000-0000-0000-0000-000000000000', v_user_a, 'authenticated', 'authenticated',
     'a8b22-driver-a@example.invalid', crypt('x', gen_salt('bf')), now(),
     '+440000000022', now(),
     '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_b, 'authenticated', 'authenticated',
     'a8b22-driver-b@example.invalid', crypt('x', gen_salt('bf')), now(),
     '+440000000023', now(),
     '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_c, 'authenticated', 'authenticated',
     'a8b22-customer@example.invalid', crypt('x', gen_salt('bf')), now(),
     NULL, NULL,
     '{}'::jsonb, '{}'::jsonb, now(), now());

  -- Driver A stays pending → can edit (true).
  -- Driver B is approved via UPDATE so sync_vehicle_approval locks the vehicle → false.
  INSERT INTO public.drivers (
    id, user_id, first_name, last_name, phone, email, region_id, service_area_id,
    approval_status, vehicle_locked, deleted_at
  ) VALUES
    (v_driver_a, v_user_a, 'A', 'Driver', '+440000000022', 'a8b22-driver-a@example.invalid', v_region, v_service_area,
     'pending', true, NULL),
    (v_driver_b, v_user_b, 'B', 'Driver', '+440000000023', 'a8b22-driver-b@example.invalid', v_region, v_service_area,
     'pending', true, NULL);

  UPDATE public.drivers
  SET approval_status = 'approved'
  WHERE id = v_driver_b;

  -- self pending → true
  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
  v_result := public.can_driver_edit_vehicle(v_driver_a);
  IF v_result IS NOT TRUE THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: self pending expected true';
  END IF;

  -- self approved+locked → false
  PERFORM set_config('request.jwt.claim.sub', v_user_b::text, true);
  v_result := public.can_driver_edit_vehicle(v_driver_b);
  IF v_result IS NOT FALSE THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: self locked expected false';
  END IF;

  -- other driver → 42501
  BEGIN
    PERFORM public.can_driver_edit_vehicle(v_driver_a);
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: other driver allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- customer (no driver row) → 42501
  PERFORM set_config('request.jwt.claim.sub', v_user_c::text, true);
  BEGIN
    PERFORM public.can_driver_edit_vehicle(v_driver_a);
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: customer allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- no JWT: privilege-only path (postgres/no-JWT or service_role-without-sub)
  -- still evaluates lock. This is NOT the normal Driver/Admin vehicles-trigger
  -- path — those keep a non-null auth.uid(); Admin bypasses before the child.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  IF auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: jwt clear failed';
  END IF;
  v_result := public.can_driver_edit_vehicle(v_driver_b);
  IF v_result IS NOT FALSE THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: null-jwt locked expected false';
  END IF;

  v_ok := has_function_privilege('service_role', 'public.can_driver_edit_vehicle(uuid)'::regprocedure, 'EXECUTE')
      AND has_function_privilege('postgres', 'public.can_driver_edit_vehicle(uuid)'::regprocedure, 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.can_driver_edit_vehicle(uuid)'::regprocedure, 'EXECUTE');
  IF NOT v_ok THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: privilege drift';
  END IF;
END $$;

-- Restore baseline
CREATE OR REPLACE FUNCTION public.can_driver_edit_vehicle(p_driver_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_vehicle_locked boolean;
  v_approval_status text;
BEGIN
  SELECT vehicle_locked, approval_status
  INTO v_vehicle_locked, v_approval_status
  FROM drivers
  WHERE id = p_driver_id;
  
  -- Can edit if not locked OR if driver is still pending approval
  RETURN (NOT COALESCE(v_vehicle_locked, false)) OR (v_approval_status = 'pending');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.can_driver_edit_vehicle(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_driver_edit_vehicle(uuid) TO service_role;

DO $$
DECLARE
  v_md5 text;
  v_auth int;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'can_driver_edit_vehicle'
    AND pg_get_function_identity_arguments(p.oid) = 'p_driver_id uuid';
  IF v_md5 IS DISTINCT FROM '49ee9d3d28b6b13d4e341f108eba79e5' THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: restored md5=%', v_md5;
  END IF;
  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B22 SIM HARD STOP: restored auth_secdef=%', v_auth;
  END IF;
END $$;

ROLLBACK;

SELECT json_build_object(
  'status', 'A8B22_SIM_OK',
  'latest', (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1),
  'has_a8b22', EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109370000'),
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
  'missing_search_path', (
    SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND (p.proconfig IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c WHERE c LIKE 'search_path=%'
      ))
  ),
  'md5', (
    SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname = 'can_driver_edit_vehicle'
      AND pg_get_function_identity_arguments(p.oid) = 'p_driver_id uuid'
  ),
  'acl', (
    SELECT coalesce(p.proacl::text, 'NULL') FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname = 'can_driver_edit_vehicle'
      AND pg_get_function_identity_arguments(p.oid) = 'p_driver_id uuid'
  ),
  'trips', (SELECT count(*)::int FROM public.trips),
  'fixtures_absent', NOT EXISTS (
    SELECT 1 FROM auth.users WHERE email LIKE 'a8b22-%@example.invalid'
  )
) AS sim_result;
