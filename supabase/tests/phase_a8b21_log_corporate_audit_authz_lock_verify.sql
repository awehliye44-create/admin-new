-- Phase A8B21 transaction simulation only. BEGIN/ROLLBACK. Do not apply.
-- Asserts body MD5 transition, ACL preservation, fixture authz matrix,
-- SECDEF count unchanged, migration absent after rollback.

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
  ORDER BY version DESC
  LIMIT 1;
  IF v_latest IS DISTINCT FROM '20261109350000' THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: latest=%', v_latest;
  END IF;

  IF EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109360000'
  ) THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: 20261109360000 already present';
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: auth_secdef=%', v_auth;
  END IF;

  IF (SELECT count(*)::int FROM public.trips) IS DISTINCT FROM 480 THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: trips drift';
  END IF;

  SELECT md5(p.prosrc), coalesce(p.proacl::text, 'NULL')
  INTO v_md5, v_acl
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'log_corporate_audit'
    AND pg_get_function_identity_arguments(p.oid) =
      'p_corporate_account_id uuid, p_action text, p_action_type text, p_target_type text, p_target_id text, p_target_name text, p_metadata jsonb';

  IF v_md5 IS DISTINCT FROM '189b2b510f1aefb10b115aea3e6a3d0f' THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: baseline md5=%', v_md5;
  END IF;
  IF v_acl IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: baseline acl=%', v_acl;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.log_corporate_audit(
  p_corporate_account_id uuid,
  p_action text,
  p_action_type text,
  p_target_type text DEFAULT NULL::text,
  p_target_id text DEFAULT NULL::text,
  p_target_name text DEFAULT NULL::text,
  p_metadata jsonb DEFAULT NULL::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_audit_id uuid;
  v_uid uuid := auth.uid();
  v_allowed boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_corporate_account_id IS NULL
     OR COALESCE(btrim(p_action), '') = ''
     OR COALESCE(btrim(p_action_type), '') = '' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_metadata IS NOT NULL AND octet_length(p_metadata::text) > 4096 THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF (p_action, p_action_type, COALESCE(p_target_type, '')) IN (
       ('Employee Added', 'create', 'employee'),
       ('Employee Removed', 'delete', 'employee'),
       ('Location Added', 'create', 'location')
     ) THEN
    v_allowed := public.can_write_corporate(v_uid, p_corporate_account_id);
  ELSIF (p_action, p_action_type, COALESCE(p_target_type, '')) =
        ('Support Ticket Created', 'create', 'ticket') THEN
    v_allowed := public.has_corporate_access(v_uid, p_corporate_account_id);
  ELSE
    v_allowed := false;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.corporate_audit_log (
    corporate_account_id, user_id, action, action_type,
    target_type, target_id, target_name, metadata
  ) VALUES (
    p_corporate_account_id, v_uid, p_action, p_action_type,
    p_target_type, p_target_id, p_target_name, p_metadata
  ) RETURNING id INTO v_audit_id;

  RETURN v_audit_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.log_corporate_audit(uuid, text, text, text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_corporate_audit(uuid, text, text, text, text, text, jsonb) TO service_role;

DO $$
DECLARE
  v_md5 text;
  v_acl text;
  v_auth int;
  v_acct uuid := 'cccccccc-cccc-cccc-cccc-ccccccccccc1';
  v_acct_foreign uuid := 'cccccccc-cccc-cccc-cccc-ccccccccccc2';
  v_writer uuid := 'dddddddd-dddd-dddd-dddd-ddddddddddd1';
  v_viewer uuid := 'dddddddd-dddd-dddd-dddd-ddddddddddd2';
  v_outsider uuid := 'dddddddd-dddd-dddd-dddd-ddddddddddd3';
  v_audit uuid;
  v_ok boolean;
BEGIN
  SELECT md5(p.prosrc), coalesce(p.proacl::text, 'NULL')
  INTO v_md5, v_acl
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'log_corporate_audit'
    AND pg_get_function_identity_arguments(p.oid) =
      'p_corporate_account_id uuid, p_action text, p_action_type text, p_target_type text, p_target_id text, p_target_name text, p_metadata jsonb';

  IF v_md5 IS DISTINCT FROM '9d2aaa16834baa880931cd49b43553de' THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: proposed md5=%', v_md5;
  END IF;
  IF v_acl IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: mid acl=%', v_acl;
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: mid auth_secdef=%', v_auth;
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    ('00000000-0000-0000-0000-000000000000', v_writer, 'authenticated', 'authenticated',
     'a8b21-sim-writer@example.invalid', crypt('x', gen_salt('bf')), now(),
     '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_viewer, 'authenticated', 'authenticated',
     'a8b21-sim-viewer@example.invalid', crypt('x', gen_salt('bf')), now(),
     '{}'::jsonb, '{}'::jsonb, now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_outsider, 'authenticated', 'authenticated',
     'a8b21-sim-outsider@example.invalid', crypt('x', gen_salt('bf')), now(),
     '{}'::jsonb, '{}'::jsonb, now(), now());

  INSERT INTO public.corporate_accounts (id, company_name, contact_name, contact_email, status)
  VALUES
    (v_acct, 'A8B21 Sim Co', 'Sim Contact', 'a8b21-sim-contact@example.invalid', 'active'),
    (v_acct_foreign, 'A8B21 Sim Foreign', 'Sim Foreign', 'a8b21-sim-foreign@example.invalid', 'active');

  INSERT INTO public.corporate_user_accounts (user_id, corporate_account_id, role) VALUES
    (v_writer, v_acct, 'admin'),
    (v_viewer, v_acct, 'viewer');

  -- writer: employee add OK
  PERFORM set_config('request.jwt.claim.sub', v_writer::text, true);
  v_audit := public.log_corporate_audit(v_acct, 'Employee Added', 'create', 'employee', NULL, 'Sim Emp', NULL);
  IF v_audit IS NULL THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: writer employee insert failed';
  END IF;

  -- writer: foreign account denied
  BEGIN
    PERFORM public.log_corporate_audit(v_acct_foreign, 'Employee Added', 'create', 'employee', NULL, 'X', NULL);
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: foreign write unexpectedly allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- viewer: employee forge denied
  PERFORM set_config('request.jwt.claim.sub', v_viewer::text, true);
  BEGIN
    PERFORM public.log_corporate_audit(v_acct, 'Employee Added', 'create', 'employee', NULL, 'Forge', NULL);
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: viewer employee forge allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- viewer: support ticket OK
  v_audit := public.log_corporate_audit(
    v_acct, 'Support Ticket Created', 'create', 'ticket', NULL, 'Sim Ticket', NULL
  );
  IF v_audit IS NULL THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: viewer ticket insert failed';
  END IF;

  -- outsider denied
  PERFORM set_config('request.jwt.claim.sub', v_outsider::text, true);
  BEGIN
    PERFORM public.log_corporate_audit(
      v_acct, 'Support Ticket Created', 'create', 'ticket', NULL, 'No', NULL
    );
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: outsider allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  -- unknown action denied for writer
  PERFORM set_config('request.jwt.claim.sub', v_writer::text, true);
  BEGIN
    PERFORM public.log_corporate_audit(v_acct, 'Payroll Changed', 'update', 'billing', NULL, 'X', NULL);
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: unknown action allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  v_ok := (
    SELECT count(*)::int = 2
    FROM public.corporate_audit_log
    WHERE corporate_account_id = v_acct
      AND action IN ('Employee Added', 'Support Ticket Created')
  );
  IF NOT v_ok THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: unexpected audit row count';
  END IF;
END $$;

-- Restore baseline body inside the same transaction.
CREATE OR REPLACE FUNCTION public.log_corporate_audit(
  p_corporate_account_id uuid,
  p_action text,
  p_action_type text,
  p_target_type text DEFAULT NULL::text,
  p_target_id text DEFAULT NULL::text,
  p_target_name text DEFAULT NULL::text,
  p_metadata jsonb DEFAULT NULL::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_audit_id UUID;
BEGIN
  INSERT INTO public.corporate_audit_log (
    corporate_account_id, user_id, action, action_type, 
    target_type, target_id, target_name, metadata
  ) VALUES (
    p_corporate_account_id, auth.uid(), p_action, p_action_type,
    p_target_type, p_target_id, p_target_name, p_metadata
  ) RETURNING id INTO v_audit_id;
  
  RETURN v_audit_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.log_corporate_audit(uuid, text, text, text, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_corporate_audit(uuid, text, text, text, text, text, jsonb) TO service_role;

DO $$
DECLARE
  v_md5 text;
  v_auth int;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'log_corporate_audit'
    AND pg_get_function_identity_arguments(p.oid) =
      'p_corporate_account_id uuid, p_action text, p_action_type text, p_target_type text, p_target_id text, p_target_name text, p_metadata jsonb';
  IF v_md5 IS DISTINCT FROM '189b2b510f1aefb10b115aea3e6a3d0f' THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: restored md5=%', v_md5;
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B21 SIM HARD STOP: restored auth_secdef=%', v_auth;
  END IF;
END $$;

ROLLBACK;

SELECT json_build_object(
  'status', 'A8B21_SIM_OK',
  'latest', (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1),
  'has_a8b21', EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109360000'),
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
  'log_corporate_audit_md5', (
    SELECT md5(p.prosrc)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname = 'log_corporate_audit'
      AND pg_get_function_identity_arguments(p.oid) =
        'p_corporate_account_id uuid, p_action text, p_action_type text, p_target_type text, p_target_id text, p_target_name text, p_metadata jsonb'
  ),
  'log_corporate_audit_acl', (
    SELECT coalesce(p.proacl::text, 'NULL')
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname = 'log_corporate_audit'
      AND pg_get_function_identity_arguments(p.oid) =
        'p_corporate_account_id uuid, p_action text, p_action_type text, p_target_type text, p_target_id text, p_target_name text, p_metadata jsonb'
  ),
  'trips', (SELECT count(*)::int FROM public.trips),
  'fixtures_absent', NOT EXISTS (
    SELECT 1 FROM auth.users WHERE email LIKE 'a8b21-sim-%@example.invalid'
  )
) AS sim_result;
