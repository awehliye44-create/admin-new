-- Phase A8B10 ACL simulation. Privilege/catalog checks only.
-- Does not invoke mutating bodies. Does not print PII.
-- Use BEGIN/ROLLBACK only.

BEGIN;

CREATE TEMP TABLE a8b10_expected (
  name text PRIMARY KEY,
  identity_args text NOT NULL,
  regproc text NOT NULL,
  body_md5 text NOT NULL,
  keep_authenticated boolean NOT NULL,
  keep_service_role boolean NOT NULL
);

INSERT INTO a8b10_expected (name, identity_args, regproc, body_md5, keep_authenticated, keep_service_role) VALUES
  ('passenger_has_live_immediate_trip', 'p_passenger_id uuid, p_exclude_trip_id uuid', 'public.passenger_has_live_immediate_trip(uuid, uuid)', 'ba91369a8113dc3823068fa6c2cae19c', false, true),
  ('assert_finance_payout_ledger_access', '', 'public.assert_finance_payout_ledger_access()', '26cf156f56679cf1696d8e27d2b8388c', false, false),
  ('assert_driver_wallet_read_access', 'p_driver_id uuid', 'public.assert_driver_wallet_read_access(uuid)', 'e4a182e8066992d28944fe0c2b77fdd2', false, false),
  ('get_dispatch_settings', 'p_service_area_id uuid', 'public.get_dispatch_settings(uuid)', '45cee720edbaa6fd2334ef5d07156f53', false, false),
  ('towards_destination_clear_filter', 'p_driver_id uuid', 'public.towards_destination_clear_filter(uuid)', '4ca656d9d56dc489056b54cc7cefc076', false, false),
  ('towards_destination_resolve_config', 'p_service_area_id uuid', 'public.towards_destination_resolve_config(uuid)', '462b6121fc4620edff5c080b8e153157', false, false),
  ('towards_destination_usage_snapshot', 'p_driver_id uuid, p_limit integer', 'public.towards_destination_usage_snapshot(uuid, integer)', 'c34c02a83f628d8d739e069ab53e38de', false, false),
  ('is_stale_unverified_email_identity', 'p_user_id uuid, p_identity_email text, p_auth_email text, p_auth_email_confirmed_at timestamp with time zone', 'public.is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone)', 'e918d61901008464d3c6745f4f4b5da2', false, false),
  ('is_stale_unverified_phone_identity', 'p_user_id uuid, p_identity_phone text, p_auth_phone text, p_auth_phone_confirmed_at timestamp with time zone', 'public.is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone)', 'fde8c6025008fdfb610915305e8e24a1', false, false),
  ('allow_driver_availability_write', '', 'public.allow_driver_availability_write()', '88b3c50ace6ae03ec5deacf09c9dbc88', false, false);

DO $pre$
BEGIN
  IF (SELECT count(*) FROM a8b10_expected e
      JOIN pg_proc p ON p.proname = e.name
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE md5(p.prosrc) = e.body_md5
        AND pg_get_function_identity_arguments(p.oid) = e.identity_args) <> 10 THEN
    RAISE EXCEPTION 'A8B10 pre: hash/args mismatch or missing signature';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109220000') THEN
    RAISE EXCEPTION 'A8B10 pre: migration already applied';
  END IF;
END;
$pre$;

CREATE TEMP TABLE a8b10_counts AS
SELECT
  (SELECT count(*)::int FROM public.staff_profiles) AS staff_profiles,
  (SELECT count(*)::int FROM public.user_roles) AS user_roles,
  (SELECT count(*)::int FROM auth.users) AS auth_users,
  (SELECT count(*)::int FROM public.customers) AS customers,
  (SELECT count(*)::int FROM public.drivers) AS drivers,
  (SELECT count(*)::int FROM public.corporate_accounts) AS corporate_accounts,
  (SELECT count(*)::int FROM public.corporate_users) AS corporate_users,
  (SELECT count(*)::int FROM public.corporate_account_requests) AS corporate_requests,
  (SELECT count(*)::int FROM public.trips) AS trips,
  (SELECT count(*)::int FROM public.ride_offers) AS ride_offers,
  (SELECT count(*)::int FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*)::int FROM public.payout_items) AS payout_items,
  (SELECT count(*)::int FROM public.payout_batches) AS payout_batches,
  (SELECT count(*)::int FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT COALESCE(sum(amount_pence),0)::bigint FROM public.driver_wallet_ledger) AS wallet_signed_sum,
  (SELECT count(*)::int FROM public.driver_commission_wallet_ledger) AS cw_rows,
  (SELECT COALESCE(sum(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END),0)::bigint
     FROM public.driver_commission_wallet_ledger) AS cw_signed_sum,
  (SELECT count(*)::int FROM public.notifications) AS notifications,
  (SELECT count(*)::int FROM public.booking_delivery_log) AS booking_delivery_log,
  (SELECT count(*)::int FROM public.towards_destination_sessions) AS td_sessions,
  (SELECT count(*)::int FROM public.driver_alerts) AS driver_alerts,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_secdef;

-- Apply draft ACL
REVOKE ALL ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.assert_finance_payout_ledger_access() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_finance_payout_ledger_access() FROM anon;
REVOKE ALL ON FUNCTION public.assert_finance_payout_ledger_access() FROM authenticated;
REVOKE ALL ON FUNCTION public.assert_finance_payout_ledger_access() FROM service_role;

