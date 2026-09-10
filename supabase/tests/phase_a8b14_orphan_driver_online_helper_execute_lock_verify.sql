-- Phase A8B14 ACL simulation. Privilege/catalog checks only.
-- Does not invoke mutating bodies. Does not print PII.
-- Use BEGIN/ROLLBACK only. has_function_privilege + parent EXECUTE checks.

BEGIN;

CREATE TEMP TABLE a8b14_expected (
  name text PRIMARY KEY,
  identity_args text NOT NULL,
  regproc text NOT NULL,
  body_md5 text NOT NULL,
  classification text NOT NULL,
  keep_authenticated boolean NOT NULL,
  keep_service_role boolean NOT NULL
);

INSERT INTO a8b14_expected (name, identity_args, regproc, body_md5, classification, keep_authenticated, keep_service_role) VALUES
  ('driver_availability_ssot', 'p_driver_id uuid, p_max_heartbeat_age_seconds integer, p_max_location_age_seconds integer, p_max_realtime_age_seconds integer, p_require_push_token boolean', 'public.driver_availability_ssot(uuid, integer, integer, integer, boolean)', '7bfe41126b0943932203b98a8ca33aef', 'ORPHANED', false, false),
  ('driver_effective_online_snapshot', 'p_driver_id uuid, p_max_heartbeat_age_seconds integer, p_max_location_age_seconds integer, p_max_realtime_age_seconds integer, p_require_push_token boolean', 'public.driver_effective_online_snapshot(uuid, integer, integer, integer, boolean)', 'e0f1e77a452032084f1b5b046caa691e', 'ORPHANED', false, false),
  ('driver_effective_online_reason', 'p_driver_id uuid, p_max_heartbeat_age_seconds integer, p_max_location_age_seconds integer, p_max_realtime_age_seconds integer, p_require_push_token boolean', 'public.driver_effective_online_reason(uuid, integer, integer, integer, boolean)', '8a1f85a7c4833370c347c29652401eca', 'ORPHANED', false, false),
  ('driver_freshness_reason', 'p_driver_id uuid, p_max_heartbeat_age_seconds integer, p_max_location_age_seconds integer, p_max_realtime_age_seconds integer, p_require_push_token boolean', 'public.driver_freshness_reason(uuid, integer, integer, integer, boolean)', '8bdcebf9809811c590876348e5cd9385', 'ORPHANED', false, false),
  ('driver_presence_last_signal_at', 'p_driver_id uuid', 'public.driver_presence_last_signal_at(uuid)', '243b942b35903ee3f34310cdac5a694d', 'ORPHANED', false, false),
  ('can_modify_trip', 'p_trip_id uuid', 'public.can_modify_trip(uuid)', '577acc1711d11bde0b283d00f0e8139e', 'ORPHANED', false, false),
  ('ride_offer_is_on_voluntary_decline_cooldown', 'p_trip_id uuid, p_driver_id uuid, p_cooldown_seconds integer', 'public.ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer)', '7c7f3bb7c19607c82e5fc3e02f7c09a1', 'ORPHANED', false, false),
  ('towards_destination_business_date', 'p_driver_id uuid', 'public.towards_destination_business_date(uuid)', 'eab15f0bc302a8afb9bea42b1042b3b8', 'ORPHANED', false, false),
  ('get_driver_identity_verification_gate', 'p_driver_id uuid', 'public.get_driver_identity_verification_gate(uuid)', '29403d5d03dda8acb8b38c6324ee0cb5', 'POSTGRES_INTERNAL_ONLY', false, false),
  ('driver_has_accepted_active_or_stacked_work', 'p_driver_id uuid', 'public.driver_has_accepted_active_or_stacked_work(uuid)', '736feddece8d9987ce177d8102e04297', 'POSTGRES_INTERNAL_ONLY', false, false);

DO $pre$
BEGIN
  IF (SELECT count(*) FROM a8b14_expected e
      JOIN pg_proc p ON p.proname = e.name
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE md5(p.prosrc) = e.body_md5
        AND pg_get_function_identity_arguments(p.oid) = e.identity_args) <> 10 THEN
    RAISE EXCEPTION 'A8B14 pre: hash/args mismatch or missing signature';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109290000') THEN
    RAISE EXCEPTION 'A8B14 pre: migration already applied';
  END IF;
