-- Phase A8B16 ACL simulation. Privilege/catalog checks only.
-- Does not invoke mutating/operational bodies. Does not print PII.
-- Use BEGIN/ROLLBACK only.

BEGIN;

CREATE TEMP TABLE a8b16_expected (
  name text PRIMARY KEY,
  identity_args text NOT NULL,
  regproc text NOT NULL,
  body_md5 text NOT NULL,
  classification text NOT NULL,
  keep_authenticated boolean NOT NULL,
  keep_service_role boolean NOT NULL,
  restore_service_role boolean NOT NULL
);

INSERT INTO a8b16_expected (
  name, identity_args, regproc, body_md5, classification,
  keep_authenticated, keep_service_role, restore_service_role
) VALUES
  (
    'raise_driver_alert',
    'p_driver_id uuid, p_alert_type text, p_severity driver_alert_severity, p_message text, p_booking_id uuid, p_context jsonb',
    'public.raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb)',
    '37de48bae4231106a30e32c49fe3dacd',
    'POSTGRES_INTERNAL_ONLY',
    false, false, true
  ),
  (
    'resolve_driver_alert',
    'p_driver_id uuid, p_alert_type text',
    'public.resolve_driver_alert(uuid, text)',
    '648a13b0f8de4e35f836676afe9b21e2',
    'POSTGRES_INTERNAL_ONLY',
    false, false, true
  );

DO $pre$
BEGIN
  IF (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1) <> '20261109300000' THEN
    RAISE EXCEPTION 'A8B16 pre: latest migration drift';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109310000') THEN
    RAISE EXCEPTION 'A8B16 pre: migration already present';
  END IF;
  IF (SELECT count(*) FROM a8b16_expected e
      JOIN pg_proc p ON p.proname = e.name
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE md5(p.prosrc) = e.body_md5
        AND pg_get_function_identity_arguments(p.oid) = e.identity_args
        AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND has_function_privilege('postgres', p.oid, 'EXECUTE')) <> 2 THEN
    RAISE EXCEPTION 'A8B16 pre: hash/args/ACL mismatch or missing signature';
  END IF;
END;
$pre$;

CREATE TEMP TABLE a8b16_counts AS
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
  (SELECT count(*)::int FROM public.driver_alerts) AS driver_alerts,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_secdef;

-- Apply draft ACL
REVOKE ALL ON FUNCTION public.raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb) FROM service_role;

REVOKE ALL ON FUNCTION public.resolve_driver_alert(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_driver_alert(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_driver_alert(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_driver_alert(uuid, text) FROM service_role;

DO $mid$
DECLARE
  e a8b16_expected%ROWTYPE;
  p oid;
  v_auth boolean;
  v_svc boolean;
  v_pg boolean;
  v_auth_count int;
  v_parent oid;
  sentinel uuid := '00000000-0000-4000-8000-000000000016';
  denied int := 0;
  probes text[];
  probe text;
BEGIN
  IF (SELECT auth_secdef FROM a8b16_counts) <> 119 THEN
    RAISE EXCEPTION 'A8B16 mid: baseline auth SECDEF was not 119';
  END IF;

  FOR e IN SELECT * FROM a8b16_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF p IS NULL THEN RAISE EXCEPTION 'A8B16 mid: missing %', e.name; END IF;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B16 mid: body hash changed for %', e.name;
    END IF;
    IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = p)) <> 'postgres' THEN
      RAISE EXCEPTION 'A8B16 mid: owner changed for %', e.name;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = p) THEN
      RAISE EXCEPTION 'A8B16 mid: SECURITY DEFINER lost for %', e.name;
    END IF;
    IF coalesce(array_to_string((SELECT proconfig FROM pg_proc WHERE oid = p), ','), '') !~* 'search_path=public' THEN
      RAISE EXCEPTION 'A8B16 mid: search_path drift for %', e.name;
    END IF;
    v_auth := has_function_privilege('authenticated', p, 'EXECUTE');
    v_svc := has_function_privilege('service_role', p, 'EXECUTE');
    v_pg := has_function_privilege('postgres', p, 'EXECUTE');
    IF v_auth <> e.keep_authenticated THEN
      RAISE EXCEPTION 'A8B16 mid: authenticated EXECUTE mismatch for %', e.name;
    END IF;
    IF v_svc <> e.keep_service_role THEN
      RAISE EXCEPTION 'A8B16 mid: service_role EXECUTE mismatch for %', e.name;
    END IF;
    IF NOT v_pg THEN
      RAISE EXCEPTION 'A8B16 mid: postgres lost EXECUTE for %', e.name;
    END IF;
  END LOOP;

  -- Parent / cron closure (privilege + catalog only; no body invoke)
  SELECT p.oid INTO v_parent FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='detect_driver_problems';
  IF v_parent IS NULL OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_parent)
     OR NOT has_function_privilege('postgres', v_parent, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B16 mid: detect_driver_problems SECDEF/postgres broken';
  END IF;

  SELECT p.oid INTO v_parent FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='record_driver_commitment_warning';
  IF v_parent IS NULL OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_parent)
     OR NOT has_function_privilege('postgres', v_parent, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B16 mid: record_driver_commitment_warning broken';
  END IF;

  SELECT p.oid INTO v_parent FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='stop_driver_commitment_session';
  IF v_parent IS NULL OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_parent)
     OR NOT has_function_privilege('postgres', v_parent, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B16 mid: stop_driver_commitment_session broken';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'detect_driver_problems_60s' AND active
  ) THEN
    RAISE EXCEPTION 'A8B16 mid: detect_driver_problems_60s cron missing/inactive';
  END IF;

  -- Authenticated denial probes (42501 before body)
  probes := ARRAY[
    format(
      'SELECT public.raise_driver_alert(%L::uuid, %L, %L::driver_alert_severity, %L, NULL::uuid, %L::jsonb)',
      sentinel, 'a8b16_sentinel', 'warning', 'sentinel', '{}'
    ),
    format('SELECT public.resolve_driver_alert(%L::uuid, %L)', sentinel, 'a8b16_sentinel')
  ];
  PERFORM set_config('role', 'authenticated', true);
  FOREACH probe IN ARRAY probes LOOP
    BEGIN
      EXECUTE probe;
      RAISE EXCEPTION 'A8B16 mid: expected 42501 but call succeeded: %', probe;
    EXCEPTION
      WHEN insufficient_privilege THEN
        denied := denied + 1;
      WHEN OTHERS THEN
        RAISE EXCEPTION 'A8B16 mid: expected 42501 got %:% for %', SQLSTATE, SQLERRM, probe;
    END;
  END LOOP;
  PERFORM set_config('role', 'postgres', true);
  IF denied <> 2 THEN
    RAISE EXCEPTION 'A8B16 mid: denied count %', denied;
  END IF;

  SELECT count(*) INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> (SELECT auth_secdef - 2 FROM a8b16_counts) THEN
    RAISE EXCEPTION 'A8B16 mid: expected auth SECDEF −2 (got % from %)',
      v_auth_count, (SELECT auth_secdef FROM a8b16_counts);
  END IF;
  IF (SELECT anon_secdef FROM a8b16_counts) <> 0 THEN
    RAISE EXCEPTION 'A8B16 mid: anon SECDEF baseline not 0';
  END IF;
