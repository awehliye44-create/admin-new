-- Phase A8B8 ACL simulation. Privilege/catalog checks only.
-- Does not invoke mutating bodies. Does not print PII.

BEGIN;

CREATE TEMP TABLE a8b8_expected (
  name text PRIMARY KEY,
  identity_args text NOT NULL,
  regproc text NOT NULL,
  body_md5 text NOT NULL,
  keep_authenticated boolean NOT NULL,
  keep_service_role boolean NOT NULL
);

INSERT INTO a8b8_expected (name, identity_args, regproc, body_md5, keep_authenticated, keep_service_role) VALUES
  ('admin_user_directory', '', 'public.admin_user_directory()', 'ba37343c189c21d6c4d902d60cad8282', true, true),
  ('adjust_merchant_credits', '_merchant_id uuid, _delta integer, _notes text', 'public.adjust_merchant_credits(uuid, integer, text)', '32cfb21497afe0fa7c6f22b7c181ce96', false, false),
  ('approve_merchant_with_credits', '_merchant_id uuid, _admin_notes text', 'public.approve_merchant_with_credits(uuid, text)', '906a8505878a8871e6a7711c47e0980b', false, false),
  ('get_driver_wallet_balance', 'p_driver_id uuid', 'public.get_driver_wallet_balance(uuid)', '12f11da8c01d0b64b3c517ebe965e363', false, false),
  ('ops_retry_failed_payout', 'p_payout_id uuid', 'public.ops_retry_failed_payout(uuid)', '817dfb0ebb4321af2ecba73fc11b8be4', false, true),
  ('check_driver_documents_approved', 'p_driver_id uuid', 'public.check_driver_documents_approved(uuid)', 'b028018a57c8acfca1b6e1f59e7fc2c5', false, true),
  ('reject_roles_action', '_event_type text, _reason text, _details jsonb', 'public.reject_roles_action(text, text, jsonb)', '4e95174d7597995f8da85b2640191351', false, false),
  ('log_roles_audit', '_event_type text, _details jsonb', 'public.log_roles_audit(text, jsonb)', '5bb207836420031322a83af08692bf54', false, false),
  ('accept_ride_offer_eligibility_guard', 'p_driver_id uuid', 'public.accept_ride_offer_eligibility_guard(uuid)', 'ac499859d589358f39ad28312a951c65', false, false),
  ('dispatchable_reason', 'p_driver_id uuid, p_max_heartbeat_age_seconds integer, p_require_push_token boolean, p_max_location_age_seconds integer', 'public.dispatchable_reason(uuid, integer, boolean, integer)', '5ab192f82e01e6fe9dcd3f583a7a2dc7', false, false);

DO $pre$
BEGIN
  IF (SELECT count(*) FROM a8b8_expected e
      JOIN pg_proc p ON p.proname = e.name
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE md5(p.prosrc) = e.body_md5
        AND pg_get_function_identity_arguments(p.oid) = e.identity_args) <> 10 THEN
    RAISE EXCEPTION 'A8B8 pre: hash/args mismatch or missing signature';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109200000') THEN
    RAISE EXCEPTION 'A8B8 pre: migration already applied';
  END IF;
END;
$pre$;

CREATE TEMP TABLE a8b8_counts AS
SELECT
  (SELECT count(*)::int FROM public.staff_profiles) AS staff_profiles,
  (SELECT count(*)::int FROM public.user_roles) AS user_roles,
  (SELECT count(*)::int FROM auth.users) AS auth_users,
  (SELECT count(*)::int FROM public.customers) AS customers,
  (SELECT count(*)::int FROM public.drivers) AS drivers,
  (SELECT count(*)::int FROM public.corporate_accounts) AS corporate_accounts,
  (SELECT count(*)::int FROM public.corporate_users) AS corporate_users,
  (SELECT count(*)::int FROM public.trips) AS trips,
  (SELECT count(*)::int FROM public.ride_offers) AS ride_offers,
  (SELECT count(*)::int FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*)::int FROM public.payout_items) AS payout_items,
  (SELECT count(*)::int FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT COALESCE(sum(amount_pence),0)::bigint FROM public.driver_wallet_ledger) AS wallet_signed_sum,
  (SELECT count(*)::int FROM public.notifications) AS notifications,
  (SELECT count(*)::int FROM public.booking_delivery_log) AS booking_delivery_log,
  (SELECT count(*)::int FROM public.merchant_ai_credits) AS merchant_credits,
  (SELECT count(*)::int FROM public.merchants) AS merchants,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_secdef;

-- Apply draft ACL (mirrors forward migration)
REVOKE ALL ON FUNCTION public.admin_user_directory() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_user_directory() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_user_directory() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_directory() TO service_role;

