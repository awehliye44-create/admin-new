-- Phase A8B18 ACL simulation. Privilege/catalog checks only.
-- Does not invoke mutating/operational bodies. Does not print PII.
-- Use BEGIN/ROLLBACK only.

BEGIN;

CREATE TEMP TABLE a8b18_expected (
  name text PRIMARY KEY,
  identity_args text NOT NULL,
  regproc text NOT NULL,
  body_md5 text NOT NULL,
  lang text NOT NULL,
  vol char NOT NULL,
  probe text NOT NULL
);

INSERT INTO a8b18_expected (
  name, identity_args, regproc, body_md5, lang, vol, probe
) VALUES
  (
    'list_driver_trip_history',
    'p_limit integer',
    'public.list_driver_trip_history(integer)',
    'f6d68a4b21c4debde3352290922f6045',
    'plpgsql', 's',
    $p$SELECT public.list_driver_trip_history(1)$p$
  ),
  (
    'create_driver_vehicle',
    'p_driver_id uuid, p_make text, p_model text, p_year integer, p_color text, p_license_plate text',
    'public.create_driver_vehicle(uuid, text, text, integer, text, text)',
    '975936ecd766413f6e582f1b4165843c',
    'plpgsql', 'v',
    $p$SELECT public.create_driver_vehicle('00000000-0000-4000-8000-000000000018'::uuid, 'x', 'y', 2020, 'z', 'ABC')$p$
  ),
  (
    'get_driver_feedback_analytics',
    'p_driver_id uuid',
    'public.get_driver_feedback_analytics(uuid)',
    'eddd9e01ad2db3b2569b23756451daa8',
    'plpgsql', 'v',
    $p$SELECT public.get_driver_feedback_analytics('00000000-0000-4000-8000-000000000018'::uuid)$p$
  ),
  (
    'set_corporate_account_service_area',
    'p_corporate_account_id uuid, p_service_area_id uuid',
    'public.set_corporate_account_service_area(uuid, uuid)',
    '6a046e1bb27c573a6cc18f7e5b395dc9',
    'plpgsql', 'v',
    $p$SELECT public.set_corporate_account_service_area('00000000-0000-4000-8000-000000000018'::uuid, '00000000-0000-4000-8000-000000000019'::uuid)$p$
  ),
  (
    'get_booking_quote_inputs',
    'p_pickup_lat double precision, p_pickup_lng double precision',
    'public.get_booking_quote_inputs(double precision, double precision)',
    'a83d567af63ee8b22fc49dc0763365e3',
    'plpgsql', 's',
    $p$SELECT public.get_booking_quote_inputs(0::double precision, 0::double precision)$p$
  );

DO $pre$
BEGIN
  IF (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1) <> '20261109320000' THEN
    RAISE EXCEPTION 'A8B18 pre: latest migration drift (expected 20261109320000)';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109330000') THEN
    RAISE EXCEPTION 'A8B18 pre: migration already present';
  END IF;
  IF (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) <> 116 THEN
    RAISE EXCEPTION 'A8B18 pre: auth SECDEF <> 116';
  END IF;
  IF (SELECT count(*) FROM a8b18_expected e
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
     ) <> 5 THEN
    RAISE EXCEPTION 'A8B18 pre: hash/args/ACL/overload mismatch';
  END IF;
  -- No SQL parents for selected orphans
  IF EXISTS (
    SELECT 1
    FROM a8b18_expected e
    JOIN pg_proc parent ON parent.pronamespace = 'public'::regnamespace
     AND parent.proname <> e.name
     AND parent.prosrc ~ ('\m' || e.name || '\M')
  ) THEN
    RAISE EXCEPTION 'A8B18 pre: unexpected SQL parent for orphan target';
  END IF;
END;
$pre$;

CREATE TEMP TABLE a8b18_counts AS
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

