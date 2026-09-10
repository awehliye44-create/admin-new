-- Phase A8B17 ACL simulation. Privilege/catalog checks only.
-- Does not invoke mutating/operational bodies. Does not print PII.
-- Use BEGIN/ROLLBACK only.

BEGIN;

CREATE TEMP TABLE a8b17_expected (
  name text PRIMARY KEY,
  identity_args text NOT NULL,
  regproc text NOT NULL,
  body_md5 text NOT NULL,
  classification text NOT NULL,
  keep_authenticated boolean NOT NULL,
  keep_service_role boolean NOT NULL,
  restore_service_role boolean NOT NULL
);

INSERT INTO a8b17_expected (
  name, identity_args, regproc, body_md5, classification,
  keep_authenticated, keep_service_role, restore_service_role
) VALUES
  (
    'log_demand_zone_event',
    '_service_area_id uuid, _zone_id uuid, _action text, _old_value jsonb, _new_value jsonb, _reason text',
    'public.log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text)',
    '981c5d6050a4de8a5c247c0d9ec346ee',
    'EDGE_SERVICE_ONLY',
    false, true, true
  );

DO $pre$
BEGIN
  IF (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1) <> '20261109310000' THEN
    RAISE EXCEPTION 'A8B17 pre: latest migration drift';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109320000') THEN
    RAISE EXCEPTION 'A8B17 pre: migration already present';
  END IF;
  IF (SELECT count(*) FROM a8b17_expected e
      JOIN pg_proc p ON p.proname = e.name
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE md5(p.prosrc) = e.body_md5
        AND pg_get_function_identity_arguments(p.oid) = e.identity_args
        AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND has_function_privilege('postgres', p.oid, 'EXECUTE')) <> 1 THEN
    RAISE EXCEPTION 'A8B17 pre: hash/args/ACL mismatch or missing signature';
  END IF;
  -- No SQL/trigger/RLS/view/cron callers
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname <> 'log_demand_zone_event'
      AND position('log_demand_zone_event(' in lower(p.prosrc)) > 0
  ) THEN
    RAISE EXCEPTION 'A8B17 pre: unexpected SQL parent';
  END IF;
END;
$pre$;

CREATE TEMP TABLE a8b17_counts AS
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
       AND has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_secdef;

-- Apply draft ACL (retain service_role)
REVOKE ALL ON FUNCTION public.log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text) FROM authenticated;

DO $mid$
DECLARE
  e a8b17_expected%ROWTYPE;
  p oid;
  v_auth boolean;
  v_svc boolean;
  v_pg boolean;
  v_auth_count int;
  sentinel uuid := '00000000-0000-4000-8000-000000000017';
  denied int := 0;
  probe text;
BEGIN
  IF (SELECT auth_secdef FROM a8b17_counts) <> 117 THEN
    RAISE EXCEPTION 'A8B17 mid: baseline auth SECDEF was not 117';
  END IF;

  FOR e IN SELECT * FROM a8b17_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF p IS NULL THEN RAISE EXCEPTION 'A8B17 mid: missing %', e.name; END IF;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B17 mid: body hash changed for %', e.name;
    END IF;
    IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = p)) <> 'postgres' THEN
      RAISE EXCEPTION 'A8B17 mid: owner changed for %', e.name;
    END IF;
    IF (SELECT l.lanname FROM pg_proc p2 JOIN pg_language l ON l.oid=p2.prolang WHERE p2.oid=p) <> 'sql' THEN
      RAISE EXCEPTION 'A8B17 mid: language drift for %', e.name;
    END IF;
    IF (SELECT provolatile FROM pg_proc WHERE oid = p) <> 'v' THEN
      RAISE EXCEPTION 'A8B17 mid: volatility drift for %', e.name;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = p) THEN
      RAISE EXCEPTION 'A8B17 mid: SECURITY DEFINER lost for %', e.name;
    END IF;
    IF coalesce(array_to_string((SELECT proconfig FROM pg_proc WHERE oid = p), ','), '') !~* 'search_path=public' THEN
      RAISE EXCEPTION 'A8B17 mid: search_path drift for %', e.name;
    END IF;
    v_auth := has_function_privilege('authenticated', p, 'EXECUTE');
    v_svc := has_function_privilege('service_role', p, 'EXECUTE');
    v_pg := has_function_privilege('postgres', p, 'EXECUTE');
    IF v_auth <> e.keep_authenticated THEN
      RAISE EXCEPTION 'A8B17 mid: authenticated EXECUTE mismatch for %', e.name;
    END IF;
    IF v_svc <> e.keep_service_role THEN
      RAISE EXCEPTION 'A8B17 mid: service_role EXECUTE mismatch for %', e.name;
    END IF;
    IF NOT v_pg THEN
      RAISE EXCEPTION 'A8B17 mid: postgres lost EXECUTE for %', e.name;
    END IF;
  END LOOP;

  -- Authenticated denial probe (42501 before body)
  probe := format(
    'SELECT public.log_demand_zone_event(%L::uuid, %L::uuid, %L, %L::jsonb, %L::jsonb, %L)',
    sentinel, sentinel, 'a8b17_sentinel', '{}', '{}', 'sentinel'
  );
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    EXECUTE probe;
    RAISE EXCEPTION 'A8B17 mid: expected 42501 but call succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      denied := denied + 1;
    WHEN OTHERS THEN
      RAISE EXCEPTION 'A8B17 mid: expected 42501 got %:%', SQLSTATE, SQLERRM;
  END;
  PERFORM set_config('role', 'postgres', true);
  IF denied <> 1 THEN
    RAISE EXCEPTION 'A8B17 mid: denied count %', denied;
  END IF;

  SELECT count(*) INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> (SELECT auth_secdef - 1 FROM a8b17_counts) THEN
    RAISE EXCEPTION 'A8B17 mid: expected auth SECDEF −1 (got % from %)',
      v_auth_count, (SELECT auth_secdef FROM a8b17_counts);
  END IF;
  IF (SELECT anon_secdef FROM a8b17_counts) <> 0 THEN
    RAISE EXCEPTION 'A8B17 mid: anon SECDEF baseline not 0';
  END IF;
