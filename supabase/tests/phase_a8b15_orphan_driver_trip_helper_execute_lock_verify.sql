-- Phase A8B15 ACL simulation. Privilege/catalog checks only.
-- Does not invoke mutating/operational bodies. Does not print PII.
-- Use BEGIN/ROLLBACK only.

BEGIN;

CREATE TEMP TABLE a8b15_expected (
  name text PRIMARY KEY,
  identity_args text NOT NULL,
  regproc text NOT NULL,
  body_md5 text NOT NULL,
  classification text NOT NULL,
  keep_authenticated boolean NOT NULL,
  keep_service_role boolean NOT NULL,
  restore_service_role boolean NOT NULL
);

INSERT INTO a8b15_expected (
  name, identity_args, regproc, body_md5, classification,
  keep_authenticated, keep_service_role, restore_service_role
) VALUES
  ('is_customer', '_user_id uuid', 'public.is_customer(uuid)', 'bb3ce42cef400bf24a5902a852835ad7', 'ORPHANED', false, false, true),
  ('get_marketplace_delivery_config', 'p_service_area_id uuid', 'public.get_marketplace_delivery_config(uuid)', 'dffe70e9cae0e5d209f6c7998d2d8c17', 'ORPHANED', false, false, true),
  ('resolve_driver_tier_category_priority', 'p_driver_id uuid, p_service_area_id uuid', 'public.resolve_driver_tier_category_priority(uuid, uuid)', '88945cc13b8a131bf0b7d2e391391451', 'ORPHANED', false, false, true),
  ('driver_lost_property_public_trip_ref', 'p_trip_id uuid', 'public.driver_lost_property_public_trip_ref(uuid)', 'ee2f5aba2ee667bbe6b6015c51d01944', 'POSTGRES_INTERNAL_ONLY', false, false, true),
  ('driver_is_assigned_to_live_trip', 'p_driver_id uuid, p_trip_id uuid', 'public.driver_is_assigned_to_live_trip(uuid, uuid)', '056d2586ffe57a4bff7f640e6808b0d4', 'POSTGRES_INTERNAL_ONLY', false, false, true),
  ('driver_is_excluded_from_trip', 'p_trip_id uuid, p_driver_id uuid', 'public.driver_is_excluded_from_trip(uuid, uuid)', 'e63b62a3e89a896acdba8c9d29a35401', 'POSTGRES_INTERNAL_ONLY', false, false, true),
  ('driver_location_state_for_driver', 'p_driver_id uuid', 'public.driver_location_state_for_driver(uuid)', '2069d2642c7fdee1523d5ca8f502ee5f', 'POSTGRES_INTERNAL_ONLY', false, false, true),
  ('driver_location_is_frozen', 'p_driver_id uuid', 'public.driver_location_is_frozen(uuid)', 'b5a397b63aace864e12b3dafdee8a235', 'POSTGRES_INTERNAL_ONLY', false, false, true),
  ('resolve_driver_tier_name', 'p_driver_id uuid', 'public.resolve_driver_tier_name(uuid)', '56843aff56039152dd0bc0a935308e65', 'POSTGRES_INTERNAL_ONLY', false, false, true),
  ('validate_driver_signup_region_service_areas', 'p_region_id uuid, p_service_area_ids uuid[]', 'public.validate_driver_signup_region_service_areas(uuid, uuid[])', 'f936067e153997b545795321741aee24', 'POSTGRES_INTERNAL_ONLY', false, false, false);

DO $pre$
BEGIN
  IF (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1) <> '20261109290000' THEN
    RAISE EXCEPTION 'A8B15 pre: latest migration drift';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109300000') THEN
    RAISE EXCEPTION 'A8B15 pre: migration already present';
  END IF;
  IF (SELECT count(*) FROM a8b15_expected e
      JOIN pg_proc p ON p.proname = e.name
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE md5(p.prosrc) = e.body_md5
        AND pg_get_function_identity_arguments(p.oid) = e.identity_args) <> 10 THEN
    RAISE EXCEPTION 'A8B15 pre: hash/args mismatch or missing signature';
  END IF;
END;
$pre$;

CREATE TEMP TABLE a8b15_counts AS
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
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon_secdef;