-- Apply draft ACL (orphan: also revoke service_role)
REVOKE ALL ON FUNCTION public.list_driver_trip_history(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_driver_trip_history(integer) FROM anon;
REVOKE ALL ON FUNCTION public.list_driver_trip_history(integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.list_driver_trip_history(integer) FROM service_role;

REVOKE ALL ON FUNCTION public.create_driver_vehicle(uuid, text, text, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_driver_vehicle(uuid, text, text, integer, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.create_driver_vehicle(uuid, text, text, integer, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.create_driver_vehicle(uuid, text, text, integer, text, text) FROM service_role;

REVOKE ALL ON FUNCTION public.get_driver_feedback_analytics(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_feedback_analytics(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_feedback_analytics(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_driver_feedback_analytics(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.get_booking_quote_inputs(double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_booking_quote_inputs(double precision, double precision) FROM anon;
REVOKE ALL ON FUNCTION public.get_booking_quote_inputs(double precision, double precision) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_booking_quote_inputs(double precision, double precision) FROM service_role;

DO $mid$
DECLARE
  e a8b18_expected%ROWTYPE;
  p oid;
  denied int := 0;
  v_auth_count int;
BEGIN
  IF (SELECT auth_secdef FROM a8b18_counts) <> 116 THEN
    RAISE EXCEPTION 'A8B18 mid: baseline auth SECDEF was not 116';
  END IF;

  FOR e IN SELECT * FROM a8b18_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF p IS NULL THEN RAISE EXCEPTION 'A8B18 mid: missing %', e.name; END IF;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B18 mid: body hash changed for %', e.name;
    END IF;
    IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = p)) <> 'postgres' THEN
      RAISE EXCEPTION 'A8B18 mid: owner changed for %', e.name;
    END IF;
    IF (SELECT l.lanname FROM pg_proc p2 JOIN pg_language l ON l.oid=p2.prolang WHERE p2.oid=p) <> e.lang THEN
      RAISE EXCEPTION 'A8B18 mid: language drift for %', e.name;
    END IF;
    IF (SELECT provolatile FROM pg_proc WHERE oid = p) <> e.vol THEN
      RAISE EXCEPTION 'A8B18 mid: volatility drift for %', e.name;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = p) THEN
      RAISE EXCEPTION 'A8B18 mid: secdef lost for %', e.name;
    END IF;
    IF coalesce(array_to_string((SELECT proconfig FROM pg_proc WHERE oid = p), ','), '') !~* 'search_path=' THEN
      RAISE EXCEPTION 'A8B18 mid: search_path lost for %', e.name;
    END IF;
    IF has_function_privilege('authenticated', p, 'EXECUTE')
       OR has_function_privilege('anon', p, 'EXECUTE')
       OR has_function_privilege('service_role', p, 'EXECUTE')
       OR NOT has_function_privilege('postgres', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B18 mid: ACL not postgres-only for %', e.name;
    END IF;

    PERFORM set_config('role', 'authenticated', true);
    BEGIN
      EXECUTE e.probe;
      RAISE EXCEPTION 'A8B18 mid: expected 42501 for % but succeeded', e.name;
    EXCEPTION
      WHEN insufficient_privilege THEN
        denied := denied + 1;
      WHEN OTHERS THEN
        RAISE EXCEPTION 'A8B18 mid: expected 42501 for % got %:%', e.name, SQLSTATE, SQLERRM;
    END;
    PERFORM set_config('role', 'postgres', true);
  END LOOP;

  IF denied <> 5 THEN
    RAISE EXCEPTION 'A8B18 mid: denied count % (expected 5)', denied;
  END IF;

  SELECT count(*)::int INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> 111 THEN
    RAISE EXCEPTION 'A8B18 mid: auth SECDEF % (expected 111)', v_auth_count;
  END IF;
END;
$mid$;

-- Rollback grants (restore authenticated + service_role only)
GRANT EXECUTE ON FUNCTION public.list_driver_trip_history(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_driver_trip_history(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_driver_vehicle(uuid, text, text, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_driver_vehicle(uuid, text, text, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_feedback_analytics(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_feedback_analytics(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_booking_quote_inputs(double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_booking_quote_inputs(double precision, double precision) TO service_role;

DO $post$
DECLARE
  e a8b18_expected%ROWTYPE;
  p oid;
  v_auth_count int;
BEGIN
  FOR e IN SELECT * FROM a8b18_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B18 post: body hash changed for %', e.name;
    END IF;
    IF NOT has_function_privilege('authenticated', p, 'EXECUTE')
       OR NOT has_function_privilege('service_role', p, 'EXECUTE')
       OR has_function_privilege('anon', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B18 post: ACL restore failed for %', e.name;
    END IF;
  END LOOP;

  SELECT count(*)::int INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> 116 THEN
    RAISE EXCEPTION 'A8B18 post: auth SECDEF % after rollback (expected 116)', v_auth_count;
  END IF;

  IF (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1) <> '20261109320000' THEN
    RAISE EXCEPTION 'A8B18 post: migration history drifted';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109330000') THEN
    RAISE EXCEPTION 'A8B18 post: 20261109330000 unexpectedly present';
  END IF;

  IF (SELECT drivers FROM a8b18_counts) <> (SELECT count(*)::int FROM public.drivers)
     OR (SELECT trips FROM a8b18_counts) <> (SELECT count(*)::int FROM public.trips)
     OR (SELECT ride_offers FROM a8b18_counts) <> (SELECT count(*)::int FROM public.ride_offers)
     OR (SELECT payment_sessions FROM a8b18_counts) <> (SELECT count(*)::int FROM public.payment_sessions)
     OR (SELECT wallet_rows FROM a8b18_counts) <> (SELECT count(*)::int FROM public.driver_wallet_ledger)
     OR (SELECT wallet_signed_sum FROM a8b18_counts) <> (SELECT COALESCE(sum(amount_pence),0)::bigint FROM public.driver_wallet_ledger)
     OR (SELECT cw_rows FROM a8b18_counts) <> (SELECT count(*)::int FROM public.driver_commission_wallet_ledger)
     OR (SELECT notifications FROM a8b18_counts) <> (SELECT count(*)::int FROM public.notifications)
     OR (SELECT driver_presence FROM a8b18_counts) <> (SELECT count(*)::int FROM public.driver_presence)
     OR (SELECT td_sessions FROM a8b18_counts) <> (SELECT count(*)::int FROM public.towards_destination_sessions)
     OR (SELECT push_tokens FROM a8b18_counts) <> (SELECT count(*)::int FROM public.push_tokens)
     OR (SELECT demand_zone_audit_log FROM a8b18_counts) <> (SELECT count(*)::int FROM public.demand_zone_audit_log)
  THEN
    RAISE EXCEPTION 'A8B18 post: integrity drift';
  END IF;
END;
$post$;

SELECT json_build_object(
  'status', 'A8B18_SIM_OK',
  'latest', (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1),
  'has_a8b18', EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109330000'),
  'auth_secdef_after_rollback', (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  'baseline_counts', (SELECT to_jsonb(c) FROM a8b18_counts c),
  'targets', (SELECT json_agg(json_build_object('name', name, 'md5', body_md5, 'regproc', regproc) ORDER BY name) FROM a8b18_expected)
) AS sim;

ROLLBACK;
