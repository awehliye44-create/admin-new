-- Phase A8B20 transaction simulation only. BEGIN/ROLLBACK. Do not apply.
-- Asserts body MD5 transition, ACL preservation, caller compatibility,
-- SECDEF count unchanged, migration absent after rollback.

BEGIN;

DO $$
DECLARE
  v_latest text;
  v_auth int;
  v_md5 text;
  v_acl text;
  v_parent_has_call boolean;
BEGIN
  SELECT version INTO v_latest
  FROM supabase_migrations.schema_migrations
  ORDER BY version DESC
  LIMIT 1;
  IF v_latest IS DISTINCT FROM '20261109340000' THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: latest=%', v_latest;
  END IF;

  IF EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109350000'
  ) THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: 20261109350000 already present';
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: auth_secdef=%', v_auth;
  END IF;

  IF (SELECT count(*)::int FROM public.trips) IS DISTINCT FROM 480 THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: trips drift';
  END IF;

  SELECT md5(p.prosrc), coalesce(p.proacl::text, 'NULL')
  INTO v_md5, v_acl
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'is_admin'
    AND pg_get_function_identity_arguments(p.oid) = '';

  IF v_md5 IS DISTINCT FROM '31925d8b75f95e780ed00846e788c399' THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: baseline md5=%', v_md5;
  END IF;
  IF v_acl IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: baseline acl=%', v_acl;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname = 'admin_driver_wallet_eligibility_balances'
      AND p.prosrc ~ '\mis_admin\s*\('
  ) INTO v_parent_has_call;
  IF NOT v_parent_has_call THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: finance parent lost is_admin call';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.has_role(auth.uid(), 'admin'::public.app_role)
$function$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO service_role;

DO $$
DECLARE
  v_md5 text;
  v_acl text;
  v_auth int;
  v_owner text;
  v_lang text;
  v_vol text;
  v_search text;
  v_prosecdef boolean;
  v_parent_has_call boolean;
BEGIN
  SELECT md5(p.prosrc),
         coalesce(p.proacl::text, 'NULL'),
         r.rolname,
         l.lanname,
         p.provolatile::text,
         array_to_string(p.proconfig, ','),
         p.prosecdef
  INTO v_md5, v_acl, v_owner, v_lang, v_vol, v_search, v_prosecdef
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  JOIN pg_roles r ON r.oid = p.proowner
  JOIN pg_language l ON l.oid = p.prolang
  WHERE p.proname = 'is_admin'
    AND pg_get_function_identity_arguments(p.oid) = '';

  IF v_md5 IS DISTINCT FROM '63fcc2103c85dd3aeb1796bee8d8720e' THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: proposed md5=%', v_md5;
  END IF;
  IF v_acl IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: mid acl=%', v_acl;
  END IF;
  IF v_owner IS DISTINCT FROM 'postgres'
     OR v_lang IS DISTINCT FROM 'sql'
     OR v_vol IS DISTINCT FROM 's'
     OR NOT v_prosecdef
     OR v_search IS DISTINCT FROM 'search_path=public' THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: attrs owner=% lang=% vol=% secdef=% search=%',
      v_owner, v_lang, v_vol, v_prosecdef, v_search;
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: mid auth_secdef=%', v_auth;
  END IF;

  -- Nested postgres owner EXECUTE remains valid for finance parent.
  IF NOT has_function_privilege('postgres', 'public.is_admin()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: postgres lost EXECUTE';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname = 'admin_driver_wallet_eligibility_balances'
      AND p.prosrc ~ '\mis_admin\s*\('
      AND md5(p.prosrc) = '2ef13020e6ed85f94d3849ce1e37a7a1'
  ) INTO v_parent_has_call;
  IF NOT v_parent_has_call THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: finance parent body drifted';
  END IF;

  -- No operational invocation of is_admin or finance parent.
END $$;

-- Restore baseline body inside the same transaction before ROLLBACK clarity.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = auth.uid()
    AND raw_user_meta_data->>'role' = 'admin'
  )
$function$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO service_role;

DO $$
DECLARE
  v_md5 text;
  v_auth int;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'is_admin'
    AND pg_get_function_identity_arguments(p.oid) = '';
  IF v_md5 IS DISTINCT FROM '31925d8b75f95e780ed00846e788c399' THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: restored md5=%', v_md5;
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B20 SIM HARD STOP: restored auth_secdef=%', v_auth;
  END IF;
END $$;

ROLLBACK;

SELECT json_build_object(
  'status', 'A8B20_SIM_OK',
  'latest', (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1),
  'has_a8b20', EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109350000'),
  'auth_secdef', (
    SELECT count(*)::int
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ),
  'anon_secdef', (
    SELECT count(*)::int
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  'missing_search_path', (
    SELECT count(*)::int
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND (
        p.proconfig IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c
          WHERE c LIKE 'search_path=%'
        )
      )
  ),
  'is_admin_md5', (
    SELECT md5(p.prosrc)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname = 'is_admin'
      AND pg_get_function_identity_arguments(p.oid) = ''
  ),
  'is_admin_acl', (
    SELECT coalesce(p.proacl::text, 'NULL')
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname = 'is_admin'
      AND pg_get_function_identity_arguments(p.oid) = ''
  ),
  'trips', (SELECT count(*)::int FROM public.trips)
) AS sim_result;