END;
$mid$;

-- Restore baseline authenticated grant (service_role was retained)
GRANT EXECUTE ON FUNCTION public.log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text) TO authenticated;

DO $post$
DECLARE
  e a8b17_expected%ROWTYPE;
  p oid;
  v_auth_count int;
BEGIN
  FOR e IN SELECT * FROM a8b17_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF NOT has_function_privilege('authenticated', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B17 post: authenticated not restored for %', e.name;
    END IF;
    IF NOT has_function_privilege('service_role', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B17 post: service_role lost for %', e.name;
    END IF;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B17 post: body hash changed for %', e.name;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> (SELECT auth_secdef FROM a8b17_counts) THEN
    RAISE EXCEPTION 'A8B17 post: auth SECDEF not restored to % (got %)',
      (SELECT auth_secdef FROM a8b17_counts), v_auth_count;
  END IF;

  IF (SELECT count(*)::int FROM public.trips) <> (SELECT trips FROM a8b17_counts)
     OR (SELECT count(*)::int FROM public.ride_offers) <> (SELECT ride_offers FROM a8b17_counts)
     OR (SELECT count(*)::int FROM public.payment_sessions) <> (SELECT payment_sessions FROM a8b17_counts)
     OR (SELECT COALESCE(sum(amount_pence),0)::bigint FROM public.driver_wallet_ledger)
          <> (SELECT wallet_signed_sum FROM a8b17_counts)
     OR (SELECT count(*)::int FROM public.notifications) <> (SELECT notifications FROM a8b17_counts)
     OR (SELECT count(*)::int FROM public.towards_destination_sessions) <> (SELECT td_sessions FROM a8b17_counts)
     OR (SELECT count(*)::int FROM public.driver_presence) <> (SELECT driver_presence FROM a8b17_counts)
     OR (SELECT count(*)::int FROM public.push_tokens) <> (SELECT push_tokens FROM a8b17_counts)
     OR (SELECT count(*)::int FROM public.demand_zone_audit_log) <> (SELECT demand_zone_audit_log FROM a8b17_counts)
  THEN
    RAISE EXCEPTION 'A8B17 post: integrity drift';
  END IF;

  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109320000') THEN
    RAISE EXCEPTION 'A8B17 post: migration unexpectedly present';
  END IF;
END;
$post$;

SELECT jsonb_build_object(
  'status', 'A8B17_SIM_OK',
  'baseline_auth_secdef', (SELECT auth_secdef FROM a8b17_counts),
  'expected_after_apply', (SELECT auth_secdef - 1 FROM a8b17_counts),
  'anon_secdef', (SELECT anon_secdef FROM a8b17_counts),
  'integrity', jsonb_build_object(
    'drivers', (SELECT drivers FROM a8b17_counts),
    'trips', (SELECT trips FROM a8b17_counts),
    'ride_offers', (SELECT ride_offers FROM a8b17_counts),
    'payment_sessions', (SELECT payment_sessions FROM a8b17_counts),
    'wallet_rows', (SELECT wallet_rows FROM a8b17_counts),
    'cw_rows', (SELECT cw_rows FROM a8b17_counts),
    'notifications', (SELECT notifications FROM a8b17_counts),
    'td_sessions', (SELECT td_sessions FROM a8b17_counts),
    'push_tokens', (SELECT push_tokens FROM a8b17_counts),
    'demand_zone_audit_log', (SELECT demand_zone_audit_log FROM a8b17_counts)
  )
) AS sim_result;

ROLLBACK;
