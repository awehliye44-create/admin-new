-- Non-committing verification for 20261107150000_phase2c_anon_secdef_execute_revoke_lock.sql
-- ALWAYS ends with ROLLBACK. No Auth/OTP/driver/document/notification side effects.
--
-- NOTE: Do not \i the migration file — it contains COMMIT.
-- Simulate grant body only, then assert role matrix + Edge-path service_role callability.

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

-- ===== Phase 2C grant body (no COMMIT) =====
REVOKE ALL ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_location_options(double precision, double precision, text) TO service_role;

REVOKE ALL ON FUNCTION public.get_driver_signup_service_areas(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_signup_service_areas(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_signup_service_areas(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_signup_service_areas(uuid) TO service_role;

CREATE TEMP TABLE _p2c (
  check_name text PRIMARY KEY,
  ok boolean NOT NULL,
  detail text
);

DO $$
DECLARE
  v_json jsonb;
  v_err text;
  v_region_id uuid;
  v_anon_secdef_count int;
BEGIN
  -- PUBLIC + anon denied
  IF has_function_privilege('public', 'public.get_driver_signup_location_options(double precision, double precision, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_driver_signup_location_options(double precision, double precision, text)', 'EXECUTE') THEN
    INSERT INTO _p2c VALUES ('priv_location_options_public_anon', false, 'PUBLIC or anon still EXECUTE');
  ELSE
    INSERT INTO _p2c VALUES ('priv_location_options_public_anon', true, 'PUBLIC+anon denied');
  END IF;

  IF has_function_privilege('public', 'public.get_driver_signup_service_areas(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_driver_signup_service_areas(uuid)', 'EXECUTE') THEN
    INSERT INTO _p2c VALUES ('priv_service_areas_public_anon', false, 'PUBLIC or anon still EXECUTE');
  ELSE
    INSERT INTO _p2c VALUES ('priv_service_areas_public_anon', true, 'PUBLIC+anon denied');
  END IF;

  -- authenticated denied (no verified post-auth client caller)
  IF has_function_privilege('authenticated', 'public.get_driver_signup_location_options(double precision, double precision, text)', 'EXECUTE') THEN
    INSERT INTO _p2c VALUES ('priv_location_options_authenticated', false, 'authenticated still EXECUTE');
  ELSE
    INSERT INTO _p2c VALUES ('priv_location_options_authenticated', true, 'authenticated denied');
  END IF;
  IF has_function_privilege('authenticated', 'public.get_driver_signup_service_areas(uuid)', 'EXECUTE') THEN
    INSERT INTO _p2c VALUES ('priv_service_areas_authenticated', false, 'authenticated still EXECUTE');
  ELSE
    INSERT INTO _p2c VALUES ('priv_service_areas_authenticated', true, 'authenticated denied');
  END IF;

  -- service_role retained
  IF NOT has_function_privilege('service_role', 'public.get_driver_signup_location_options(double precision, double precision, text)', 'EXECUTE') THEN
    INSERT INTO _p2c VALUES ('priv_location_options_service_role', false, 'missing service_role EXECUTE');
  ELSE
    INSERT INTO _p2c VALUES ('priv_location_options_service_role', true, 'service_role EXECUTE ok');
  END IF;
  IF NOT has_function_privilege('service_role', 'public.get_driver_signup_service_areas(uuid)', 'EXECUTE') THEN
    INSERT INTO _p2c VALUES ('priv_service_areas_service_role', false, 'missing service_role EXECUTE');
  ELSE
    INSERT INTO _p2c VALUES ('priv_service_areas_service_role', true, 'service_role EXECUTE ok');
  END IF;

  -- postgres owner still executable
  IF NOT has_function_privilege('postgres', 'public.get_driver_signup_location_options(double precision, double precision, text)', 'EXECUTE') THEN
    INSERT INTO _p2c VALUES ('priv_location_options_postgres', false, 'postgres lost EXECUTE');
  ELSE
    INSERT INTO _p2c VALUES ('priv_location_options_postgres', true, 'postgres EXECUTE ok');
  END IF;

  -- service_role-equivalent call (session is typically postgres/superuser in verify)
  BEGIN
    SELECT public.get_driver_signup_location_options(NULL, NULL, 'GB') INTO v_json;
    IF v_json IS NULL OR jsonb_typeof(v_json->'regions') <> 'array' THEN
      INSERT INTO _p2c VALUES ('call_location_options', false, 'unexpected payload');
    ELSE
      INSERT INTO _p2c VALUES ('call_location_options', true, 'regions=' || jsonb_array_length(v_json->'regions'));
      IF jsonb_array_length(v_json->'regions') > 0 THEN
        v_region_id := (v_json->'regions'->0->>'id')::uuid;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    INSERT INTO _p2c VALUES ('call_location_options', false, left(v_err, 120));
  END;

  IF v_region_id IS NOT NULL THEN
    BEGIN
      SELECT public.get_driver_signup_service_areas(v_region_id) INTO v_json;
      INSERT INTO _p2c VALUES ('call_service_areas', true, 'ok');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      INSERT INTO _p2c VALUES ('call_service_areas', false, left(v_err, 120));
    END;
  ELSE
    INSERT INTO _p2c VALUES ('call_service_areas', false, 'no region id from location options');
  END IF;

  -- Advisor-equivalent: anon-executable SECURITY DEFINER count should be 0
  SELECT count(*)::int INTO v_anon_secdef_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_anon_secdef_count <> 0 THEN
    INSERT INTO _p2c VALUES ('advisor_anon_secdef_count', false, 'count=' || v_anon_secdef_count);
  ELSE
    INSERT INTO _p2c VALUES ('advisor_anon_secdef_count', true, 'count=0');
  END IF;
END $$;

SELECT check_name, ok, detail FROM _p2c ORDER BY check_name;

-- Fail the script if any check failed (before ROLLBACK)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM _p2c WHERE ok = false) THEN
    RAISE EXCEPTION 'phase2c verify failed: %',
      (SELECT string_agg(check_name || ':' || detail, ', ') FROM _p2c WHERE ok = false);
  END IF;
END $$;

ROLLBACK;
