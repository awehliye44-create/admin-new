-- Phase A6 ACL simulation. Applies the draft REVOKEs, probes, then ROLLBACK.
-- Does not invoke the function as service_role or postgres.
-- Authenticated probes use sentinel UUIDs and fail at privilege validation.

BEGIN;

CREATE TEMP TABLE a6_hashes AS
SELECT p.proname, md5(p.prosrc) AS body_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'check_schedule_overlap';

CREATE TEMP TABLE a6_counts AS
SELECT
  (SELECT count(*) FROM public.trips) AS trips,
  (SELECT count(*) FROM public.trips WHERE scheduled_at IS NOT NULL) AS scheduled_trips,
  (SELECT count(*) FROM public.trips
    WHERE status NOT IN ('completed', 'cancelled', 'expired', 'expired_no_driver', 'no_show')
  ) AS nonterminal_trips,
  (SELECT count(*) FROM public.ride_offers) AS ride_offers,
  (SELECT count(*) FROM public.drivers) AS drivers,
  (SELECT count(*) FROM public.notifications) AS notifications,
  (SELECT count(*) FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*) FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger) AS wallet_sum;

REVOKE ALL ON FUNCTION public.check_schedule_overlap(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_schedule_overlap(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.check_schedule_overlap(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.check_schedule_overlap(uuid, uuid) FROM service_role;

DO $acl$
BEGIN
  IF has_function_privilege('authenticated', 'public.check_schedule_overlap(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.check_schedule_overlap(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'public.check_schedule_overlap(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.check_schedule_overlap(uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.check_schedule_overlap(uuid, uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'phase a6 ACL assertion failed';
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
  IF n <> 204 THEN
    RAISE EXCEPTION 'expected authenticated SECURITY DEFINER 204, got %', n;
  END IF;
END;
$auth_secdef$;

DO $wrappers$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.proname <> 'check_schedule_overlap'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND p.prosrc ILIKE '%check_schedule_overlap%';
  IF n <> 0 THEN
    RAISE EXCEPTION 'authenticated SECURITY DEFINER wrapper remains: %', n;
  END IF;
END;
$wrappers$;

DO $auth_probe$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.check_schedule_overlap(
    '00000000-0000-0000-0000-000000000001'::uuid,
    '00000000-0000-0000-0000-000000000002'::uuid
  );
  RAISE EXCEPTION 'authenticated check_schedule_overlap was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_probe$;
RESET ROLE;

DO $anon_probe$
BEGIN
  IF has_function_privilege('anon', 'public.check_schedule_overlap(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon remains able to execute';
  END IF;
END;
$anon_probe$;

DO $hashes$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM a6_hashes h
    JOIN pg_proc p ON p.proname = h.proname
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND md5(p.prosrc) IS DISTINCT FROM h.body_md5
  ) THEN
    RAISE EXCEPTION 'body hash changed';
  END IF;
END;
$hashes$;

DO $counts$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM a6_counts c
    WHERE c.trips IS DISTINCT FROM (SELECT count(*) FROM public.trips)
       OR c.scheduled_trips IS DISTINCT FROM (SELECT count(*) FROM public.trips WHERE scheduled_at IS NOT NULL)
       OR c.ride_offers IS DISTINCT FROM (SELECT count(*) FROM public.ride_offers)
       OR c.drivers IS DISTINCT FROM (SELECT count(*) FROM public.drivers)
       OR c.notifications IS DISTINCT FROM (SELECT count(*) FROM public.notifications)
       OR c.payment_sessions IS DISTINCT FROM (SELECT count(*) FROM public.payment_sessions)
       OR c.wallet_rows IS DISTINCT FROM (SELECT count(*) FROM public.driver_wallet_ledger)
       OR c.wallet_sum IS DISTINCT FROM (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger)
  ) THEN
    RAISE EXCEPTION 'integrity counts changed inside simulation';
  END IF;
END;
$counts$;

ROLLBACK;