REVOKE ALL ON FUNCTION public.assert_driver_wallet_read_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_driver_wallet_read_access(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assert_driver_wallet_read_access(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.assert_driver_wallet_read_access(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.get_dispatch_settings(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_dispatch_settings(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_dispatch_settings(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_dispatch_settings(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.towards_destination_clear_filter(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.towards_destination_clear_filter(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.towards_destination_clear_filter(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.towards_destination_clear_filter(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.towards_destination_resolve_config(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.towards_destination_resolve_config(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.towards_destination_resolve_config(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.towards_destination_resolve_config(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.towards_destination_usage_snapshot(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.towards_destination_usage_snapshot(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.towards_destination_usage_snapshot(uuid, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.towards_destination_usage_snapshot(uuid, integer) FROM service_role;

REVOKE ALL ON FUNCTION public.is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone) FROM authenticated;
REVOKE ALL ON FUNCTION public.is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone) FROM service_role;

REVOKE ALL ON FUNCTION public.is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone) FROM authenticated;
REVOKE ALL ON FUNCTION public.is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone) FROM service_role;

REVOKE ALL ON FUNCTION public.allow_driver_availability_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.allow_driver_availability_write() FROM anon;
REVOKE ALL ON FUNCTION public.allow_driver_availability_write() FROM authenticated;
REVOKE ALL ON FUNCTION public.allow_driver_availability_write() FROM service_role;

DO $mid$
DECLARE
  e a8b10_expected%ROWTYPE;
  p oid;
  v_auth boolean;
  v_svc boolean;
  v_pg boolean;
  v_auth_count int;
BEGIN
  FOR e IN SELECT * FROM a8b10_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF p IS NULL THEN
      RAISE EXCEPTION 'A8B10 mid: missing %', e.name;
    END IF;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B10 mid: body hash changed for %', e.name;
    END IF;
    v_auth := has_function_privilege('authenticated', p, 'EXECUTE');
    v_svc := has_function_privilege('service_role', p, 'EXECUTE');
    v_pg := has_function_privilege('postgres', p, 'EXECUTE');
    IF v_auth <> e.keep_authenticated THEN
      RAISE EXCEPTION 'A8B10 mid: authenticated EXECUTE mismatch for %', e.name;
    END IF;
    IF v_svc <> e.keep_service_role THEN
      RAISE EXCEPTION 'A8B10 mid: service_role EXECUTE mismatch for %', e.name;
    END IF;
    IF NOT v_pg THEN
      RAISE EXCEPTION 'A8B10 mid: postgres lost EXECUTE for %', e.name;
    END IF;
  END LOOP;

  -- Mounted Admin payout RPCs must still be executable by authenticated
  IF NOT has_function_privilege('authenticated', 'public.ops_retry_failed_payout_item(uuid)'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.return_failed_payout_to_wallet(uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B10 mid: Admin payout RPCs unexpectedly lost authenticated EXECUTE';
  END IF;

  SELECT count(*) INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> (SELECT auth_secdef - 10 FROM a8b10_counts) THEN
    RAISE EXCEPTION 'A8B10 mid: expected auth SECDEF −10 (got % from %)',
      v_auth_count, (SELECT auth_secdef FROM a8b10_counts);
  END IF;
END;
$mid$;

-- Restore grants then assert
GRANT EXECUTE ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.passenger_has_live_immediate_trip(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.assert_finance_payout_ledger_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_finance_payout_ledger_access() TO service_role;
GRANT EXECUTE ON FUNCTION public.assert_driver_wallet_read_access(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_driver_wallet_read_access(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_dispatch_settings(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_dispatch_settings(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.towards_destination_clear_filter(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_clear_filter(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.towards_destination_resolve_config(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_resolve_config(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.towards_destination_usage_snapshot(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_usage_snapshot(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_stale_unverified_email_identity(uuid, text, text, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_stale_unverified_phone_identity(uuid, text, text, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.allow_driver_availability_write() TO authenticated;
GRANT EXECUTE ON FUNCTION public.allow_driver_availability_write() TO service_role;

DO $post$
DECLARE
  e a8b10_expected%ROWTYPE;
  p oid;
BEGIN
  FOR e IN SELECT * FROM a8b10_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF NOT has_function_privilege('authenticated', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B10 post: authenticated not restored for %', e.name;
    END IF;
    IF NOT has_function_privilege('service_role', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B10 post: service_role not restored for %', e.name;
    END IF;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B10 post: body hash changed for %', e.name;
    END IF;
  END LOOP;

  IF (SELECT count(*)::int FROM public.trips) <> (SELECT trips FROM a8b10_counts)
     OR (SELECT COALESCE(sum(amount_pence),0)::bigint FROM public.driver_wallet_ledger)
          <> (SELECT wallet_signed_sum FROM a8b10_counts)
     OR (SELECT count(*)::int FROM public.driver_alerts) <> (SELECT driver_alerts FROM a8b10_counts)
  THEN
    RAISE EXCEPTION 'A8B10 post: integrity drift';
  END IF;

  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109220000') THEN
    RAISE EXCEPTION 'A8B10 post: migration unexpectedly present';
  END IF;
END;
$post$;

ROLLBACK;
