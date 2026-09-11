-- Phase A8B23B transaction simulation only. BEGIN/ROLLBACK. Do not apply.

BEGIN;

-- Inline apply via DO blocks mirroring migration — kept self-contained below.

DO $$
DECLARE
  v_md5 text;
  v_auth int;
BEGIN
  IF (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1)
     IS DISTINCT FROM '20261109370000' THEN
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: latest drift';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109380000') THEN
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: already present';
  END IF;
  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'get_driver_document_eligibility'
    AND pg_get_function_identity_arguments(p.oid) = 'p_driver_id uuid';
  IF v_md5 IS DISTINCT FROM '55d576d83a424beb3de3c79a4cf629d4' THEN
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: baseline md5=%', v_md5;
  END IF;
  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: auth_secdef=%', v_auth;
  END IF;
END $$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'get_driver_document_eligibility'
    AND pg_get_function_identity_arguments(p.oid) = 'p_driver_id uuid';
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_driver_document_eligibility_internal(p_driver_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public''
AS %L',
    v_src
  );
END $$;

REVOKE ALL ON FUNCTION public.get_driver_document_eligibility_internal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility_internal(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility_internal(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility_internal(uuid) FROM service_role;

DO $$
DECLARE
  r record;
  v_src text;
  v_new text;
BEGIN
  FOR r IN
    SELECT p.proname,
           pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_function_result(p.oid) AS result,
           l.lanname,
           CASE p.provolatile WHEN 'v' THEN 'VOLATILE' WHEN 's' THEN 'STABLE' WHEN 'i' THEN 'IMMUTABLE' END AS vol,
           p.prosrc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    JOIN pg_language l ON l.oid = p.prolang
    WHERE p.proname IN (
      'check_driver_documents_approved',
      'assert_driver_presence_online_eligible',
      'accept_ride_offer_eligibility_guard'
    )
  LOOP
    v_src := r.prosrc;
    v_new := replace(v_src, 'get_driver_document_eligibility(', 'get_driver_document_eligibility_internal(');
    IF r.lanname = 'sql' THEN
      EXECUTE format(
        'CREATE OR REPLACE FUNCTION public.%I(%s) RETURNS %s LANGUAGE sql %s SECURITY DEFINER SET search_path TO ''public'' AS $function$%s$function$',
        r.proname, r.args, r.result, r.vol, v_new
      );
    ELSE
      EXECUTE format(
        'CREATE OR REPLACE FUNCTION public.%I(%s) RETURNS %s LANGUAGE plpgsql %s SECURITY DEFINER SET search_path TO ''public'' AS $function$%s$function$',
        r.proname, r.args, r.result, r.vol, v_new
      );
    END IF;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.check_driver_documents_approved(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_driver_document_eligibility(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Authenticated Driver self-service wrapper. Trusted arbitrary-driver
  -- evaluation lives in get_driver_document_eligibility_internal.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.drivers d
    WHERE d.id = p_driver_id
      AND d.user_id = auth.uid()
      AND d.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN public.get_driver_document_eligibility_internal(p_driver_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_driver_document_eligibility(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_document_eligibility(uuid) TO authenticated;

DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='get_driver_document_eligibility_internal')
     IS DISTINCT FROM '55d576d83a424beb3de3c79a4cf629d4' THEN
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: internal md5';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='get_driver_document_eligibility')
     IS DISTINCT FROM 'dab246830972a37c6351767322b0f66d' THEN
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: public md5';
  END IF;
  IF (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: mid auth_secdef';
  END IF;
END $$;

DO $$
DECLARE
  v_user_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaa023';
  v_user_b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbb023';
  v_user_c uuid := 'cccccccc-cccc-cccc-cccc-ccccccccc023';
  v_user_corp uuid := 'cccccccc-cccc-cccc-cccc-ccccccccc024';
  v_user_admin uuid := 'dddddddd-aaaa-aaaa-aaaa-aaaaaaaaa023';
  v_user_mod uuid := 'eeeeeeee-aaaa-aaaa-aaaa-aaaaaaaaa023';
  v_driver_a uuid := 'dddddddd-dddd-dddd-dddd-ddddddddd023';
  v_driver_b uuid := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeee023';
  v_doc uuid := 'ffffffff-aaaa-aaaa-aaaa-aaaaaaaaa023';
  v_region uuid; v_service_area uuid; v_slug text;
  v_base jsonb; v_new jsonb; v_bool boolean; v_elig jsonb;
  v_rows int;
BEGIN
  SELECT sa.region_id, sa.id INTO v_region, v_service_area
  FROM public.service_areas sa WHERE sa.region_id IS NOT NULL
  ORDER BY sa.created_at NULLS LAST, sa.id LIMIT 1;
  SELECT dt.slug INTO v_slug FROM public.document_types dt WHERE dt.is_active
  ORDER BY dt.display_order NULLS LAST LIMIT 1;

  INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, phone, phone_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) VALUES
    ('00000000-0000-0000-0000-000000000000', v_user_a, 'authenticated', 'authenticated', 'a8b23b-a@example.invalid', crypt('x', gen_salt('bf')), now(), '+440000000523', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_b, 'authenticated', 'authenticated', 'a8b23b-b@example.invalid', crypt('x', gen_salt('bf')), now(), '+440000000524', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_c, 'authenticated', 'authenticated', 'a8b23b-c@example.invalid', crypt('x', gen_salt('bf')), now(), NULL, NULL, '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_corp, 'authenticated', 'authenticated', 'a8b23b-corp@example.invalid', crypt('x', gen_salt('bf')), now(), NULL, NULL, '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_admin, 'authenticated', 'authenticated', 'a8b23b-admin@example.invalid', crypt('x', gen_salt('bf')), now(), NULL, NULL, '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_user_mod, 'authenticated', 'authenticated', 'a8b23b-mod@example.invalid', crypt('x', gen_salt('bf')), now(), NULL, NULL, '{}'::jsonb, '{}'::jsonb, now(), now());
  INSERT INTO public.user_roles(user_id, role) VALUES (v_user_admin, 'admin'::app_role), (v_user_mod, 'moderator'::app_role);
  INSERT INTO public.drivers(id, user_id, first_name, last_name, phone, email, region_id, service_area_id, approval_status, deleted_at) VALUES
    (v_driver_a, v_user_a, 'A', 'Driver', '+440000000523', 'a8b23b-a@example.invalid', v_region, v_service_area, 'pending', NULL),
    (v_driver_b, v_user_b, 'B', 'Driver', '+440000000524', 'a8b23b-b@example.invalid', v_region, v_service_area, 'pending', NULL);

  v_base := public.get_driver_document_eligibility_internal(v_driver_a);

  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);
  v_new := public.get_driver_document_eligibility(v_driver_a);
  IF v_new IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: self json mismatch';
  END IF;

  BEGIN
    PERFORM public.get_driver_document_eligibility(v_driver_b);
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: foreign allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM set_config('request.jwt.claim.sub', v_user_c::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_c::text, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.get_driver_document_eligibility(v_driver_a);
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: customer allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM set_config('request.jwt.claim.sub', v_user_corp::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_corp::text, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.get_driver_document_eligibility(v_driver_a);
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: corporate allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM set_config('request.jwt.claim.sub', v_user_mod::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_mod::text, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM public.get_driver_document_eligibility(v_driver_a);
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: staff allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    PERFORM public.get_driver_document_eligibility_internal(v_driver_a);
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: internal auth allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  RESET ROLE;
  INSERT INTO public.documents(id, driver_id, document_type, document_name, status, is_current)
  VALUES (v_doc, v_driver_b, v_slug, 'probe', 'pending', true);
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_user_admin::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_admin::text, 'role', 'authenticated')::text, true);
  UPDATE public.documents SET status = 'approved', updated_at = now() WHERE id = v_doc;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'A8B23B SIM HARD STOP: admin doc update'; END IF;

  UPDATE public.drivers SET approval_status = 'approved' WHERE id = v_driver_b;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'A8B23B SIM HARD STOP: admin driver approve'; END IF;

  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_a::text, 'role', 'authenticated')::text, true);
  v_elig := public.assert_driver_presence_online_eligible(v_driver_a);
  IF NOT (v_elig ? 'eligible') THEN RAISE EXCEPTION 'A8B23B SIM HARD STOP: assert shape'; END IF;

  v_elig := public.accept_ride_offer_eligibility_guard(v_driver_a);
  IF NOT (v_elig ? 'ok') THEN RAISE EXCEPTION 'A8B23B SIM HARD STOP: accept shape'; END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_bool := public.check_driver_documents_approved(v_driver_a);
  IF v_bool IS DISTINCT FROM COALESCE((v_base ->> 'approved')::boolean, false) THEN
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: service check mismatch';
  END IF;

  PERFORM set_config('request.jwt.claims', '{}', true);
  PERFORM public.check_driver_documents_approved(v_driver_b);
END $$;

-- Restore baseline inside the same transaction (rollback proof)
DO $$
DECLARE
  r record;
  v_src text;
  v_new text;
BEGIN
  FOR r IN
    SELECT p.proname,
           pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_function_result(p.oid) AS result,
           l.lanname,
           CASE p.provolatile WHEN 'v' THEN 'VOLATILE' WHEN 's' THEN 'STABLE' WHEN 'i' THEN 'IMMUTABLE' END AS vol,
           p.prosrc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    JOIN pg_language l ON l.oid = p.prolang
    WHERE p.proname IN (
      'check_driver_documents_approved',
      'assert_driver_presence_online_eligible',
      'accept_ride_offer_eligibility_guard'
    )
  LOOP
    v_new := replace(r.prosrc, 'get_driver_document_eligibility_internal(', 'get_driver_document_eligibility(');
    IF r.lanname = 'sql' THEN
      EXECUTE format(
        'CREATE OR REPLACE FUNCTION public.%I(%s) RETURNS %s LANGUAGE sql %s SECURITY DEFINER SET search_path TO ''public'' AS $function$%s$function$',
        r.proname, r.args, r.result, r.vol, v_new
      );
    ELSE
      EXECUTE format(
        'CREATE OR REPLACE FUNCTION public.%I(%s) RETURNS %s LANGUAGE plpgsql %s SECURITY DEFINER SET search_path TO ''public'' AS $function$%s$function$',
        r.proname, r.args, r.result, r.vol, v_new
      );
    END IF;
  END LOOP;

  SELECT p.prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'get_driver_document_eligibility_internal';
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_driver_document_eligibility(p_driver_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public''
AS %L',
    v_src
  );
END $$;

GRANT EXECUTE ON FUNCTION public.check_driver_documents_approved(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_document_eligibility(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_document_eligibility(uuid) TO service_role;
DROP FUNCTION public.get_driver_document_eligibility_internal(uuid);

DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='get_driver_document_eligibility')
     IS DISTINCT FROM '55d576d83a424beb3de3c79a4cf629d4' THEN
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: restored public md5';
  END IF;
  IF (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B23B SIM HARD STOP: restored auth_secdef';
  END IF;
END $$;

ROLLBACK;

SELECT json_build_object(
  'status', 'A8B23B_SIM_OK',
  'latest', (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1),
  'has_a8b23b', EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109380000'),
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
  'elig_md5', (
    SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname = 'get_driver_document_eligibility'
  ),
  'internal_absent', NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname = 'get_driver_document_eligibility_internal'
  ),
  'trips', (SELECT count(*)::int FROM public.trips),
  'fixtures_absent', NOT EXISTS (
    SELECT 1 FROM auth.users WHERE email LIKE 'a8b23b-%@example.invalid'
  ),
  'proposed_public_md5', 'dab246830972a37c6351767322b0f66d',
  'baseline_public_md5', '55d576d83a424beb3de3c79a4cf629d4'
) AS sim_result;
