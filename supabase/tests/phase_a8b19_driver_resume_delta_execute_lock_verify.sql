-- Phase A8B19 ACL simulation. Privilege/catalog checks only.
-- Does not invoke the body (lifecycle-shaped). Uses ACL 42501 denial.
-- Use BEGIN/ROLLBACK only.

BEGIN;

CREATE TEMP TABLE a8b19_expected (
  name text PRIMARY KEY,
  identity_args text NOT NULL,
  regproc text NOT NULL,
  body_md5 text NOT NULL,
  lang text NOT NULL,
  vol char NOT NULL
);

INSERT INTO a8b19_expected VALUES (
  'get_driver_resume_delta',
  'p_since_server_ts timestamp with time zone, p_known_active_trip_id uuid, p_known_offer_id uuid',
  'public.get_driver_resume_delta(timestamp with time zone, uuid, uuid)',
  'e67909a7cb847acbb686306b54ff5b59',
  'plpgsql',
  's'
);

DO $pre$
BEGIN
  IF (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1) <> '20261109330000' THEN
    RAISE EXCEPTION 'A8B19 pre: latest migration drift (expected 20261109330000)';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109340000') THEN
    RAISE EXCEPTION 'A8B19 pre: migration already present';
  END IF;
  IF (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> 111 THEN
    RAISE EXCEPTION 'A8B19 pre: auth SECDEF <> 111';
  END IF;
  IF (SELECT count(*)::int FROM public.trips) <> 480 THEN
    RAISE EXCEPTION 'A8B19 pre: trips <> 480';
  END IF;
  IF (SELECT count(*) FROM a8b19_expected e
      JOIN pg_proc p ON p.proname = e.name
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE md5(p.prosrc) = e.body_md5
        AND pg_get_function_identity_arguments(p.oid) = e.identity_args
        AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND has_function_privilege('postgres', p.oid, 'EXECUTE')
        AND (SELECT count(*) FROM pg_proc p2 WHERE p2.pronamespace=p.pronamespace AND p2.proname=p.proname) = 1
     ) <> 1 THEN
    RAISE EXCEPTION 'A8B19 pre: hash/args/ACL/overload mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc parent
    WHERE parent.pronamespace = 'public'::regnamespace
      AND parent.proname <> 'get_driver_resume_delta'
      AND parent.prosrc ~ '\mget_driver_resume_delta\M'
  ) THEN
    RAISE EXCEPTION 'A8B19 pre: unexpected SQL parent';
  END IF;
END;
$pre$;

CREATE TEMP TABLE a8b19_counts AS
SELECT
  (SELECT count(*)::int FROM public.drivers) AS drivers,
  (SELECT count(*)::int FROM public.trips) AS trips,
  (SELECT count(*)::int FROM public.ride_offers) AS ride_offers,
  (SELECT count(*)::int FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*)::int FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT COALESCE(sum(amount_pence),0)::bigint FROM public.driver_wallet_ledger) AS wallet_signed_sum,
  (SELECT count(*)::int FROM public.driver_commission_wallet_ledger) AS cw_rows,
  (SELECT count(*)::int FROM public.notifications) AS notifications,
  (SELECT count(*)::int FROM public.driver_presence) AS driver_presence,
  (SELECT count(*)::int FROM public.towards_destination_sessions) AS td_sessions,
  (SELECT count(*)::int FROM public.push_tokens) AS push_tokens,
  (SELECT count(*)::int FROM public.demand_zone_audit_log) AS demand_zone_audit_log,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_secdef,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND (p.proconfig IS NULL OR NOT EXISTS (
         SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) c WHERE c LIKE 'search_path=%'
       ))) AS missing_search_path;

