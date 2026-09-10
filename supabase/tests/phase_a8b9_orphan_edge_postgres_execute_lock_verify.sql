-- Phase A8B9 ACL simulation. Privilege/catalog checks only.
-- Does not invoke mutating bodies. Does not print PII.
-- Use BEGIN/ROLLBACK only. Sentinel UUIDs + has_function_privilege.

BEGIN;

CREATE TEMP TABLE a8b9_expected (
  name text PRIMARY KEY,
  identity_args text NOT NULL,
  regproc text NOT NULL,
  body_md5 text NOT NULL,
  keep_authenticated boolean NOT NULL,
  keep_service_role boolean NOT NULL
);

INSERT INTO a8b9_expected (name, identity_args, regproc, body_md5, keep_authenticated, keep_service_role) VALUES
  ('get_active_stop_waiting', 'p_driver_id uuid', 'public.get_active_stop_waiting(uuid)', '87aa0b8077e50dff3cd06bf45ce91064', false, true),
  ('get_customer_trip_stats', '_passenger_id uuid', 'public.get_customer_trip_stats(uuid)', '0976e9196ab839f91486ffc496c98e8c', false, false),
  ('get_corporate_allowed_payment_methods', 'p_account_id uuid', 'public.get_corporate_allowed_payment_methods(uuid)', '17b072d26ef25e2f4f5c5fa1796d1d0b', false, false),
  ('staff_role_of', '_user_id uuid', 'public.staff_role_of(uuid)', '1ce27f25a629a33d3861aae4d01e4069', false, false),
  ('is_user_suspended', 'p_user_id uuid, p_user_type text', 'public.is_user_suspended(uuid, text)', 'b745a603b49b1e01a7ff6c023dacd9f3', false, false),
  ('driver_cancel_before_start_rematch', 'p_trip_id uuid, p_driver_id uuid, p_reason text, p_idempotency_key text, p_request_metadata jsonb', 'public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb)', '803c5f52b03778f66091fc7a5c0b2dc7', false, false),
  ('towards_destination_complete_session', 'p_session_id uuid, p_reason text', 'public.towards_destination_complete_session(uuid, text)', '5156dfbd5d13b99376b72682033399d5', false, false),
  ('towards_destination_maybe_complete_on_location', 'p_driver_id uuid, p_lat double precision, p_lng double precision', 'public.towards_destination_maybe_complete_on_location(uuid, double precision, double precision)', '1ebacf4776a4d4164b43f2f09e0a171f', false, false),
  ('is_driver_dispatchable', 'p_driver_id uuid, p_max_heartbeat_age_seconds integer, p_require_push_token boolean, p_max_location_age_seconds integer', 'public.is_driver_dispatchable(uuid, integer, boolean, integer)', 'f876b9596bf0e0fcefbe9845f92cb2e6', false, false),
  ('compute_ride_offer_preset_options', 'p_trip trips', 'public.compute_ride_offer_preset_options(trips)', '95339b4696f8bb67d3a9f9b6eb44f239', false, false);

DO $pre$
BEGIN
  IF (SELECT count(*) FROM a8b9_expected e
      JOIN pg_proc p ON p.proname = e.name
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE md5(p.prosrc) = e.body_md5
        AND pg_get_function_identity_arguments(p.oid) = e.identity_args) <> 10 THEN
    RAISE EXCEPTION 'A8B9 pre: hash/args mismatch or missing signature';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109210000') THEN
    RAISE EXCEPTION 'A8B9 pre: migration already applied';
  END IF;
END;
$pre$;

CREATE TEMP TABLE a8b9_counts AS
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
  (SELECT count(*)::int FROM public.payout_batches) AS payout_batches,
  (SELECT count(*)::int FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT COALESCE(sum(amount_pence),0)::bigint FROM public.driver_wallet_ledger) AS wallet_signed_sum,
  (SELECT count(*)::int FROM public.driver_commission_wallet_ledger) AS cw_rows,
  (SELECT COALESCE(sum(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END),0)::bigint
     FROM public.driver_commission_wallet_ledger) AS cw_signed_sum,
  (SELECT count(*)::int FROM public.notifications) AS notifications,
  (SELECT count(*)::int FROM public.booking_delivery_log) AS booking_delivery_log,
  (SELECT count(*)::int FROM public.trip_stop_waiting) AS trip_stop_waiting,
  (SELECT count(*)::int FROM public.towards_destination_sessions) AS td_sessions,
  (SELECT count(*)::int FROM public.account_suspensions) AS account_suspensions,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_secdef;

