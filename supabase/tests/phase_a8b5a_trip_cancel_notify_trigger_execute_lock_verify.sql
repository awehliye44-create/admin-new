-- Phase A8B5A ACL simulation. Privilege/catalog checks only.
-- Does not invoke either function, update trips, or create pg_net requests.

BEGIN;

CREATE TEMP TABLE a8b5a_hash AS
SELECT p.proname, md5(p.prosrc) AS body_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('notify_drivers_trip_cancelled', 'tr_trips_notify_cancel');

CREATE TEMP TABLE a8b5a_trigger AS
SELECT t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS trigger_def
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
WHERE t.tgname = 'tr_trips_notify_cancel'
  AND NOT t.tgisinternal;

CREATE TEMP TABLE a8b5a_counts AS
SELECT
  (SELECT count(*) FROM public.trips) AS trips,
  (SELECT count(*) FROM public.ride_offers) AS ride_offers,
  (SELECT count(*) FROM public.notifications) AS notifications,
  (SELECT count(*) FROM public.dispatch_wave_snapshots) AS dispatch_snapshots,
  (SELECT count(*) FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*) FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger) AS wallet_signed_sum,
  (SELECT count(*) FROM auth.users) AS auth_users,
  (SELECT count(*) FROM net._http_response) AS http_response_rows,
  (SELECT count(*) FROM net.http_request_queue) AS http_request_queue_rows;