REVOKE ALL ON FUNCTION public.adjust_merchant_credits(uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.adjust_merchant_credits(uuid, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.adjust_merchant_credits(uuid, integer, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.adjust_merchant_credits(uuid, integer, text) FROM service_role;

REVOKE ALL ON FUNCTION public.approve_merchant_with_credits(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_merchant_with_credits(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.approve_merchant_with_credits(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.approve_merchant_with_credits(uuid, text) FROM service_role;

REVOKE ALL ON FUNCTION public.get_driver_wallet_balance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_wallet_balance(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_wallet_balance(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_driver_wallet_balance(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.ops_retry_failed_payout(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_retry_failed_payout(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ops_retry_failed_payout(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ops_retry_failed_payout(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.check_driver_documents_approved(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_driver_documents_approved(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.check_driver_documents_approved(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_driver_documents_approved(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.reject_roles_action(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_roles_action(text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.reject_roles_action(text, text, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.reject_roles_action(text, text, jsonb) FROM service_role;

REVOKE ALL ON FUNCTION public.log_roles_audit(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_roles_audit(text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.log_roles_audit(text, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.log_roles_audit(text, jsonb) FROM service_role;

REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.dispatchable_reason(uuid, integer, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatchable_reason(uuid, integer, boolean, integer) FROM anon;
REVOKE ALL ON FUNCTION public.dispatchable_reason(uuid, integer, boolean, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.dispatchable_reason(uuid, integer, boolean, integer) FROM service_role;

DO $post$
DECLARE
  r record;
  v_auth int;
  v_anon int;
BEGIN
  FOR r IN SELECT * FROM a8b8_expected LOOP
    IF has_function_privilege('anon', r.regproc::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B8 post: anon still has EXECUTE on %', r.name;
    END IF;
    IF r.keep_authenticated THEN
      IF NOT has_function_privilege('authenticated', r.regproc::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION 'A8B8 post: authenticated missing on %', r.name;
      END IF;
    ELSE
      IF has_function_privilege('authenticated', r.regproc::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION 'A8B8 post: authenticated still has EXECUTE on %', r.name;
      END IF;
    END IF;
    IF r.keep_service_role THEN
      IF NOT has_function_privilege('service_role', r.regproc::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION 'A8B8 post: service_role missing on %', r.name;
      END IF;
    ELSE
      IF has_function_privilege('service_role', r.regproc::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION 'A8B8 post: service_role still has EXECUTE on %', r.name;
      END IF;
    END IF;
    IF NOT has_function_privilege('postgres', r.regproc::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B8 post: postgres missing EXECUTE on %', r.name;
    END IF;
    IF md5((
      SELECT p.prosrc FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE p.proname = r.name
        AND pg_get_function_identity_arguments(p.oid) = r.identity_args
    )) IS DISTINCT FROM r.body_md5 THEN
      RAISE EXCEPTION 'A8B8 post: body hash changed for %', r.name;
    END IF;
  END LOOP;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth <> 168 THEN
    RAISE EXCEPTION 'A8B8 post: expected auth SECDEF 168, got %', v_auth;
  END IF;

  SELECT count(*)::int INTO v_anon
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_anon <> 0 THEN
    RAISE EXCEPTION 'A8B8 post: expected anon SECDEF 0, got %', v_anon;
  END IF;
END;
$post$;

-- Anon denial before body (admin_user_directory)
DO $denial$
BEGIN
  PERFORM set_config('role', 'anon', true);
  BEGIN
    PERFORM 1 FROM public.admin_user_directory();
    RAISE EXCEPTION 'A8B8 denial: anon unexpectedly executed admin_user_directory';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  PERFORM set_config('role', 'postgres', true);
END;
$denial$;

-- Authenticated denial for revoked targets (sentinel args; privilege only)
DO $authden$
DECLARE
  sid uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  BEGIN
    PERFORM public.adjust_merchant_credits(sid, 0, 'sentinel');
    RAISE EXCEPTION 'expected 42501 adjust_merchant_credits';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.ops_retry_failed_payout(sid);
    RAISE EXCEPTION 'expected 42501 ops_retry_failed_payout';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.check_driver_documents_approved(sid);
    RAISE EXCEPTION 'expected 42501 check_driver_documents_approved';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM public.reject_roles_action('sentinel', 'sentinel', '{}'::jsonb);
    RAISE EXCEPTION 'expected 42501 reject_roles_action';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('role', 'postgres', true);
END;
$authden$;

-- Retained Admin shape check: authenticated EXECUTE remains; no row dump
DO $adminshape$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.admin_user_directory()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'admin_user_directory authenticated EXECUTE missing';
  END IF;
  IF NOT (
    SELECT prosrc ~* 'staff_has_page_access\(''user-directory''\)'
       AND prosrc ~* 'is_super_admin\(auth\.uid\(\)\)'
       AND prosrc ~* 'has_role\(auth\.uid\(\),\s*''admin'''
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
    WHERE proname='admin_user_directory'
  ) THEN
    RAISE EXCEPTION 'admin_user_directory authz gates drifted';
  END IF;
END;
$adminshape$;

DO $integrity$
DECLARE c a8b8_counts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM a8b8_counts;
  IF c.staff_profiles IS DISTINCT FROM (SELECT count(*)::int FROM public.staff_profiles)
     OR c.user_roles IS DISTINCT FROM (SELECT count(*)::int FROM public.user_roles)
     OR c.auth_users IS DISTINCT FROM (SELECT count(*)::int FROM auth.users)
     OR c.customers IS DISTINCT FROM (SELECT count(*)::int FROM public.customers)
     OR c.drivers IS DISTINCT FROM (SELECT count(*)::int FROM public.drivers)
     OR c.corporate_accounts IS DISTINCT FROM (SELECT count(*)::int FROM public.corporate_accounts)
     OR c.corporate_users IS DISTINCT FROM (SELECT count(*)::int FROM public.corporate_users)
     OR c.trips IS DISTINCT FROM (SELECT count(*)::int FROM public.trips)
     OR c.ride_offers IS DISTINCT FROM (SELECT count(*)::int FROM public.ride_offers)
     OR c.payment_sessions IS DISTINCT FROM (SELECT count(*)::int FROM public.payment_sessions)
     OR c.payout_items IS DISTINCT FROM (SELECT count(*)::int FROM public.payout_items)
     OR c.wallet_rows IS DISTINCT FROM (SELECT count(*)::int FROM public.driver_wallet_ledger)
     OR c.wallet_signed_sum IS DISTINCT FROM (SELECT COALESCE(sum(amount_pence),0)::bigint FROM public.driver_wallet_ledger)
     OR c.notifications IS DISTINCT FROM (SELECT count(*)::int FROM public.notifications)
     OR c.booking_delivery_log IS DISTINCT FROM (SELECT count(*)::int FROM public.booking_delivery_log)
     OR c.merchant_credits IS DISTINCT FROM (SELECT count(*)::int FROM public.merchant_ai_credits)
     OR c.merchants IS DISTINCT FROM (SELECT count(*)::int FROM public.merchants)
  THEN
    RAISE EXCEPTION 'A8B8 integrity drift during ACL simulation';
  END IF;
END;
$integrity$;

-- Restore pre-A8B8 production grants (including anon on directory — simulation only)
GRANT EXECUTE ON FUNCTION public.admin_user_directory() TO anon;
GRANT EXECUTE ON FUNCTION public.admin_user_directory() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_directory() TO service_role;

GRANT EXECUTE ON FUNCTION public.adjust_merchant_credits(uuid, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_merchant_credits(uuid, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_merchant_with_credits(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_merchant_with_credits(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_wallet_balance(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_wallet_balance(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ops_retry_failed_payout(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_retry_failed_payout(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.check_driver_documents_approved(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_driver_documents_approved(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_roles_action(text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject_roles_action(text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.log_roles_audit(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_roles_audit(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.dispatchable_reason(uuid, integer, boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispatchable_reason(uuid, integer, boolean, integer) TO service_role;

DO $restored$
DECLARE v_auth int; v_anon int;
BEGIN
  IF NOT has_function_privilege('anon', 'public.admin_user_directory()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B8 restore: anon missing on admin_user_directory (sim restore)';
  END IF;
  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth <> 177 THEN
    RAISE EXCEPTION 'A8B8 restore: expected auth SECDEF 177, got %', v_auth;
  END IF;
  SELECT count(*)::int INTO v_anon
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_anon <> 1 THEN
    RAISE EXCEPTION 'A8B8 restore: expected anon SECDEF 1, got %', v_anon;
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109200000') THEN
    RAISE EXCEPTION 'A8B8 restore: migration version unexpectedly present';
  END IF;
END;
$restored$;

SELECT 'A8B8_SIMULATION_OK' AS status,
       (SELECT auth_secdef FROM a8b8_counts) AS auth_secdef_before,
       168 AS auth_secdef_after_apply,
       (SELECT anon_secdef FROM a8b8_counts) AS anon_secdef_before,
       0 AS anon_secdef_after_apply,
       177 AS auth_secdef_after_restore,
       1 AS anon_secdef_after_restore;

ROLLBACK;
