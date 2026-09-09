-- Phase A8B6 ACL simulation. Privilege/catalog checks only.
-- Does not invoke mutating bodies, create trips/offers, or touch wallets.

BEGIN;

CREATE TEMP TABLE a8b6_expected (
  name text PRIMARY KEY,
  identity_args text NOT NULL,
  regproc text NOT NULL,
  body_md5 text NOT NULL
);

INSERT INTO a8b6_expected (name, identity_args, regproc, body_md5) VALUES
  ('allocate_driver_reference', 'p_service_area_id uuid', 'public.allocate_driver_reference(uuid)', '4657ceb6492a858defc384a767a1852d'),
  ('allocate_trip_reference', 'p_service_area_id uuid, p_created_at timestamp with time zone', 'public.allocate_trip_reference(uuid, timestamp with time zone)', '4fc954d0dcdc6fcf816d050687e54c9a'),
  ('assign_trip_number', 'p_trip_id uuid, p_service_area_id uuid', 'public.assign_trip_number(uuid, uuid)', '54f05e1793faf723a690d88e3b643e32'),
  ('enrich_ride_offer_presets', 'p_trip_id uuid', 'public.enrich_ride_offer_presets(uuid)', '146ee27fc94d0f42a5b7e7206a20901a'),
  ('ensure_trip_stops_for_assignment', 'p_trip_id uuid', 'public.ensure_trip_stops_for_assignment(uuid)', '504e6ecf61d239155df07c81aac43737'),
  ('log_dispatch_eligibility', 'p_trip_id uuid, p_driver_id uuid, p_is_eligible boolean, p_reject_reason text, p_context jsonb', 'public.log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb)', 'b6e1b8d56bc7b851db05392bc0576b1b'),
  ('ops_retry_failed_dispatch', 'p_trip_id uuid', 'public.ops_retry_failed_dispatch(uuid)', 'dd96c125966be010383945dcd050fa32'),
  ('recalculate_driver_display_rating', 'p_driver_id uuid', 'public.recalculate_driver_display_rating(uuid)', '2ca3a9045fd667801b2215d403f1eaae'),
  ('start_driver_commitment_session', 'p_trip_id uuid, p_driver_id uuid', 'public.start_driver_commitment_session(uuid, uuid)', '0858396c49b98875d5d712c1c52d65e1'),
  ('upsert_driver_live_location', 'p_driver_id uuid, p_lat double precision, p_lng double precision, p_geohash6 text, p_speed real, p_heading real', 'public.upsert_driver_live_location(uuid, double precision, double precision, text, real, real)', '6320cc6f61cade85abc45bc1f9412d3b');

CREATE TEMP TABLE a8b6_hash AS
SELECT e.name, e.identity_args, e.body_md5 AS expected_md5, md5(p.prosrc) AS actual_md5,
       pg_get_function_identity_arguments(p.oid) AS live_args
FROM a8b6_expected e
JOIN pg_proc p ON p.proname = e.name
JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public';

DO $pre$
BEGIN
  IF (SELECT count(*) FROM a8b6_hash) <> 10 THEN
    RAISE EXCEPTION 'A8B6 pre: expected 10 live signatures, got %', (SELECT count(*) FROM a8b6_hash);
  END IF;
  IF EXISTS (
    SELECT 1 FROM a8b6_hash
    WHERE actual_md5 IS DISTINCT FROM expected_md5
       OR live_args IS DISTINCT FROM identity_args
  ) THEN
    RAISE EXCEPTION 'A8B6 pre: body hash or identity args mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109180000'
  ) THEN
    RAISE EXCEPTION 'A8B6 pre: migration 20261109180000 already applied';
  END IF;
END;
$pre$;

CREATE TEMP TABLE a8b6_counts AS
SELECT
  (SELECT count(*)::int FROM public.trips) AS trips,
  (SELECT count(*)::int FROM public.ride_offers) AS ride_offers,
  (SELECT count(*)::int FROM public.notifications) AS notifications,
  (SELECT count(*)::int FROM public.booking_delivery_log) AS booking_delivery_log,
  (SELECT count(*)::int FROM public.drivers) AS drivers,
  (SELECT count(*)::int FROM auth.users) AS auth_users,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef;

