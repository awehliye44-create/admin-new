-- Post-apply privilege checks for
-- 20261112140000_phase_dispatch_helper_execute_revoke.sql
--
-- Read-only. Does not call any target function. Does not send
-- notifications, push, or HTTP.

\set ON_ERROR_STOP on
\pset pager off

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('resolve_negotiation_rebroadcast_fare(uuid)', false, '2664298503ff256bdf8923ff6519bb51'),
      ('ride_offer_dispatch_push_delivery(uuid, boolean)', false, '659c1732319068fe4ffe92e0714c3bc4'),
      ('ride_offer_enqueue_reminders(uuid)', false, '4ef226fb3830a6f960f0857ea4c894d6'),
      ('resolve_zone_surge(uuid, double precision, double precision)', true, '37b7e80e4f44d23142a4d5bddabd5680')
    ) AS expected(sig, service_ok, body_md5)
  LOOP
    IF has_function_privilege('public', ('public.' || r.sig)::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', ('public.' || r.sig)::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', ('public.' || r.sig)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% still executable by PUBLIC, anon, or authenticated', r.sig;
    END IF;
    IF NOT has_function_privilege('postgres', ('public.' || r.sig)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% lost postgres EXECUTE', r.sig;
    END IF;
    IF has_function_privilege('service_role', ('public.' || r.sig)::regprocedure, 'EXECUTE') IS DISTINCT FROM r.service_ok THEN
      RAISE EXCEPTION '% service_role EXECUTE expected %', r.sig, r.service_ok;
    END IF;
    IF md5((SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.oid = ('public.' || r.sig)::regprocedure)) <> r.body_md5 THEN
      RAISE EXCEPTION '% body md5 changed', r.sig;
    END IF;
  END LOOP;

  IF NOT (
    SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
      AND p.prosrc LIKE '%resolve_negotiation_rebroadcast_fare(%'
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'finalize_negotiation_failure'
  ) THEN
    RAISE EXCEPTION 'finalize_negotiation_failure parent closure broken';
  END IF;

  IF NOT (
    SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
      AND p.prosrc LIKE '%ride_offer_dispatch_push_delivery(%'
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'tr_send_push_on_ride_offer_insert'
  ) THEN
    RAISE EXCEPTION 'push trigger parent closure broken';
  END IF;

  IF NOT (
    SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
      AND p.prosrc LIKE '%ride_offer_dispatch_push_delivery(%'
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'ride_offer_retry_unacked_push_deliveries'
  ) THEN
    RAISE EXCEPTION 'push cron parent closure broken';
  END IF;
END
$$;