-- Apply draft ACL
REVOKE ALL ON FUNCTION public.is_customer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_customer(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.is_customer(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.is_customer(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.get_marketplace_delivery_config(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_marketplace_delivery_config(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_marketplace_delivery_config(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_marketplace_delivery_config(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.resolve_driver_tier_category_priority(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_driver_tier_category_priority(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_driver_tier_category_priority(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_driver_tier_category_priority(uuid, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_is_assigned_to_live_trip(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_is_assigned_to_live_trip(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_is_assigned_to_live_trip(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_is_assigned_to_live_trip(uuid, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_is_excluded_from_trip(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_is_excluded_from_trip(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_is_excluded_from_trip(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_is_excluded_from_trip(uuid, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_location_state_for_driver(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_location_state_for_driver(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_location_state_for_driver(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_location_state_for_driver(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_location_is_frozen(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_location_is_frozen(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_location_is_frozen(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_location_is_frozen(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.resolve_driver_tier_name(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_driver_tier_name(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_driver_tier_name(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_driver_tier_name(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) FROM service_role;

DO $mid$
DECLARE
  e a8b15_expected%ROWTYPE;
  p oid;
  v_auth boolean;
  v_svc boolean;
  v_pg boolean;
  v_auth_count int;
  v_parent oid;
  sentinel uuid := '00000000-0000-4000-8000-000000000015';
  denied int := 0;
  probes text[];
  probe text;
BEGIN
  FOR e IN SELECT * FROM a8b15_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF p IS NULL THEN RAISE EXCEPTION 'A8B15 mid: missing %', e.name; END IF;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B15 mid: body hash changed for %', e.name;
    END IF;
    IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = p)) <> 'postgres' THEN
      RAISE EXCEPTION 'A8B15 mid: owner changed for %', e.name;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = p) THEN
      RAISE EXCEPTION 'A8B15 mid: SECURITY DEFINER lost for %', e.name;
    END IF;
    IF coalesce(array_to_string((SELECT proconfig FROM pg_proc WHERE oid = p), ','), '') !~* 'search_path' THEN
      RAISE EXCEPTION 'A8B15 mid: search_path missing for %', e.name;
    END IF;
    v_auth := has_function_privilege('authenticated', p, 'EXECUTE');
    v_svc := has_function_privilege('service_role', p, 'EXECUTE');
    v_pg := has_function_privilege('postgres', p, 'EXECUTE');
    IF v_auth <> e.keep_authenticated THEN
      RAISE EXCEPTION 'A8B15 mid: authenticated EXECUTE mismatch for %', e.name;
    END IF;
    IF v_svc <> e.keep_service_role THEN
      RAISE EXCEPTION 'A8B15 mid: service_role EXECUTE mismatch for %', e.name;
    END IF;
    IF NOT v_pg THEN
      RAISE EXCEPTION 'A8B15 mid: postgres lost EXECUTE for %', e.name;
    END IF;
  END LOOP;

  -- Parent / trigger closure
  SELECT p.oid INTO v_parent FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='submit_driver_location_sample';
  IF v_parent IS NULL OR NOT has_function_privilege('authenticated', v_parent, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B15 mid: submit_driver_location_sample authenticated EXECUTE lost';
  END IF;

  SELECT p.oid INTO v_parent FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='accept_ride_offer';
  IF v_parent IS NULL OR NOT has_function_privilege('postgres', v_parent, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B15 mid: accept_ride_offer postgres EXECUTE lost';
  END IF;

  SELECT p.oid INTO v_parent FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='find_nearby_drivers';
  IF v_parent IS NULL OR NOT has_function_privilege('authenticated', v_parent, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B15 mid: find_nearby_drivers authenticated EXECUTE lost';
  END IF;

  SELECT p.oid INTO v_parent FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='auto_promote_driver_tier';
  IF v_parent IS NULL OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_parent)
     OR NOT has_function_privilege('postgres', v_parent, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B15 mid: auto_promote_driver_tier SECDEF/postgres broken';
  END IF;

  SELECT p.oid INTO v_parent FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='enforce_driver_signup_region_on_insert';
  IF v_parent IS NULL OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_parent) THEN
    RAISE EXCEPTION 'A8B15 mid: signup region trigger not SECDEF';
  END IF;

  SELECT p.oid INTO v_parent FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='force_driver_offline'
    AND pg_get_function_identity_arguments(p.oid)='p_driver_id uuid, p_reason text';
  IF v_parent IS NULL OR NOT has_function_privilege('authenticated', v_parent, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B15 mid: force_driver_offline authenticated EXECUTE lost';
  END IF;

  -- Authenticated denial probes (42501 before body)
  probes := ARRAY[
    format('SELECT public.is_customer(%L::uuid)', sentinel),
    format('SELECT public.get_marketplace_delivery_config(%L::uuid)', sentinel),
    format('SELECT public.resolve_driver_tier_category_priority(%L::uuid, %L::uuid)', sentinel, sentinel),
    format('SELECT public.driver_lost_property_public_trip_ref(%L::uuid)', sentinel),
    format('SELECT public.driver_is_assigned_to_live_trip(%L::uuid, %L::uuid)', sentinel, sentinel),
    format('SELECT public.driver_is_excluded_from_trip(%L::uuid, %L::uuid)', sentinel, sentinel),
    format('SELECT public.driver_location_state_for_driver(%L::uuid)', sentinel),
    format('SELECT public.driver_location_is_frozen(%L::uuid)', sentinel),
    format('SELECT public.resolve_driver_tier_name(%L::uuid)', sentinel),
    format('SELECT public.validate_driver_signup_region_service_areas(%L::uuid, ARRAY[%L::uuid])', sentinel, sentinel)
  ];
  PERFORM set_config('role', 'authenticated', true);
  FOREACH probe IN ARRAY probes LOOP
    BEGIN
      EXECUTE probe;
      RAISE EXCEPTION 'A8B15 mid: expected 42501 but call succeeded: %', probe;
    EXCEPTION
      WHEN insufficient_privilege THEN
        denied := denied + 1;
      WHEN OTHERS THEN
        RAISE EXCEPTION 'A8B15 mid: expected 42501 got %:% for %', SQLSTATE, SQLERRM, probe;
    END;
  END LOOP;
  PERFORM set_config('role', 'postgres', true);
  IF denied <> 10 THEN
    RAISE EXCEPTION 'A8B15 mid: denied count %', denied;
  END IF;

  SELECT count(*) INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> (SELECT auth_secdef - 10 FROM a8b15_counts) THEN
    RAISE EXCEPTION 'A8B15 mid: expected auth SECDEF −10 (got % from %)',
      v_auth_count, (SELECT auth_secdef FROM a8b15_counts);
  END IF;
  IF (SELECT anon_secdef FROM a8b15_counts) <> 0 THEN
    RAISE EXCEPTION 'A8B15 mid: anon SECDEF baseline not 0';
  END IF;
END;
$mid$;

-- Restore baseline grants
GRANT EXECUTE ON FUNCTION public.is_customer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_customer(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_marketplace_delivery_config(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_marketplace_delivery_config(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_driver_tier_category_priority(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_driver_tier_category_priority(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_is_assigned_to_live_trip(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_is_assigned_to_live_trip(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_is_excluded_from_trip(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_is_excluded_from_trip(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_location_state_for_driver(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_location_state_for_driver(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_location_is_frozen(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_location_is_frozen(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_driver_tier_name(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_driver_tier_name(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) TO authenticated;

DO $post$
DECLARE
  e a8b15_expected%ROWTYPE;
  p oid;
  v_auth_count int;
BEGIN
  FOR e IN SELECT * FROM a8b15_expected LOOP
    SELECT p2.oid INTO p
    FROM pg_proc p2
    JOIN pg_namespace n ON n.oid = p2.pronamespace AND n.nspname = 'public'
    WHERE p2.proname = e.name
      AND pg_get_function_identity_arguments(p2.oid) = e.identity_args;
    IF NOT has_function_privilege('authenticated', p, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B15 post: authenticated not restored for %', e.name;
    END IF;
    IF has_function_privilege('service_role', p, 'EXECUTE') <> e.restore_service_role THEN
      RAISE EXCEPTION 'A8B15 post: service_role restore mismatch for %', e.name;
    END IF;
    IF md5((SELECT prosrc FROM pg_proc WHERE oid = p)) <> e.body_md5 THEN
      RAISE EXCEPTION 'A8B15 post: body hash changed for %', e.name;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_auth_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_count <> (SELECT auth_secdef FROM a8b15_counts) THEN
    RAISE EXCEPTION 'A8B15 post: auth SECDEF not restored to % (got %)',
      (SELECT auth_secdef FROM a8b15_counts), v_auth_count;
  END IF;

  IF (SELECT count(*)::int FROM public.trips) <> (SELECT trips FROM a8b15_counts)
     OR (SELECT count(*)::int FROM public.ride_offers) <> (SELECT ride_offers FROM a8b15_counts)
     OR (SELECT count(*)::int FROM public.payment_sessions) <> (SELECT payment_sessions FROM a8b15_counts)
     OR (SELECT COALESCE(sum(amount_pence),0)::bigint FROM public.driver_wallet_ledger)
          <> (SELECT wallet_signed_sum FROM a8b15_counts)
     OR (SELECT count(*)::int FROM public.notifications) <> (SELECT notifications FROM a8b15_counts)
     OR (SELECT count(*)::int FROM public.towards_destination_sessions) <> (SELECT td_sessions FROM a8b15_counts)
     OR (SELECT count(*)::int FROM public.driver_presence) <> (SELECT driver_presence FROM a8b15_counts)
     OR (SELECT count(*)::int FROM public.push_tokens) <> (SELECT push_tokens FROM a8b15_counts)
  THEN
    RAISE EXCEPTION 'A8B15 post: integrity drift';
  END IF;

  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109300000') THEN
    RAISE EXCEPTION 'A8B15 post: migration unexpectedly present';
  END IF;
END;
$post$;

SELECT jsonb_build_object(
  'status', 'A8B15_SIM_OK',
  'baseline_auth_secdef', (SELECT auth_secdef FROM a8b15_counts),
  'expected_after_apply', (SELECT auth_secdef - 10 FROM a8b15_counts),
  'anon_secdef', (SELECT anon_secdef FROM a8b15_counts),
  'integrity', jsonb_build_object(
    'drivers', (SELECT drivers FROM a8b15_counts),
    'trips', (SELECT trips FROM a8b15_counts),
    'ride_offers', (SELECT ride_offers FROM a8b15_counts),
    'payment_sessions', (SELECT payment_sessions FROM a8b15_counts),
    'wallet_rows', (SELECT wallet_rows FROM a8b15_counts),
    'cw_rows', (SELECT cw_rows FROM a8b15_counts),
    'notifications', (SELECT notifications FROM a8b15_counts),
    'td_sessions', (SELECT td_sessions FROM a8b15_counts),
    'push_tokens', (SELECT push_tokens FROM a8b15_counts)
  )
) AS sim_result;

ROLLBACK;
