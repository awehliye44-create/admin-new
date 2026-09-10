-- Phase A8B7 ACL simulation. Privilege/catalog checks only.
-- Does not invoke mutating bodies.

BEGIN;

CREATE TEMP TABLE a8b7_expected (
  name text PRIMARY KEY,
  identity_args text NOT NULL,
  regproc text NOT NULL,
  body_md5 text NOT NULL,
  keep_service_role boolean NOT NULL
);

INSERT INTO a8b7_expected (name, identity_args, regproc, body_md5, keep_service_role) VALUES
  ('lock_driver_vehicle', 'p_driver_id uuid', 'public.lock_driver_vehicle(uuid)', '9fb0e1ee12fe0e7f73f89c1a7182124c', false),
  ('mark_driver_background_unavailable', 'p_driver_id uuid', 'public.mark_driver_background_unavailable(uuid)', 'fc6fb5995c824987744f7ecb7453fe3e', false),
  ('merge_ride_offer_push_log', 'p_offer_id uuid, p_json jsonb', 'public.merge_ride_offer_push_log(uuid, jsonb)', 'c9721691bc6479ebf3e4b77e317b15f6', false),
  ('driver_cancel_negotiation', 'p_offer_id uuid, p_driver_id uuid', 'public.driver_cancel_negotiation(uuid, uuid)', '4e5f4993f4635b2f89edfdefbfca4b14', false),
  ('release_trip_negotiation_lock', 'p_trip_id uuid, p_next_status text', 'public.release_trip_negotiation_lock(uuid, text)', '122cbf5ce8432379d1470f4569b74fd8', false),
  ('stop_driver_commitment_session', 'p_trip_id uuid, p_reason text', 'public.stop_driver_commitment_session(uuid, text)', '45637ce329b5ab08275d9a877e915f59', false),
  ('record_driver_commitment_warning', 'p_session_id uuid, p_warning_type text, p_message text', 'public.record_driver_commitment_warning(uuid, text, text)', '3d9a30faacb484021b089f5ad135b4a9', false),
  ('sync_document_primary_file_url', 'p_document_id uuid', 'public.sync_document_primary_file_url(uuid)', '6fa17caec7ee7c4066972c3d22503de1', false),
  ('log_dispatch_event', 'p_trip_id uuid, p_event_type text, p_round integer, p_driver_id uuid, p_details jsonb', 'public.log_dispatch_event(uuid, text, integer, uuid, jsonb)', '2ac48f877949567711007bc662a4f170', true),
  ('record_dispatch_wave_snapshot', 'p_trip_id uuid, p_dispatch_round integer, p_stage text, p_wave_number integer, p_driver_id uuid, p_source text, p_ride_offer_id uuid, p_metadata jsonb', 'public.record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb)', '66a27adeb0c5bc3be452eb36817e5a27', true);

DO $pre$
BEGIN
  IF (SELECT count(*) FROM a8b7_expected e
      JOIN pg_proc p ON p.proname = e.name
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE md5(p.prosrc) = e.body_md5
        AND pg_get_function_identity_arguments(p.oid) = e.identity_args) <> 10 THEN
    RAISE EXCEPTION 'A8B7 pre: hash/args mismatch or missing signature';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109190000') THEN
    RAISE EXCEPTION 'A8B7 pre: migration already applied';
  END IF;
END;
$pre$;

CREATE TEMP TABLE a8b7_counts AS
SELECT
  (SELECT count(*)::int FROM public.trips) AS trips,
  (SELECT count(*)::int FROM public.ride_offers) AS ride_offers,
  (SELECT count(*)::int FROM public.drivers) AS drivers,
  (SELECT count(*)::int FROM public.customers) AS customers,
  (SELECT count(*)::int FROM public.documents) AS documents,
  (SELECT count(*)::int FROM public.dispatch_audit_log) AS dispatch_audit,
  (SELECT count(*)::int FROM public.dispatch_wave_snapshot) AS wave_snapshots,
  (SELECT count(*)::int FROM public.driver_commitment_sessions) AS commitment_sessions,
  (SELECT count(*)::int FROM public.driver_commitment_warnings) AS commitment_warnings,
  (SELECT count(*)::int FROM public.driver_presence) AS driver_presence,
  (SELECT count(*)::int FROM public.notifications) AS notifications,
  (SELECT count(*)::int FROM public.booking_delivery_log) AS booking_delivery_log,
  (SELECT count(*)::int FROM auth.users) AS auth_users,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef;