DO $pre$
BEGIN
  IF (SELECT body_md5 FROM a8b5a_hash WHERE proname = 'notify_drivers_trip_cancelled')
       IS DISTINCT FROM '0c923cde1a7b60f5c9f136bb6b0c2453'
     OR (SELECT body_md5 FROM a8b5a_hash WHERE proname = 'tr_trips_notify_cancel')
       IS DISTINCT FROM 'a4cd384dbea750f9ac0d42def8a31f0b'
  THEN
    RAISE EXCEPTION 'unexpected production body hash before simulation';
  END IF;

  IF has_function_privilege('authenticated', 'public.notify_drivers_trip_cancelled(uuid, text)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', 'public.notify_drivers_trip_cancelled(uuid, text)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('postgres', 'public.notify_drivers_trip_cancelled(uuid, text)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('public', 'public.notify_drivers_trip_cancelled(uuid, text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.notify_drivers_trip_cancelled(uuid, text)'::regprocedure, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'unexpected notify baseline ACL';
  END IF;

  -- Trigger fn: authenticated already denied; service_role + postgres allowed.
  IF has_function_privilege('authenticated', 'public.tr_trips_notify_cancel()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', 'public.tr_trips_notify_cancel()'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('postgres', 'public.tr_trips_notify_cancel()'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('public', 'public.tr_trips_notify_cancel()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.tr_trips_notify_cancel()'::regprocedure, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'unexpected trigger-fn baseline ACL';
  END IF;

  IF (SELECT tgenabled FROM a8b5a_trigger) IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'trigger not normally enabled before simulation';
  END IF;
END;
$pre$;

REVOKE ALL ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) FROM service_role;

REVOKE ALL ON FUNCTION public.tr_trips_notify_cancel() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_trips_notify_cancel() FROM anon;
REVOKE ALL ON FUNCTION public.tr_trips_notify_cancel() FROM authenticated;
REVOKE ALL ON FUNCTION public.tr_trips_notify_cancel() FROM service_role;

DO $acl$
BEGIN
  IF has_function_privilege('public', 'public.notify_drivers_trip_cancelled(uuid, text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.notify_drivers_trip_cancelled(uuid, text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.notify_drivers_trip_cancelled(uuid, text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', 'public.notify_drivers_trip_cancelled(uuid, text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('postgres', 'public.notify_drivers_trip_cancelled(uuid, text)'::regprocedure, 'EXECUTE') IS NOT TRUE
  THEN
    RAISE EXCEPTION 'notify ACL assertion failed';
  END IF;

  IF has_function_privilege('public', 'public.tr_trips_notify_cancel()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.tr_trips_notify_cancel()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tr_trips_notify_cancel()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', 'public.tr_trips_notify_cancel()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('postgres', 'public.tr_trips_notify_cancel()'::regprocedure, 'EXECUTE') IS NOT TRUE
  THEN
    RAISE EXCEPTION 'trigger-fn ACL assertion failed';
  END IF;
END;
$acl$;

DO $auth_secdef$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF n <> 197 THEN
    RAISE EXCEPTION 'expected authenticated SECURITY DEFINER 197, got %', n;
  END IF;
END;
$auth_secdef$;

DO $hashes$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM a8b5a_hash h
    JOIN pg_proc p ON p.proname = h.proname
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND md5(p.prosrc) IS DISTINCT FROM h.body_md5
  ) THEN
    RAISE EXCEPTION 'body hash changed';
  END IF;
END;
$hashes$;

DO $trigger_unchanged$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM a8b5a_trigger a
    JOIN pg_trigger t ON t.tgname = a.tgname AND NOT t.tgisinternal
    WHERE t.tgenabled IS DISTINCT FROM a.tgenabled
       OR pg_get_triggerdef(t.oid) IS DISTINCT FROM a.trigger_def
  ) THEN
    RAISE EXCEPTION 'trigger definition or enabled state changed';
  END IF;
END;
$trigger_unchanged$;

DO $counts$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM a8b5a_counts c
    WHERE c.trips IS DISTINCT FROM (SELECT count(*) FROM public.trips)
       OR c.ride_offers IS DISTINCT FROM (SELECT count(*) FROM public.ride_offers)
       OR c.notifications IS DISTINCT FROM (SELECT count(*) FROM public.notifications)
       OR c.dispatch_snapshots IS DISTINCT FROM (SELECT count(*) FROM public.dispatch_wave_snapshots)
       OR c.payment_sessions IS DISTINCT FROM (SELECT count(*) FROM public.payment_sessions)
       OR c.wallet_rows IS DISTINCT FROM (SELECT count(*) FROM public.driver_wallet_ledger)
       OR c.wallet_signed_sum IS DISTINCT FROM (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger)
       OR c.auth_users IS DISTINCT FROM (SELECT count(*) FROM auth.users)
       OR c.http_response_rows IS DISTINCT FROM (SELECT count(*) FROM net._http_response)
       OR c.http_request_queue_rows IS DISTINCT FROM (SELECT count(*) FROM net.http_request_queue)
  ) THEN
    RAISE EXCEPTION 'integrity counts changed inside simulation';
  END IF;
END;
$counts$;

SELECT
  (SELECT body_md5 FROM a8b5a_hash WHERE proname = 'notify_drivers_trip_cancelled') AS notify_hash,
  (SELECT body_md5 FROM a8b5a_hash WHERE proname = 'tr_trips_notify_cancel') AS trigger_fn_hash,
  has_function_privilege('authenticated', 'public.notify_drivers_trip_cancelled(uuid, text)'::regprocedure, 'EXECUTE') AS notify_auth_exec,
  has_function_privilege('service_role', 'public.notify_drivers_trip_cancelled(uuid, text)'::regprocedure, 'EXECUTE') AS notify_sr_exec,
  has_function_privilege('postgres', 'public.notify_drivers_trip_cancelled(uuid, text)'::regprocedure, 'EXECUTE') AS notify_postgres_exec,
  has_function_privilege('authenticated', 'public.tr_trips_notify_cancel()'::regprocedure, 'EXECUTE') AS trig_auth_exec,
  has_function_privilege('service_role', 'public.tr_trips_notify_cancel()'::regprocedure, 'EXECUTE') AS trig_sr_exec,
  has_function_privilege('postgres', 'public.tr_trips_notify_cancel()'::regprocedure, 'EXECUTE') AS trig_postgres_exec,
  (SELECT tgenabled FROM a8b5a_trigger) AS trigger_enabled,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  (SELECT trips FROM a8b5a_counts) AS trips,
  (SELECT notifications FROM a8b5a_counts) AS notifications,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109160000') AS migration_applied;

ROLLBACK;
