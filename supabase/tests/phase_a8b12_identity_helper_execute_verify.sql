-- Phase A8B12 ACL simulation. Privilege/catalog checks only.
-- Does not invoke mutating bodies. Does not print PII.
-- Use BEGIN/ROLLBACK only.

BEGIN;

CREATE TEMP TABLE a8b12_expected (
  name text PRIMARY KEY,
  identity_args text NOT NULL,
  regproc text NOT NULL,
  body_md5 text NOT NULL,
  keep_authenticated boolean NOT NULL,
  keep_service_role boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO a8b12_expected (name, identity_args, regproc, body_md5, keep_authenticated, keep_service_role) VALUES
  ('check_email_available_for_change', '_email text, _user_id uuid', 'public.check_email_available_for_change(text, uuid)', '53c43680a0de136e06465cf57fcd44db', false, true),
  ('check_phone_available_for_change', 'p_user_id uuid, p_phone text, p_app_type text', 'public.check_phone_available_for_change(uuid, text, text)', 'c36618f4a0f388bf546a3caefe1bf298', false, true),
  ('staff_has_action', '_user_id uuid, _action_key text', 'public.staff_has_action(uuid, text)', 'ce3e87aaa7dbef84988f4de3f381a719', false, true),
  ('phone_is_pending_reserved', 'p_phone_digits text, p_exclude_user_id uuid', 'public.phone_is_pending_reserved(text, uuid)', 'ded86cd02509fb53bb93246974fd66de', false, false),
  ('phone_is_verified_protected', 'p_phone_digits text, p_exclude_user_id uuid', 'public.phone_is_verified_protected(text, uuid)', 'a47afb82d2678526ec24008e3b566fac', false, false),
  ('haversine_meters', 'lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision', 'public.haversine_meters(double precision, double precision, double precision, double precision)', 'f7d37be23bf08b93628d672f22663ad7', false, false),
  ('dispatch_max_driver_find_minutes', 'p_service_area_id uuid', 'public.dispatch_max_driver_find_minutes(uuid)', '80f4de26597e7d9b725d88068168fa7a', false, false),
  ('log_driver_availability_event', 'p_driver_id uuid, p_event_type text, p_reason text, p_from_intent boolean, p_to_intent boolean, p_from_is_online boolean, p_to_is_online boolean, p_metadata jsonb, p_actor_role text', 'public.log_driver_availability_event(uuid, text, text, boolean, boolean, boolean, boolean, jsonb, text)', '11ab19134c3753e15355cbf52e6bbe96', false, false),
  ('assert_driver_presence_online_eligible', 'p_driver_id uuid', 'public.assert_driver_presence_online_eligible(uuid)', '04fa4657ebaabb08623679496ff0652c', false, false),
  ('recalculate_driver_documents_approved', 'p_driver_id uuid', 'public.recalculate_driver_documents_approved(uuid)', '9a6135c95ac40ac3d8e56e7c6cf78667', false, false);

CREATE TEMP TABLE a8b12_integrity (
  label text PRIMARY KEY,
  auth_secdef int NOT NULL,
  staff_profiles int NOT NULL,
  user_roles int NOT NULL,
  role_page_permissions int NOT NULL,
  role_action_permissions int NOT NULL,
  auth_users int NOT NULL,
  auth_identities int NOT NULL,
  customers int NOT NULL,
  drivers int NOT NULL,
  corporate_accounts int NOT NULL,
  corporate_requests int NOT NULL,
  trips int NOT NULL,
  ride_offers int NOT NULL,
  payment_sessions int NOT NULL,
  notifications int NOT NULL,
  booking_delivery_log int NOT NULL,
  wallet_rows int NOT NULL,
  wallet_sum bigint NOT NULL
) ON COMMIT DROP;

INSERT INTO a8b12_integrity
SELECT
  'before',
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  (SELECT count(*)::int FROM public.staff_profiles),
  (SELECT count(*)::int FROM public.user_roles),
  (SELECT count(*)::int FROM public.role_page_permissions),
  (SELECT count(*)::int FROM public.role_action_permissions),
  (SELECT count(*)::int FROM auth.users),
  (SELECT count(*)::int FROM auth.identities),
  (SELECT count(*)::int FROM public.customers),
  (SELECT count(*)::int FROM public.drivers),
  (SELECT count(*)::int FROM public.corporate_accounts),
  (SELECT count(*)::int FROM public.corporate_account_requests),
  (SELECT count(*)::int FROM public.trips),
  (SELECT count(*)::int FROM public.ride_offers),
  (SELECT count(*)::int FROM public.payment_sessions),
  (SELECT count(*)::int FROM public.notifications),
  (SELECT count(*)::int FROM public.booking_delivery_log),
  (SELECT count(*)::int FROM public.driver_wallet_ledger),
  (SELECT COALESCE(SUM(amount_pence),0)::bigint FROM public.driver_wallet_ledger);

-- Apply draft ACL (same as migration body)
REVOKE ALL ON FUNCTION public.check_email_available_for_change(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_email_available_for_change(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.check_email_available_for_change(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_email_available_for_change(text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.check_phone_available_for_change(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_phone_available_for_change(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.check_phone_available_for_change(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_phone_available_for_change(uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.staff_has_action(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_has_action(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.staff_has_action(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.staff_has_action(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.phone_is_pending_reserved(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.phone_is_pending_reserved(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.phone_is_pending_reserved(text, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.phone_is_pending_reserved(text, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.phone_is_verified_protected(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.phone_is_verified_protected(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.phone_is_verified_protected(text, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.phone_is_verified_protected(text, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.haversine_meters(double precision, double precision, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.haversine_meters(double precision, double precision, double precision, double precision) FROM anon;
REVOKE ALL ON FUNCTION public.haversine_meters(double precision, double precision, double precision, double precision) FROM authenticated;
REVOKE ALL ON FUNCTION public.haversine_meters(double precision, double precision, double precision, double precision) FROM service_role;

REVOKE ALL ON FUNCTION public.dispatch_max_driver_find_minutes(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_max_driver_find_minutes(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.dispatch_max_driver_find_minutes(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.dispatch_max_driver_find_minutes(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.log_driver_availability_event(uuid, text, text, boolean, boolean, boolean, boolean, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_driver_availability_event(uuid, text, text, boolean, boolean, boolean, boolean, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.log_driver_availability_event(uuid, text, text, boolean, boolean, boolean, boolean, jsonb, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.log_driver_availability_event(uuid, text, text, boolean, boolean, boolean, boolean, jsonb, text) FROM service_role;

REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.recalculate_driver_documents_approved(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_driver_documents_approved(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.recalculate_driver_documents_approved(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.recalculate_driver_documents_approved(uuid) FROM service_role;

DO $$
DECLARE
  r a8b12_expected%ROWTYPE;
  v_md5 text;
  v_auth boolean;
  v_svc boolean;
  v_anon boolean;
  v_public boolean;
  v_pg boolean;
  v_err text;
  v_state text;
  sid uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
  FOR r IN SELECT * FROM a8b12_expected ORDER BY name LOOP
    SELECT md5(p.prosrc),
           has_function_privilege('authenticated', p.oid, 'EXECUTE'),
           has_function_privilege('service_role', p.oid, 'EXECUTE'),
           has_function_privilege('anon', p.oid, 'EXECUTE'),
           has_function_privilege('public', p.oid, 'EXECUTE'),
           has_function_privilege('postgres', p.oid, 'EXECUTE')
    INTO v_md5, v_auth, v_svc, v_anon, v_public, v_pg
    FROM pg_proc p
    WHERE p.oid = r.regproc::regprocedure;

    IF v_md5 IS DISTINCT FROM r.body_md5 THEN
      RAISE EXCEPTION 'body hash drift for %: % vs %', r.name, v_md5, r.body_md5;
    END IF;
    IF v_public OR v_anon THEN
      RAISE EXCEPTION '% still executable by public/anon', r.name;
    END IF;
    IF v_auth IS DISTINCT FROM r.keep_authenticated THEN
      RAISE EXCEPTION '% authenticated EXECUTE % expected %', r.name, v_auth, r.keep_authenticated;
    END IF;
    IF v_svc IS DISTINCT FROM r.keep_service_role THEN
      RAISE EXCEPTION '% service_role EXECUTE % expected %', r.name, v_svc, r.keep_service_role;
    END IF;
    IF NOT v_pg THEN
      RAISE EXCEPTION '% lost postgres EXECUTE', r.name;
    END IF;
  END LOOP;

  -- Authenticated denial probes (privilege only; fail before body)
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.check_email_available_for_change('probe@example.invalid', sid);
    RESET ROLE;
    RAISE EXCEPTION 'authenticated executed check_email_available_for_change';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'check_email unexpected: % %', v_state, v_err;
      END IF;
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.staff_has_action(sid, 'roles_permissions.create_role');
    RESET ROLE;
    RAISE EXCEPTION 'authenticated executed staff_has_action';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'staff_has_action unexpected: % %', v_state, v_err;
      END IF;
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.haversine_meters(0,0,0,0);
    RESET ROLE;
    RAISE EXCEPTION 'authenticated executed haversine_meters';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'haversine unexpected: % %', v_state, v_err;
      END IF;
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.phone_is_verified_protected('07000000000', sid);
    RESET ROLE;
    RAISE EXCEPTION 'authenticated executed phone_is_verified_protected';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'phone_is_verified unexpected: % %', v_state, v_err;
      END IF;
  END;

  -- Mounted staff / corporate paths must remain authenticated
  IF has_function_privilege('authenticated', 'public.admin_create_staff_member(uuid, text, text, staff_role, uuid[], text)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('authenticated', 'public.approve_corporate_request(uuid, uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('authenticated', 'public.suspend_corporate_request(uuid, uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
  THEN
    RAISE EXCEPTION 'mounted Admin RPC EXECUTE drifted';
  END IF;
END $$;

INSERT INTO a8b12_integrity
SELECT
  'after',
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  (SELECT count(*)::int FROM public.staff_profiles),
  (SELECT count(*)::int FROM public.user_roles),
  (SELECT count(*)::int FROM public.role_page_permissions),
  (SELECT count(*)::int FROM public.role_action_permissions),
  (SELECT count(*)::int FROM auth.users),
  (SELECT count(*)::int FROM auth.identities),
  (SELECT count(*)::int FROM public.customers),
  (SELECT count(*)::int FROM public.drivers),
  (SELECT count(*)::int FROM public.corporate_accounts),
  (SELECT count(*)::int FROM public.corporate_account_requests),
  (SELECT count(*)::int FROM public.trips),
  (SELECT count(*)::int FROM public.ride_offers),
  (SELECT count(*)::int FROM public.payment_sessions),
  (SELECT count(*)::int FROM public.notifications),
  (SELECT count(*)::int FROM public.booking_delivery_log),
  (SELECT count(*)::int FROM public.driver_wallet_ledger),
  (SELECT COALESCE(SUM(amount_pence),0)::bigint FROM public.driver_wallet_ledger);

DO $$
DECLARE
  b a8b12_integrity%ROWTYPE;
  a a8b12_integrity%ROWTYPE;
BEGIN
  SELECT * INTO b FROM a8b12_integrity WHERE label = 'before';
  SELECT * INTO a FROM a8b12_integrity WHERE label = 'after';
  IF b.auth_secdef <> 148 THEN
    RAISE EXCEPTION 'unexpected before auth_secdef %', b.auth_secdef;
  END IF;
  IF a.auth_secdef <> 138 THEN
    RAISE EXCEPTION 'expected after auth_secdef 138 got %', a.auth_secdef;
  END IF;
  IF a.staff_profiles <> b.staff_profiles
     OR a.user_roles <> b.user_roles
     OR a.role_page_permissions <> b.role_page_permissions
     OR a.role_action_permissions <> b.role_action_permissions
     OR a.auth_users <> b.auth_users
     OR a.auth_identities <> b.auth_identities
     OR a.customers <> b.customers
     OR a.drivers <> b.drivers
     OR a.corporate_accounts <> b.corporate_accounts
     OR a.corporate_requests <> b.corporate_requests
     OR a.trips <> b.trips
     OR a.ride_offers <> b.ride_offers
     OR a.payment_sessions <> b.payment_sessions
     OR a.notifications <> b.notifications
     OR a.booking_delivery_log <> b.booking_delivery_log
     OR a.wallet_rows <> b.wallet_rows
     OR a.wallet_sum <> b.wallet_sum
  THEN
    RAISE EXCEPTION 'integrity drift during ACL simulation';
  END IF;
END $$;

SELECT
  b.auth_secdef AS auth_secdef_before,
  a.auth_secdef AS auth_secdef_after,
  (b.auth_secdef - a.auth_secdef) AS reduction,
  b.staff_profiles,
  b.user_roles,
  b.role_page_permissions,
  b.role_action_permissions,
  b.auth_users,
  b.auth_identities,
  b.customers,
  b.drivers,
  b.corporate_accounts,
  b.corporate_requests,
  b.trips,
  b.ride_offers,
  b.payment_sessions,
  b.notifications,
  b.booking_delivery_log,
  b.wallet_rows,
  b.wallet_sum,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109240000') AS migration_applied,
  has_function_privilege('service_role', 'public.check_email_available_for_change(text,uuid)'::regprocedure, 'EXECUTE') AS email_svc,
  has_function_privilege('service_role', 'public.staff_has_action(uuid,text)'::regprocedure, 'EXECUTE') AS staff_action_svc,
  has_function_privilege('service_role', 'public.haversine_meters(double precision,double precision,double precision,double precision)'::regprocedure, 'EXECUTE') AS haversine_svc,
  has_function_privilege('postgres', 'public.haversine_meters(double precision,double precision,double precision,double precision)'::regprocedure, 'EXECUTE') AS haversine_pg
FROM a8b12_integrity b
JOIN a8b12_integrity a ON a.label = 'after'
WHERE b.label = 'before';

ROLLBACK;