REVOKE ALL ON FUNCTION public.get_driver_resume_delta(timestamp with time zone, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_resume_delta(timestamp with time zone, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_resume_delta(timestamp with time zone, uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_driver_resume_delta(timestamp with time zone, uuid, uuid) FROM service_role;

DO $mid$
DECLARE
  e a8b19_expected%ROWTYPE;
  p oid;
  denied int := 0;
  v_auth_count int;
  -- Harmless sentinel: ACL must fail with 42501 before body (no lifecycle data read).
  probe text := $p$SELECT public.get_driver_resume_delta(NULL::timestamptz, NULL::uuid, NULL::uuid)$p$;
BEGIN
  IF (SELECT auth_secdef FROM a8b19_counts) <> 111 THEN
    RAISE EXCEPTION 'A8B19 mid: baseline auth SECDEF was not 111';
  END IF;

  SELECT * INTO e FROM a8b19_expected LIMIT 1;
  SELECT p2.oid INTO p
  FROM pg_proc p2
  JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
  WHERE p2.proname = e.name
    AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
  IF p IS NULL THEN RAISE EXCEPTION 'A8B19 mid: missing function'; END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
    RAISE EXCEPTION 'A8B19 mid: body hash changed';
  END IF;
  IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = p)) <> 'postgres' THEN
    RAISE EXCEPTION 'A8B19 mid: owner changed';
  END IF;
  IF (SELECT l.lanname FROM pg_proc p2 JOIN pg_language l ON l.oid=p2.prolang WHERE p2.oid=p) <> e.lang THEN
    RAISE EXCEPTION 'A8B19 mid: language drift';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = p) <> e.vol THEN
    RAISE EXCEPTION 'A8B19 mid: volatility drift';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = p) THEN
    RAISE EXCEPTION 'A8B19 mid: secdef lost';
  END IF;
  IF coalesce(array_to_string((SELECT proconfig FROM pg_proc WHERE oid = p), ','), '') !~* 'search_path=' THEN
    RAISE EXCEPTION 'A8B19 mid: search_path lost';
  END IF;
  IF (SELECT proacl FROM pg_proc WHERE oid = p) IS DISTINCT FROM '{postgres=X/postgres}'::aclitem[] THEN
    RAISE EXCEPTION 'A8B19 mid: ACL not postgres-only: %', (SELECT proacl FROM pg_proc WHERE oid = p);
  END IF;
  IF has_function_privilege('authenticated', p, 'EXECUTE')
     OR has_function_privilege('anon', p, 'EXECUTE')
     OR has_function_privilege('service_role', p, 'EXECUTE')
     OR NOT has_function_privilege('postgres', p, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B19 mid: privilege drift';
  END IF;

  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    EXECUTE probe;
    RAISE EXCEPTION 'A8B19 mid: expected 42501 but succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      denied := denied + 1;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'A8B19 mid: expected 42501 got %:%', SQLSTATE, SQLERRM;
  END;
  PERFORM set_config('role', 'postgres', true);

  IF denied <> 1 THEN
    RAISE EXCEPTION 'A8B19 mid: denied count %', denied;
  END IF;

  SELECT count(*)::int INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> 110 THEN
    RAISE EXCEPTION 'A8B19 mid: auth SECDEF % (expected 110)', v_auth_count;
  END IF;
END;
$mid$;

GRANT EXECUTE ON FUNCTION public.get_driver_resume_delta(timestamp with time zone, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_resume_delta(timestamp with time zone, uuid, uuid) TO service_role;

DO $post$
DECLARE
  e a8b19_expected%ROWTYPE;
  p oid;
  v_auth_count int;
BEGIN
  SELECT * INTO e FROM a8b19_expected LIMIT 1;
  SELECT p2.oid INTO p
  FROM pg_proc p2
  JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
  WHERE p2.proname = e.name
    AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
    RAISE EXCEPTION 'A8B19 post: body hash changed';
  END IF;
  IF NOT has_function_privilege('authenticated', p, 'EXECUTE')
     OR NOT has_function_privilege('service_role', p, 'EXECUTE')
     OR has_function_privilege('anon', p, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B19 post: ACL restore failed';
  END IF;

  SELECT count(*)::int INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> 111 THEN
    RAISE EXCEPTION 'A8B19 post: auth SECDEF % after rollback (expected 111)', v_auth_count;
  END IF;

  IF (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1) <> '20261109330000' THEN
    RAISE EXCEPTION 'A8B19 post: migration history drifted';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109340000') THEN
    RAISE EXCEPTION 'A8B19 post: 20261109340000 unexpectedly present';
  END IF;

  IF (SELECT drivers FROM a8b19_counts) <> (SELECT count(*)::int FROM public.drivers)
     OR (SELECT trips FROM a8b19_counts) <> (SELECT count(*)::int FROM public.trips)
     OR (SELECT ride_offers FROM a8b19_counts) <> (SELECT count(*)::int FROM public.ride_offers)
     OR (SELECT payment_sessions FROM a8b19_counts) <> (SELECT count(*)::int FROM public.payment_sessions)
     OR (SELECT wallet_rows FROM a8b19_counts) <> (SELECT count(*)::int FROM public.driver_wallet_ledger)
     OR (SELECT wallet_signed_sum FROM a8b19_counts) <> (SELECT COALESCE(sum(amount_pence),0)::bigint FROM public.driver_wallet_ledger)
     OR (SELECT cw_rows FROM a8b19_counts) <> (SELECT count(*)::int FROM public.driver_commission_wallet_ledger)
     OR (SELECT notifications FROM a8b19_counts) <> (SELECT count(*)::int FROM public.notifications)
     OR (SELECT driver_presence FROM a8b19_counts) <> (SELECT count(*)::int FROM public.driver_presence)
     OR (SELECT td_sessions FROM a8b19_counts) <> (SELECT count(*)::int FROM public.towards_destination_sessions)
     OR (SELECT push_tokens FROM a8b19_counts) <> (SELECT count(*)::int FROM public.push_tokens)
     OR (SELECT demand_zone_audit_log FROM a8b19_counts) <> (SELECT count(*)::int FROM public.demand_zone_audit_log)
  THEN
    RAISE EXCEPTION 'A8B19 post: integrity drift';
  END IF;
END;
$post$;

SELECT json_build_object(
  'status', 'A8B19_SIM_OK',
  'latest', (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1),
  'has_a8b19', EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109340000'),
  'auth_secdef_after_rollback', (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  'baseline_counts', (SELECT to_jsonb(c) FROM a8b19_counts c),
  'target', (SELECT to_jsonb(e) FROM a8b19_expected e)
) AS sim;

ROLLBACK;