-- Apply draft ACL
REVOKE ALL ON FUNCTION public.lock_driver_vehicle(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_driver_vehicle(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.lock_driver_vehicle(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.lock_driver_vehicle(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.mark_driver_background_unavailable(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_driver_background_unavailable(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.mark_driver_background_unavailable(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.mark_driver_background_unavailable(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.merge_ride_offer_push_log(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.merge_ride_offer_push_log(uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.merge_ride_offer_push_log(uuid, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.merge_ride_offer_push_log(uuid, jsonb) FROM service_role;

REVOKE ALL ON FUNCTION public.driver_cancel_negotiation(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_cancel_negotiation(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_cancel_negotiation(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.driver_cancel_negotiation(uuid, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.release_trip_negotiation_lock(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_trip_negotiation_lock(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.release_trip_negotiation_lock(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.release_trip_negotiation_lock(uuid, text) FROM service_role;

REVOKE ALL ON FUNCTION public.stop_driver_commitment_session(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.stop_driver_commitment_session(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.stop_driver_commitment_session(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.stop_driver_commitment_session(uuid, text) FROM service_role;

REVOKE ALL ON FUNCTION public.record_driver_commitment_warning(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_driver_commitment_warning(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_driver_commitment_warning(uuid, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.record_driver_commitment_warning(uuid, text, text) FROM service_role;

REVOKE ALL ON FUNCTION public.sync_document_primary_file_url(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sync_document_primary_file_url(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.sync_document_primary_file_url(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.sync_document_primary_file_url(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.log_dispatch_event(uuid, text, integer, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_dispatch_event(uuid, text, integer, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.log_dispatch_event(uuid, text, integer, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.log_dispatch_event(uuid, text, integer, uuid, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb) TO service_role;

DO $post$
DECLARE
  r record;
  v_auth int;
BEGIN
  FOR r IN SELECT * FROM a8b7_expected LOOP
    IF has_function_privilege('authenticated', r.regproc::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B7 post: authenticated still has EXECUTE on %', r.name;
    END IF;
    IF has_function_privilege('anon', r.regproc::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B7 post: anon has EXECUTE on %', r.name;
    END IF;
    IF r.keep_service_role THEN
      IF NOT has_function_privilege('service_role', r.regproc::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION 'A8B7 post: service_role missing EXECUTE on %', r.name;
      END IF;
    ELSE
      IF has_function_privilege('service_role', r.regproc::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION 'A8B7 post: service_role still has EXECUTE on %', r.name;
      END IF;
    END IF;
    IF NOT has_function_privilege('postgres', r.regproc::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B7 post: postgres missing EXECUTE on %', r.name;
    END IF;
  END LOOP;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth <> 177 THEN
    RAISE EXCEPTION 'A8B7 post: expected auth SECDEF 177, got %', v_auth;
  END IF;

  -- Wrapper parents still callable as postgres SECDEF
  IF NOT has_function_privilege('postgres', 'public.submit_driver_document(uuid, text, date, text, text, bigint, uuid, text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B7 post: postgres cannot execute submit_driver_document';
  END IF;

  -- Bodies unchanged by ACL-only revoke
  FOR r IN SELECT * FROM a8b7_expected LOOP
    IF md5((
      SELECT p.prosrc FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE p.proname = r.name
        AND pg_get_function_identity_arguments(p.oid) = r.identity_args
    )) IS DISTINCT FROM r.body_md5 THEN
      RAISE EXCEPTION 'A8B7 post: body hash changed for %', r.name;
    END IF;
  END LOOP;
END;
$post$;

DO $integrity$
DECLARE c a8b7_counts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM a8b7_counts;
  IF c.trips IS DISTINCT FROM (SELECT count(*)::int FROM public.trips)
     OR c.ride_offers IS DISTINCT FROM (SELECT count(*)::int FROM public.ride_offers)
     OR c.drivers IS DISTINCT FROM (SELECT count(*)::int FROM public.drivers)
     OR c.customers IS DISTINCT FROM (SELECT count(*)::int FROM public.customers)
     OR c.documents IS DISTINCT FROM (SELECT count(*)::int FROM public.documents)
     OR c.dispatch_audit IS DISTINCT FROM (SELECT count(*)::int FROM public.dispatch_audit_log)
     OR c.wave_snapshots IS DISTINCT FROM (SELECT count(*)::int FROM public.dispatch_wave_snapshot)
     OR c.commitment_sessions IS DISTINCT FROM (SELECT count(*)::int FROM public.driver_commitment_sessions)
     OR c.commitment_warnings IS DISTINCT FROM (SELECT count(*)::int FROM public.driver_commitment_warnings)
     OR c.driver_presence IS DISTINCT FROM (SELECT count(*)::int FROM public.driver_presence)
     OR c.notifications IS DISTINCT FROM (SELECT count(*)::int FROM public.notifications)
     OR c.booking_delivery_log IS DISTINCT FROM (SELECT count(*)::int FROM public.booking_delivery_log)
     OR c.auth_users IS DISTINCT FROM (SELECT count(*)::int FROM auth.users)
  THEN
    RAISE EXCEPTION 'A8B7 integrity drift during ACL simulation';
  END IF;
END;
$integrity$;

-- Restore proven previous ACLs
GRANT EXECUTE ON FUNCTION public.lock_driver_vehicle(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lock_driver_vehicle(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_driver_background_unavailable(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_driver_background_unavailable(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.merge_ride_offer_push_log(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.merge_ride_offer_push_log(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_cancel_negotiation(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_cancel_negotiation(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_trip_negotiation_lock(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_trip_negotiation_lock(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.stop_driver_commitment_session(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stop_driver_commitment_session(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_driver_commitment_warning(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_driver_commitment_warning(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.sync_document_primary_file_url(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_document_primary_file_url(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.log_dispatch_event(uuid, text, integer, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_dispatch_event(uuid, text, integer, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_dispatch_wave_snapshot(uuid, integer, text, integer, uuid, text, uuid, jsonb) TO service_role;

DO $restored$
DECLARE
  r record;
  v_auth int;
BEGIN
  FOR r IN SELECT * FROM a8b7_expected LOOP
    IF NOT has_function_privilege('authenticated', r.regproc::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B7 restore: authenticated missing on %', r.name;
    END IF;
    IF NOT has_function_privilege('service_role', r.regproc::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8B7 restore: service_role missing on %', r.name;
    END IF;
  END LOOP;
  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth <> 187 THEN
    RAISE EXCEPTION 'A8B7 restore: expected auth SECDEF 187, got %', v_auth;
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109190000') THEN
    RAISE EXCEPTION 'A8B7 restore: migration version unexpectedly present';
  END IF;
END;
$restored$;

SELECT 'A8B7_SIMULATION_OK' AS status,
       (SELECT auth_secdef FROM a8b7_counts) AS auth_secdef_before,
       177 AS auth_secdef_after_apply,
       187 AS auth_secdef_after_restore;

ROLLBACK;
