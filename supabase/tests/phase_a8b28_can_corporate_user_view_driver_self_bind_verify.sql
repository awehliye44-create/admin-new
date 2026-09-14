-- Phase A8B28 body simulation. Applies the draft body, probes, then ROLLBACK.
-- Disposable JWT claim config and synthetic UUIDs only. Does not print real identities.
-- Does not invoke cleanup_photos / expire_chats / notifications / finance.

BEGIN;
RESET ROLE;

CREATE TEMP TABLE a8b28_before AS
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  md5(p.prosrc) AS body_md5,
  p.proacl::text AS acl,
  pg_get_viewdef('public.drivers_public_safe'::regclass, true) AS viewdef
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'can_corporate_user_view_driver';

CREATE TEMP TABLE a8b28_counts AS
SELECT
  (SELECT count(*)::int FROM public.trips) AS trips,
  (SELECT count(*)::int FROM public.corporate_user_accounts) AS cua,
  (SELECT count(*)::int FROM public.drivers) AS drivers,
  (SELECT count(*)::int FROM public.notifications) AS notifications,
  (SELECT count(*)::int FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*)::int FROM pg_proc x JOIN pg_namespace n ON n.oid = x.pronamespace
    WHERE n.nspname = 'public' AND x.prosecdef
      AND has_function_privilege('authenticated', x.oid, 'EXECUTE')) AS auth_secdef,
  (SELECT count(*)::int FROM pg_proc x JOIN pg_namespace n ON n.oid = x.pronamespace
    WHERE n.nspname = 'public' AND x.prosecdef
      AND has_function_privilege('anon', x.oid, 'EXECUTE')) AS anon_secdef;

DO $pre$
DECLARE
  v_baseline text;
BEGIN
  SELECT body_md5 INTO v_baseline FROM a8b28_before;
  IF v_baseline IS DISTINCT FROM 'b000bb084232102300009c2a03d9bcb0' THEN
    RAISE EXCEPTION 'A8B28 SIM HARD STOP: baseline md5=%', v_baseline;
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.can_corporate_user_view_driver(p_driver_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    auth.uid() IS NOT NULL
    AND p_user_id IS NOT DISTINCT FROM auth.uid()
    AND EXISTS (
      SELECT 1
      FROM trips t
      JOIN corporate_user_accounts cua ON cua.corporate_account_id = t.corporate_account_id
      WHERE t.driver_id = p_driver_id
        AND cua.user_id = p_user_id
        AND COALESCE(t.status, '') NOT IN ('cancelled', 'completed')
    )
$function$;

DO $simulate$
DECLARE
  v_proposed text;
  v_uid uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  v_foreign uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  v_driver uuid := 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
  v_r boolean;
  v_auth int;
  v_view text;
BEGIN
  SELECT md5(p.prosrc) INTO v_proposed
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'can_corporate_user_view_driver';

  IF v_proposed IS DISTINCT FROM '80c738f1ab36c17174bcc98a8416855c' THEN
    RAISE EXCEPTION 'A8B28 SIM HARD STOP: proposed md5=%', v_proposed;
  END IF;

  -- no JWT
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  v_r := public.can_corporate_user_view_driver(v_driver, v_uid);
  IF v_r IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'A8B28 SIM HARD STOP: no JWT expected false';
  END IF;

  -- authenticated self without membership → false
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text,
    true
  );
  v_r := public.can_corporate_user_view_driver(v_driver, v_uid);
  IF v_r IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'A8B28 SIM HARD STOP: self without trip expected false';
  END IF;

  -- foreign p_user_id under caller JWT → false (self-bind)
  v_r := public.can_corporate_user_view_driver(v_driver, v_foreign);
  IF v_r IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'A8B28 SIM HARD STOP: foreign user_id expected false';
  END IF;

  v_view := pg_get_viewdef('public.drivers_public_safe'::regclass, true);
  IF v_view IS DISTINCT FROM (SELECT viewdef FROM a8b28_before) THEN
    RAISE EXCEPTION 'A8B28 SIM HARD STOP: drivers_public_safe viewdef changed';
  END IF;
  IF v_view !~* 'can_corporate_user_view_driver\(id, auth\.uid\(\)\)' THEN
    RAISE EXCEPTION 'A8B28 SIM HARD STOP: view lost self auth.uid() call';
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc x
  JOIN pg_namespace n ON n.oid = x.pronamespace
  WHERE n.nspname = 'public'
    AND x.prosecdef
    AND has_function_privilege('authenticated', x.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 111 THEN
    RAISE EXCEPTION 'A8B28 SIM HARD STOP: auth_secdef=%', v_auth;
  END IF;

  IF has_function_privilege(
       'anon',
       'public.can_corporate_user_view_driver(uuid, uuid)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'public',
       'public.can_corporate_user_view_driver(uuid, uuid)'::regprocedure,
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'A8B28 SIM HARD STOP: PUBLIC/anon EXECUTE present';
  END IF;

  IF NOT has_function_privilege(
       'authenticated',
       'public.can_corporate_user_view_driver(uuid, uuid)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.can_corporate_user_view_driver(uuid, uuid)'::regprocedure,
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'A8B28 SIM HARD STOP: authenticated/service_role EXECUTE missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20261109420000'
  ) THEN
    RAISE EXCEPTION 'A8B28 SIM HARD STOP: migration version unexpectedly present';
  END IF;

  RAISE NOTICE 'A8B28_SIM_OK';
END $simulate$;

SELECT 'A8B28_SIM_OK' AS status;

ROLLBACK;