END;
$pre$;

CREATE TEMP TABLE a8b14_counts AS
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
  (SELECT count(*)::int FROM public.driver_presence) AS driver_presence,
  (SELECT count(*)::int FROM public.towards_destination_sessions) AS td_sessions,
  (SELECT count(*)::int FROM public.push_tokens) AS push_tokens,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_secdef;

-- Apply draft ACL (mirrors forward migration)
REVOKE ALL ON FUNCTION public.driver_availability_ssot(uuid, integer, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_availability_ssot(uuid, integer, integer, integer, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.driver_availability_ssot(uuid, integer, integer, integer, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_availability_ssot(uuid, integer, integer, integer, boolean) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_effective_online_snapshot(uuid, integer, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_effective_online_snapshot(uuid, integer, integer, integer, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.driver_effective_online_snapshot(uuid, integer, integer, integer, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_effective_online_snapshot(uuid, integer, integer, integer, boolean) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_effective_online_reason(uuid, integer, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_effective_online_reason(uuid, integer, integer, integer, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.driver_effective_online_reason(uuid, integer, integer, integer, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_effective_online_reason(uuid, integer, integer, integer, boolean) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_freshness_reason(uuid, integer, integer, integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_freshness_reason(uuid, integer, integer, integer, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.driver_freshness_reason(uuid, integer, integer, integer, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_freshness_reason(uuid, integer, integer, integer, boolean) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_presence_last_signal_at(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_presence_last_signal_at(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_presence_last_signal_at(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_presence_last_signal_at(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.can_modify_trip(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_modify_trip(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.can_modify_trip(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.can_modify_trip(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer) FROM service_role;

REVOKE ALL ON FUNCTION public.towards_destination_business_date(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.towards_destination_business_date(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.towards_destination_business_date(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.towards_destination_business_date(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.get_driver_identity_verification_gate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_identity_verification_gate(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_identity_verification_gate(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_driver_identity_verification_gate(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid) FROM service_role;

DO $mid$
DECLARE
  e a8b14_expected%ROWTYPE;
  p oid;
  v_auth boolean;
  v_svc boolean;
  v_pg boolean;
  v_auth_count int;
  v_parent oid;
BEGIN
  FOR e IN SELECT * FROM a8b14_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF p IS NULL THEN
      RAISE EXCEPTION 'A8B14 mid: missing %', e.name;
    END IF;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B14 mid: body hash changed for %', e.name;
    END IF;
    v_auth := has_function_privilege('authenticated', p, 'EXECUTE');
    v_svc := has_function_privilege('service_role', p, 'EXECUTE');
    v_pg := has_function_privilege('postgres', p, 'EXECUTE');
    IF v_auth <> e.keep_authenticated THEN
      RAISE EXCEPTION 'A8B14 mid: authenticated EXECUTE mismatch for %', e.name;
    END IF;
    IF v_svc <> e.keep_service_role THEN
      RAISE EXCEPTION 'A8B14 mid: service_role EXECUTE mismatch for %', e.name;
    END IF;
    IF NOT v_pg THEN
      RAISE EXCEPTION 'A8B14 mid: postgres lost EXECUTE for %', e.name;
    END IF;
  END LOOP;

  -- Parent / live path EXECUTE still present (nested SECDEF uses owner rights)
  SELECT p.oid INTO v_parent FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='assert_driver_presence_online_eligible'
    AND pg_get_function_identity_arguments(p.oid)='p_driver_id uuid';
  IF v_parent IS NULL OR NOT has_function_privilege('postgres', v_parent, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B14 mid: assert_driver_presence_online_eligible not executable by postgres';
  END IF;

  SELECT p.oid INTO v_parent FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='driver_request_go_online';
  IF v_parent IS NULL OR NOT has_function_privilege('authenticated', v_parent, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B14 mid: driver_request_go_online authenticated EXECUTE lost';
  END IF;

  SELECT p.oid INTO v_parent FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='force_driver_offline'
    AND pg_get_function_identity_arguments(p.oid)='p_driver_id uuid, p_reason text';
  IF v_parent IS NULL OR NOT has_function_privilege('authenticated', v_parent, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B14 mid: force_driver_offline authenticated EXECUTE lost';
  END IF;

  SELECT count(*) INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> (SELECT auth_secdef - 10 FROM a8b14_counts) THEN
    RAISE EXCEPTION 'A8B14 mid: expected auth SECDEF −10 (got % from %)',
      v_auth_count, (SELECT auth_secdef FROM a8b14_counts);
  END IF;
  IF (SELECT anon_secdef FROM a8b14_counts) <> 0 THEN
    RAISE EXCEPTION 'A8B14 mid: anon SECDEF was not 0 at baseline';
  END IF;
END;
$mid$;

-- Restore grants (mirrors emergency rollback), then assert restored
GRANT EXECUTE ON FUNCTION public.driver_availability_ssot(uuid, integer, integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_availability_ssot(uuid, integer, integer, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_effective_online_snapshot(uuid, integer, integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_effective_online_snapshot(uuid, integer, integer, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_effective_online_reason(uuid, integer, integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_effective_online_reason(uuid, integer, integer, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_freshness_reason(uuid, integer, integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_freshness_reason(uuid, integer, integer, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_presence_last_signal_at(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_presence_last_signal_at(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.can_modify_trip(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_modify_trip(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.towards_destination_business_date(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_business_date(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_identity_verification_gate(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_identity_verification_gate(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid) TO service_role;

DO $post$
DECLARE
  e a8b14_expected%ROWTYPE;
  p oid;
  v_auth_count int;
BEGIN
  FOR e IN SELECT * FROM a8b14_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF NOT has_function_privilege('authenticated', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B14 post: authenticated not restored for %', e.name;
    END IF;
    IF NOT has_function_privilege('service_role', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B14 post: service_role not restored for %', e.name;
    END IF;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B14 post: body hash changed for %', e.name;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> (SELECT auth_secdef FROM a8b14_counts) THEN
    RAISE EXCEPTION 'A8B14 post: auth SECDEF not restored to baseline % (got %)',
      (SELECT auth_secdef FROM a8b14_counts), v_auth_count;
  END IF;

  IF (SELECT count(*)::int FROM public.trips) <> (SELECT trips FROM a8b14_counts)
     OR (SELECT count(*)::int FROM public.ride_offers) <> (SELECT ride_offers FROM a8b14_counts)
     OR (SELECT count(*)::int FROM public.payment_sessions) <> (SELECT payment_sessions FROM a8b14_counts)
     OR (SELECT COALESCE(sum(amount_pence),0)::bigint FROM public.driver_wallet_ledger)
          <> (SELECT wallet_signed_sum FROM a8b14_counts)
     OR (SELECT count(*)::int FROM public.notifications) <> (SELECT notifications FROM a8b14_counts)
     OR (SELECT count(*)::int FROM public.towards_destination_sessions) <> (SELECT td_sessions FROM a8b14_counts)
     OR (SELECT count(*)::int FROM public.driver_presence) <> (SELECT driver_presence FROM a8b14_counts)
     OR (SELECT count(*)::int FROM public.push_tokens) <> (SELECT push_tokens FROM a8b14_counts)
  THEN
    RAISE EXCEPTION 'A8B14 post: integrity drift';
  END IF;

  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109290000') THEN
    RAISE EXCEPTION 'A8B14 post: migration unexpectedly present';
  END IF;
END;
$post$;

-- Emit summary for the harness (no PII)
SELECT jsonb_build_object(
  'status', 'A8B14_SIM_OK',
  'baseline_auth_secdef', (SELECT auth_secdef FROM a8b14_counts),
  'expected_after_apply', (SELECT auth_secdef - 10 FROM a8b14_counts),
  'anon_secdef', (SELECT anon_secdef FROM a8b14_counts),
  'integrity', jsonb_build_object(
    'drivers', (SELECT drivers FROM a8b14_counts),
    'trips', (SELECT trips FROM a8b14_counts),
    'ride_offers', (SELECT ride_offers FROM a8b14_counts),
    'payment_sessions', (SELECT payment_sessions FROM a8b14_counts),
    'wallet_rows', (SELECT wallet_rows FROM a8b14_counts),
    'cw_rows', (SELECT cw_rows FROM a8b14_counts),
    'notifications', (SELECT notifications FROM a8b14_counts),
    'td_sessions', (SELECT td_sessions FROM a8b14_counts),
    'push_tokens', (SELECT push_tokens FROM a8b14_counts)
  )
) AS sim_result;

ROLLBACK;