END;
$mid$;

-- Restore baseline grants
GRANT EXECUTE ON FUNCTION public.raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_driver_alert(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_driver_alert(uuid, text) TO service_role;

DO $post$
DECLARE
  e a8b16_expected%ROWTYPE;
  p oid;
  v_auth_count int;
BEGIN
  FOR e IN SELECT * FROM a8b16_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF NOT has_function_privilege('authenticated', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B16 post: authenticated not restored for %', e.name;
    END IF;
    IF has_function_privilege('service_role', p, 'EXECUTE') <> e.restore_service_role THEN
      RAISE EXCEPTION 'A8B16 post: service_role restore mismatch for %', e.name;
    END IF;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B16 post: body hash changed for %', e.name;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> (SELECT auth_secdef FROM a8b16_counts) THEN
    RAISE EXCEPTION 'A8B16 post: auth SECDEF not restored to % (got %)',
      (SELECT auth_secdef FROM a8b16_counts), v_auth_count;
  END IF;

  IF (SELECT count(*)::int FROM public.trips) <> (SELECT trips FROM a8b16_counts)
     OR (SELECT count(*)::int FROM public.ride_offers) <> (SELECT ride_offers FROM a8b16_counts)
     OR (SELECT count(*)::int FROM public.payment_sessions) <> (SELECT payment_sessions FROM a8b16_counts)
     OR (SELECT COALESCE(sum(amount_pence),0)::bigint FROM public.driver_wallet_ledger)
          <> (SELECT wallet_signed_sum FROM a8b16_counts)
     OR (SELECT count(*)::int FROM public.notifications) <> (SELECT notifications FROM a8b16_counts)
     OR (SELECT count(*)::int FROM public.towards_destination_sessions) <> (SELECT td_sessions FROM a8b16_counts)
     OR (SELECT count(*)::int FROM public.driver_presence) <> (SELECT driver_presence FROM a8b16_counts)
     OR (SELECT count(*)::int FROM public.push_tokens) <> (SELECT push_tokens FROM a8b16_counts)
     OR (SELECT count(*)::int FROM public.driver_alerts) <> (SELECT driver_alerts FROM a8b16_counts)
  THEN
    RAISE EXCEPTION 'A8B16 post: integrity drift';
  END IF;

  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109310000') THEN
    RAISE EXCEPTION 'A8B16 post: migration unexpectedly present';
  END IF;
END;
$post$;

SELECT jsonb_build_object(
  'status', 'A8B16_SIM_OK',
  'baseline_auth_secdef', (SELECT auth_secdef FROM a8b16_counts),
  'expected_after_apply', (SELECT auth_secdef - 2 FROM a8b16_counts),
  'anon_secdef', (SELECT anon_secdef FROM a8b16_counts),
  'integrity', jsonb_build_object(
    'drivers', (SELECT drivers FROM a8b16_counts),
    'trips', (SELECT trips FROM a8b16_counts),
    'ride_offers', (SELECT ride_offers FROM a8b16_counts),
    'payment_sessions', (SELECT payment_sessions FROM a8b16_counts),
    'wallet_rows', (SELECT wallet_rows FROM a8b16_counts),
    'cw_rows', (SELECT cw_rows FROM a8b16_counts),
    'notifications', (SELECT notifications FROM a8b16_counts),
    'td_sessions', (SELECT td_sessions FROM a8b16_counts),
    'push_tokens', (SELECT push_tokens FROM a8b16_counts),
    'driver_alerts', (SELECT driver_alerts FROM a8b16_counts)
  )
) AS sim_result;

ROLLBACK;