REVOKE ALL ON FUNCTION public.allocate_driver_reference(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.allocate_driver_reference(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.allocate_driver_reference(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_driver_reference(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.allocate_trip_reference(uuid, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.allocate_trip_reference(uuid, timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.allocate_trip_reference(uuid, timestamp with time zone) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_trip_reference(uuid, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.assign_trip_number(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_trip_number(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assign_trip_number(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assign_trip_number(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.enrich_ride_offer_presets(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enrich_ride_offer_presets(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.enrich_ride_offer_presets(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.enrich_ride_offer_presets(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.ensure_trip_stops_for_assignment(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_trip_stops_for_assignment(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ensure_trip_stops_for_assignment(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_trip_stops_for_assignment(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.ops_retry_failed_dispatch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_retry_failed_dispatch(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ops_retry_failed_dispatch(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ops_retry_failed_dispatch(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.recalculate_driver_display_rating(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_driver_display_rating(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.recalculate_driver_display_rating(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_driver_display_rating(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.start_driver_commitment_session(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_driver_commitment_session(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.start_driver_commitment_session(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.start_driver_commitment_session(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.upsert_driver_live_location(uuid, double precision, double precision, text, real, real) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_driver_live_location(uuid, double precision, double precision, text, real, real) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_driver_live_location(uuid, double precision, double precision, text, real, real) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_driver_live_location(uuid, double precision, double precision, text, real, real) TO service_role;

DO $post$
DECLARE
  r record;
  v_auth int;
BEGIN
  FOR r IN SELECT name, regproc FROM a8b6_expected LOOP
    IF has_function_privilege('authenticated', r.regproc::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B6 post: authenticated still has EXECUTE on %', r.name;
    END IF;
    IF has_function_privilege('anon', r.regproc::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B6 post: anon has EXECUTE on %', r.name;
    END IF;
    IF NOT has_function_privilege('service_role', r.regproc::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B6 post: service_role missing EXECUTE on %', r.name;
    END IF;
  END LOOP;

  IF NOT has_function_privilege('postgres', 'public.generate_driver_code()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B6 post: postgres cannot execute generate_driver_code';
  END IF;
  IF NOT has_function_privilege('postgres', 'public.generate_trip_code()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B6 post: postgres cannot execute generate_trip_code';
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth <> 187 THEN
    RAISE EXCEPTION 'A8B6 post: expected auth SECDEF 187, got %', v_auth;
  END IF;

  IF EXISTS (
    SELECT 1 FROM a8b6_hash h
    JOIN pg_proc p ON p.proname = h.name
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname='public'
    WHERE md5(p.prosrc) IS DISTINCT FROM h.expected_md5
  ) THEN
    RAISE EXCEPTION 'A8B6 post: body hash changed during ACL simulation';
  END IF;
END;
$post$;

DO $integrity$
DECLARE
  c a8b6_counts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM a8b6_counts;
  IF c.trips IS DISTINCT FROM (SELECT count(*)::int FROM public.trips)
     OR c.ride_offers IS DISTINCT FROM (SELECT count(*)::int FROM public.ride_offers)
     OR c.notifications IS DISTINCT FROM (SELECT count(*)::int FROM public.notifications)
     OR c.booking_delivery_log IS DISTINCT FROM (SELECT count(*)::int FROM public.booking_delivery_log)
     OR c.drivers IS DISTINCT FROM (SELECT count(*)::int FROM public.drivers)
     OR c.auth_users IS DISTINCT FROM (SELECT count(*)::int FROM auth.users)
  THEN
    RAISE EXCEPTION 'A8B6 integrity drift during ACL simulation';
  END IF;
END;
$integrity$;

GRANT EXECUTE ON FUNCTION public.allocate_driver_reference(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_driver_reference(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.allocate_trip_reference(uuid, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_trip_reference(uuid, timestamp with time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.assign_trip_number(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_trip_number(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.enrich_ride_offer_presets(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enrich_ride_offer_presets(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_trip_stops_for_assignment(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_trip_stops_for_assignment(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_dispatch_eligibility(uuid, uuid, boolean, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.ops_retry_failed_dispatch(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_retry_failed_dispatch(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.recalculate_driver_display_rating(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_driver_display_rating(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.start_driver_commitment_session(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_driver_commitment_session(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_driver_live_location(uuid, double precision, double precision, text, real, real) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_driver_live_location(uuid, double precision, double precision, text, real, real) TO service_role;

DO $restored$
DECLARE
  r record;
  v_auth int;
BEGIN
  FOR r IN SELECT name, regproc FROM a8b6_expected LOOP
    IF NOT has_function_privilege('authenticated', r.regproc::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B6 restore: authenticated missing EXECUTE on %', r.name;
    END IF;
    IF NOT has_function_privilege('service_role', r.regproc::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B6 restore: service_role missing EXECUTE on %', r.name;
    END IF;
  END LOOP;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth <> 197 THEN
    RAISE EXCEPTION 'A8B6 restore: expected auth SECDEF 197, got %', v_auth;
  END IF;
END;
$restored$;

SELECT 'A8B6_SIMULATION_OK' AS status,
       (SELECT auth_secdef FROM a8b6_counts) AS auth_secdef_before,
       187 AS auth_secdef_after_apply,
       197 AS auth_secdef_after_restore;

ROLLBACK;