-- Apply draft ACL (mirrors forward migration)
REVOKE ALL ON FUNCTION public.get_active_stop_waiting(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_active_stop_waiting(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_active_stop_waiting(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_stop_waiting(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.is_user_suspended(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_user_suspended(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.is_user_suspended(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.is_user_suspended(uuid, text) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) FROM service_role;

REVOKE ALL ON FUNCTION public.is_driver_dispatchable(uuid, integer, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_driver_dispatchable(uuid, integer, boolean, integer) FROM anon;
REVOKE ALL ON FUNCTION public.is_driver_dispatchable(uuid, integer, boolean, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.is_driver_dispatchable(uuid, integer, boolean, integer) FROM service_role;

REVOKE ALL ON FUNCTION public.get_customer_trip_stats(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_trip_stats(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_customer_trip_stats(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_customer_trip_stats(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.staff_role_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_role_of(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.staff_role_of(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.staff_role_of(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.towards_destination_complete_session(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.towards_destination_complete_session(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.towards_destination_complete_session(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.towards_destination_complete_session(uuid, text) FROM service_role;

REVOKE ALL ON FUNCTION public.towards_destination_maybe_complete_on_location(uuid, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.towards_destination_maybe_complete_on_location(uuid, double precision, double precision) FROM anon;
REVOKE ALL ON FUNCTION public.towards_destination_maybe_complete_on_location(uuid, double precision, double precision) FROM authenticated;
REVOKE ALL ON FUNCTION public.towards_destination_maybe_complete_on_location(uuid, double precision, double precision) FROM service_role;

REVOKE ALL ON FUNCTION public.compute_ride_offer_preset_options(trips) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_ride_offer_preset_options(trips) FROM anon;
REVOKE ALL ON FUNCTION public.compute_ride_offer_preset_options(trips) FROM authenticated;
REVOKE ALL ON FUNCTION public.compute_ride_offer_preset_options(trips) FROM service_role;

DO $mid$
DECLARE
  e a8b9_expected%ROWTYPE;
  p oid;
  v_auth boolean;
  v_svc boolean;
  v_pg boolean;
  v_auth_count int;
BEGIN
  FOR e IN SELECT * FROM a8b9_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF p IS NULL THEN
      RAISE EXCEPTION 'A8B9 mid: missing %', e.name;
    END IF;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B9 mid: body hash changed for %', e.name;
    END IF;
    v_auth := has_function_privilege('authenticated', p, 'EXECUTE');
    v_svc := has_function_privilege('service_role', p, 'EXECUTE');
    v_pg := has_function_privilege('postgres', p, 'EXECUTE');
    IF v_auth <> e.keep_authenticated THEN
      RAISE EXCEPTION 'A8B9 mid: authenticated EXECUTE mismatch for %', e.name;
    END IF;
    IF v_svc <> e.keep_service_role THEN
      RAISE EXCEPTION 'A8B9 mid: service_role EXECUTE mismatch for %', e.name;
    END IF;
    IF NOT v_pg THEN
      RAISE EXCEPTION 'A8B9 mid: postgres lost EXECUTE for %', e.name;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> (SELECT auth_secdef - 10 FROM a8b9_counts) THEN
    RAISE EXCEPTION 'A8B9 mid: expected auth SECDEF −10 (got % from %)',
      v_auth_count, (SELECT auth_secdef FROM a8b9_counts);
  END IF;
END;
$mid$;

-- Rollback grants (mirrors emergency rollback), then assert restored
GRANT EXECUTE ON FUNCTION public.get_active_stop_waiting(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_stop_waiting(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_user_suspended(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_suspended(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_driver_dispatchable(uuid, integer, boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_driver_dispatchable(uuid, integer, boolean, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_customer_trip_stats(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_trip_stats(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.staff_role_of(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_role_of(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.towards_destination_complete_session(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_complete_session(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.towards_destination_maybe_complete_on_location(uuid, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_maybe_complete_on_location(uuid, double precision, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.compute_ride_offer_preset_options(trips) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compute_ride_offer_preset_options(trips) TO service_role;

DO $post$
DECLARE
  e a8b9_expected%ROWTYPE;
  p oid;
BEGIN
  FOR e IN SELECT * FROM a8b9_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF NOT has_function_privilege('authenticated', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B9 post: authenticated not restored for %', e.name;
    END IF;
    IF NOT has_function_privilege('service_role', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B9 post: service_role not restored for %', e.name;
    END IF;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B9 post: body hash changed for %', e.name;
    END IF;
  END LOOP;

  IF (SELECT count(*)::int FROM public.trips) <> (SELECT trips FROM a8b9_counts)
     OR (SELECT count(*)::int FROM public.ride_offers) <> (SELECT ride_offers FROM a8b9_counts)
     OR (SELECT count(*)::int FROM public.payment_sessions) <> (SELECT payment_sessions FROM a8b9_counts)
     OR (SELECT COALESCE(sum(amount_pence),0)::bigint FROM public.driver_wallet_ledger)
          <> (SELECT wallet_signed_sum FROM a8b9_counts)
     OR (SELECT count(*)::int FROM public.notifications) <> (SELECT notifications FROM a8b9_counts)
     OR (SELECT count(*)::int FROM public.towards_destination_sessions) <> (SELECT td_sessions FROM a8b9_counts)
  THEN
    RAISE EXCEPTION 'A8B9 post: integrity drift';
  END IF;

  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109210000') THEN
    RAISE EXCEPTION 'A8B9 post: migration unexpectedly present';
  END IF;
END;
$post$;

ROLLBACK;
