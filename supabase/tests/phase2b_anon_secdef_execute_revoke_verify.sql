-- Non-committing verification for 20261107140000_phase2b_anon_secdef_execute_revoke_lock.sql
-- ALWAYS ends with ROLLBACK. No Auth/OTP/driver/document/notification side effects.
--
-- NOTE: Do not \i the migration file — it contains COMMIT.

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

-- ===== Phase 2B grant body (no COMMIT) =====
REVOKE ALL ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.admin_decide_customer_identity(uuid, text, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.admin_unlock_customer_name_edit(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unlock_customer_name_edit(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.admin_unlock_customer_name_edit(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.admin_unlock_customer_name_edit(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.finalize_driver_onboarding_registration(text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_driver_onboarding_registration(text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_driver_onboarding_registration(text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.finalize_driver_onboarding_registration(text, text, text, text, text, text, uuid, uuid[], text, text, integer, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.get_customer_identity_verification_gate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_identity_verification_gate(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_customer_identity_verification_gate(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.get_customer_identity_verification_gate(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.sync_current_driver_document_approval() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_current_driver_document_approval() FROM anon;
REVOKE ALL ON FUNCTION public.sync_current_driver_document_approval() FROM service_role;
GRANT EXECUTE ON FUNCTION public.sync_current_driver_document_approval() TO authenticated;

REVOKE ALL ON FUNCTION public.staff_has_company_funds_read_access(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_has_company_funds_read_access(text) FROM anon;
REVOKE ALL ON FUNCTION public.staff_has_company_funds_read_access(text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.staff_has_company_funds_read_access(text) TO authenticated;

REVOKE ALL ON FUNCTION public.drivers_on_auth_detach() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drivers_on_auth_detach() FROM anon;
REVOKE ALL ON FUNCTION public.drivers_on_auth_detach() FROM authenticated;
REVOKE ALL ON FUNCTION public.drivers_on_auth_detach() FROM service_role;

REVOKE ALL ON FUNCTION public.drivers_release_vehicles_on_soft_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drivers_release_vehicles_on_soft_delete() FROM anon;
REVOKE ALL ON FUNCTION public.drivers_release_vehicles_on_soft_delete() FROM authenticated;
REVOKE ALL ON FUNCTION public.drivers_release_vehicles_on_soft_delete() FROM service_role;

REVOKE ALL ON FUNCTION public.enforce_driver_privileged_column_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_driver_privileged_column_guard() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_driver_privileged_column_guard() FROM authenticated;
REVOKE ALL ON FUNCTION public.enforce_driver_privileged_column_guard() FROM service_role;

REVOKE ALL ON FUNCTION public.list_driver_signup_countries() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_driver_signup_countries() FROM anon;
REVOKE ALL ON FUNCTION public.list_driver_signup_countries() FROM authenticated;
REVOKE ALL ON FUNCTION public.list_driver_signup_countries() FROM service_role;

REVOKE ALL ON FUNCTION public.list_enabled_otp_country_codes() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_enabled_otp_country_codes() FROM anon;
REVOKE ALL ON FUNCTION public.list_enabled_otp_country_codes() FROM authenticated;
REVOKE ALL ON FUNCTION public.list_enabled_otp_country_codes() FROM service_role;

REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) TO authenticated;

CREATE TEMP TABLE _p2b (
  check_name text PRIMARY KEY,
  ok boolean NOT NULL,
  detail text
);

DO $$
DECLARE
  v_json jsonb;
  v_bool boolean;
  v_err text;
  r record;
BEGIN
  -- Locked 12: PUBLIC + anon must not EXECUTE
  FOR r IN
    SELECT * FROM (VALUES
      ('admin_decide_customer_identity(uuid,text,text,text,text)'),
      ('admin_unlock_customer_name_edit(uuid)'),
      ('finalize_driver_onboarding_registration(text,text,text,text,text,text,uuid,uuid[],text,text,integer,text,text,text)'),
      ('get_customer_identity_verification_gate(uuid)'),
      ('staff_has_company_funds_read_access(text)'),
      ('sync_current_driver_document_approval()'),
      ('drivers_on_auth_detach()'),
      ('drivers_release_vehicles_on_soft_delete()'),
      ('enforce_driver_privileged_column_guard()'),
      ('list_driver_signup_countries()'),
      ('list_enabled_otp_country_codes()'),
      ('validate_driver_signup_region_service_areas(uuid,uuid[])')
    ) AS t(sig)
  LOOP
    IF has_function_privilege('public', ('public.' || r.sig)::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', ('public.' || r.sig)::regprocedure, 'EXECUTE') THEN
      INSERT INTO _p2b VALUES ('priv_' || r.sig, false, 'PUBLIC or anon still EXECUTE');
    ELSE
      INSERT INTO _p2b VALUES ('priv_' || left(r.sig, 50), true, 'PUBLIC+anon denied');
    END IF;
  END LOOP;

  -- Blockers: anon must STILL execute (not touched)
  IF NOT has_function_privilege('anon', 'public.get_driver_signup_location_options(double precision, double precision, text)', 'EXECUTE') THEN
    INSERT INTO _p2b VALUES ('blocker_location_options_anon', false, 'anon lost EXECUTE — unexpected');
  ELSE
    INSERT INTO _p2b VALUES ('blocker_location_options_anon', true, 'anon still EXECUTE (intentional)');
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_driver_signup_service_areas(uuid)', 'EXECUTE') THEN
    INSERT INTO _p2b VALUES ('blocker_service_areas_anon', false, 'anon lost EXECUTE — unexpected');
  ELSE
    INSERT INTO _p2b VALUES ('blocker_service_areas_anon', true, 'anon still EXECUTE (intentional)');
  END IF;

  -- authenticated retained where required
  IF NOT has_function_privilege('authenticated', 'public.admin_decide_customer_identity(uuid,text,text,text,text)', 'EXECUTE') THEN
    INSERT INTO _p2b VALUES ('auth_admin_decide', false, 'missing');
  ELSE
    INSERT INTO _p2b VALUES ('auth_admin_decide', true, 'ok');
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.finalize_driver_onboarding_registration(text,text,text,text,text,text,uuid,uuid[],text,text,integer,text,text,text)', 'EXECUTE') THEN
    INSERT INTO _p2b VALUES ('auth_finalize', false, 'missing');
  ELSE
    INSERT INTO _p2b VALUES ('auth_finalize', true, 'ok');
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_customer_identity_verification_gate(uuid)', 'EXECUTE') THEN
    INSERT INTO _p2b VALUES ('auth_gate', false, 'missing');
  ELSE
    INSERT INTO _p2b VALUES ('auth_gate', true, 'ok');
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.sync_current_driver_document_approval()', 'EXECUTE') THEN
    INSERT INTO _p2b VALUES ('auth_sync_docs', false, 'missing');
  ELSE
    INSERT INTO _p2b VALUES ('auth_sync_docs', true, 'ok');
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.staff_has_company_funds_read_access(text)', 'EXECUTE') THEN
    INSERT INTO _p2b VALUES ('auth_staff_funds', false, 'missing');
  ELSE
    INSERT INTO _p2b VALUES ('auth_staff_funds', true, 'ok');
  END IF;

  -- Triggers still attached
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_drivers_on_auth_detach' AND NOT tgisinternal) THEN
    INSERT INTO _p2b VALUES ('trg_auth_detach', false, 'missing');
  ELSE
    INSERT INTO _p2b VALUES ('trg_auth_detach', true, 'present');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_drivers_release_vehicles_on_soft_delete' AND NOT tgisinternal) THEN
    INSERT INTO _p2b VALUES ('trg_release_vehicles', false, 'missing');
  ELSE
    INSERT INTO _p2b VALUES ('trg_release_vehicles', true, 'present');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_drivers_privileged_column_guard' AND NOT tgisinternal) THEN
    INSERT INTO _p2b VALUES ('trg_priv_guard', false, 'missing');
  ELSE
    INSERT INTO _p2b VALUES ('trg_priv_guard', true, 'present');
  END IF;

  -- anon runtime denied on locked admin/post-auth
  BEGIN
    SET LOCAL ROLE anon;
    SELECT public.admin_decide_customer_identity(
      '00000000-0000-0000-0000-000000000001'::uuid, 'approved', NULL, NULL, 'p2b'
    ) INTO v_json;
    RESET ROLE;
    INSERT INTO _p2b VALUES ('anon_admin_decide_denied', false, 'UNEXPECTED ' || coalesce(v_json::text,'null'));
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    INSERT INTO _p2b VALUES ('anon_admin_decide_denied', true, '42501');
  WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RESET ROLE;
    INSERT INTO _p2b VALUES ('anon_admin_decide_denied', SQLSTATE = '42501', SQLSTATE || ':' || v_err);
  END;

  BEGIN
    SET LOCAL ROLE anon;
    SELECT public.finalize_driver_onboarding_registration(
      'A','B','addr','PC','City','GB',
      '00000000-0000-0000-0000-000000000001'::uuid,
      ARRAY['00000000-0000-0000-0000-000000000002'::uuid],
      'Make','Model',2020,'Red','AB12CDE','v1'
    ) INTO v_json;
    RESET ROLE;
    INSERT INTO _p2b VALUES ('anon_finalize_denied', false, 'UNEXPECTED');
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    INSERT INTO _p2b VALUES ('anon_finalize_denied', true, '42501');
  WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RESET ROLE;
    INSERT INTO _p2b VALUES ('anon_finalize_denied', SQLSTATE = '42501', SQLSTATE || ':' || v_err);
  END;

  -- authenticated without admin: fail-closed (not privilege — app authz)
  BEGIN
    SET LOCAL ROLE authenticated;
    SELECT public.admin_decide_customer_identity(
      '00000000-0000-0000-0000-000000000001'::uuid, 'approved', NULL, NULL, 'p2b'
    ) INTO v_json;
    RESET ROLE;
    INSERT INTO _p2b VALUES ('auth_nonadmin_decide', false, 'UNEXPECTED SUCCESS');
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    INSERT INTO _p2b VALUES ('auth_nonadmin_decide', true, '42501 not authorized');
  WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RESET ROLE;
    INSERT INTO _p2b VALUES ('auth_nonadmin_decide', SQLSTATE = '42501' OR v_err ILIKE '%not authorized%', SQLSTATE || ':' || v_err);
  END;

  -- authenticated gate: UNAUTHENTICATED JSON (no jwt claims) — privilege OK
  BEGIN
    SET LOCAL ROLE authenticated;
    SELECT public.get_customer_identity_verification_gate(NULL) INTO v_json;
    RESET ROLE;
    INSERT INTO _p2b VALUES (
      'auth_gate_unauthenticated_shape',
      (v_json->>'code') = 'UNAUTHENTICATED',
      left(coalesce(v_json::text,'null'), 200)
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RESET ROLE;
    INSERT INTO _p2b VALUES ('auth_gate_unauthenticated_shape', false, SQLSTATE || ':' || v_err);
  END;

  -- staff helper as authenticated without uid → false
  BEGIN
    SET LOCAL ROLE authenticated;
    SELECT public.staff_has_company_funds_read_access('payout-ledger') INTO v_bool;
    RESET ROLE;
    INSERT INTO _p2b VALUES ('auth_staff_false', v_bool IS FALSE, 'result=' || v_bool::text);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RESET ROLE;
    INSERT INTO _p2b VALUES ('auth_staff_false', false, SQLSTATE || ':' || v_err);
  END;

  -- anon still can call blocker catalogues (no data mutation)
  BEGIN
    SET LOCAL ROLE anon;
    SELECT public.get_driver_signup_location_options(NULL, NULL, 'GB') INTO v_json;
    RESET ROLE;
    INSERT INTO _p2b VALUES (
      'anon_blocker_location_call',
      v_json ? 'regions',
      left(coalesce(v_json::text,'null'), 120)
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RESET ROLE;
    INSERT INTO _p2b VALUES ('anon_blocker_location_call', false, SQLSTATE || ':' || v_err);
  END;
END $$;

SELECT * FROM _p2b ORDER BY check_name;
SELECT CASE WHEN bool_and(ok) THEN 'PHASE2B_VERIFY_OK' ELSE 'PHASE2B_VERIFY_FAIL' END AS verdict
FROM _p2b;

ROLLBACK;
SELECT 'PHASE2B_VERIFY_ROLLED_BACK' AS status;
