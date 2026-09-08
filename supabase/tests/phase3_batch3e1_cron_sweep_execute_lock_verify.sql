-- 3E1 ACL simulation only. Applies the corrected matrix, probes, then ROLLBACK.
-- Does not execute cron functions or mutate trip/offer/driver/notification/compliance data.

BEGIN;

REVOKE ALL ON FUNCTION public.expire_stale_drivers(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_drivers(integer) FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_drivers(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_drivers(integer) TO service_role;

REVOKE ALL ON FUNCTION public.expire_stale_drivers_guarded(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_drivers_guarded(integer) FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_drivers_guarded(integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.expire_stale_drivers_guarded(integer) FROM service_role;

REVOKE ALL ON FUNCTION public.ops_cleanup_old_data() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_cleanup_old_data() FROM anon;
REVOKE ALL ON FUNCTION public.ops_cleanup_old_data() FROM authenticated;
REVOKE ALL ON FUNCTION public.ops_cleanup_old_data() FROM service_role;

REVOKE ALL ON FUNCTION public.ride_offer_retry_unacked_push_deliveries() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ride_offer_retry_unacked_push_deliveries() FROM anon;
REVOKE ALL ON FUNCTION public.ride_offer_retry_unacked_push_deliveries() FROM authenticated;
REVOKE ALL ON FUNCTION public.ride_offer_retry_unacked_push_deliveries() FROM service_role;

REVOKE ALL ON FUNCTION public.recalculate_drivers_compliance_london_daily() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_drivers_compliance_london_daily() FROM anon;
REVOKE ALL ON FUNCTION public.recalculate_drivers_compliance_london_daily() FROM authenticated;
REVOKE ALL ON FUNCTION public.recalculate_drivers_compliance_london_daily() FROM service_role;

DO $$
DECLARE
  v_name text;
  v_auth int := 0;
  v_anon int := 0;
  v_public int := 0;
  v_pg_missing int := 0;
  v_child_service boolean;
  v_cron_service int := 0;
  v_jobs int;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'public.expire_stale_drivers(integer)',
    'public.expire_stale_drivers_guarded(integer)',
    'public.ops_cleanup_old_data()',
    'public.ride_offer_retry_unacked_push_deliveries()',
    'public.recalculate_drivers_compliance_london_daily()'
  ]
  LOOP
    IF has_function_privilege('authenticated', v_name::regprocedure, 'EXECUTE') THEN
      v_auth := v_auth + 1;
    END IF;
    IF has_function_privilege('anon', v_name::regprocedure, 'EXECUTE') THEN
      v_anon := v_anon + 1;
    END IF;
    IF has_function_privilege('public', v_name::regprocedure, 'EXECUTE') THEN
      v_public := v_public + 1;
    END IF;
    IF has_function_privilege('postgres', v_name::regprocedure, 'EXECUTE') IS NOT TRUE THEN
      v_pg_missing := v_pg_missing + 1;
    END IF;
  END LOOP;

  v_child_service := has_function_privilege('service_role', 'public.expire_stale_drivers(integer)'::regprocedure, 'EXECUTE');

  FOREACH v_name IN ARRAY ARRAY[
    'public.expire_stale_drivers_guarded(integer)',
    'public.ops_cleanup_old_data()',
    'public.ride_offer_retry_unacked_push_deliveries()',
    'public.recalculate_drivers_compliance_london_daily()'
  ]
  LOOP
    IF has_function_privilege('service_role', v_name::regprocedure, 'EXECUTE') THEN
      v_cron_service := v_cron_service + 1;
    END IF;
  END LOOP;

  IF v_auth <> 0 OR v_anon <> 0 OR v_public <> 0 OR v_pg_missing <> 0
     OR v_child_service IS NOT TRUE OR v_cron_service <> 0 THEN
    RAISE EXCEPTION '3e1 acl failed auth=% anon=% public=% pg_missing=% child_service=% cron_service=%',
      v_auth, v_anon, v_public, v_pg_missing, v_child_service, v_cron_service;
  END IF;

  SELECT count(*) INTO v_jobs
  FROM cron.job
  WHERE jobid IN (63, 6, 59, 35)
    AND username = 'postgres'
    AND active
    AND (
      (jobid = 63 AND schedule = '15 seconds' AND command LIKE '%expire_stale_drivers_guarded(60)%')
      OR (jobid = 6 AND schedule = '0 3 * * *' AND command LIKE '%ops_cleanup_old_data()%')
      OR (jobid = 59 AND schedule = '* * * * *' AND command LIKE '%ride_offer_retry_unacked_push_deliveries()%')
      OR (jobid = 35 AND schedule = '5 0 * * *' AND command LIKE '%recalculate_drivers_compliance_london_daily()%')
    );
  IF v_jobs <> 4 THEN
    RAISE EXCEPTION 'cron definition changed during simulation';
  END IF;
END $$;

SELECT
  (SELECT count(*)
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef_inside_txn,
  pg_get_functiondef('public.expire_stale_drivers_guarded(integer)'::regprocedure) LIKE '%expire_stale_drivers(p_ttl_seconds)%' AS wrapper_still_calls_child,
  has_function_privilege('authenticated', 'public.expire_stale_drivers(integer)'::regprocedure, 'EXECUTE') AS auth_child,
  has_function_privilege('service_role', 'public.expire_stale_drivers(integer)'::regprocedure, 'EXECUTE') AS svc_child,
  has_function_privilege('service_role', 'public.expire_stale_drivers_guarded(integer)'::regprocedure, 'EXECUTE') AS svc_guarded,
  has_function_privilege('service_role', 'public.ops_cleanup_old_data()'::regprocedure, 'EXECUTE') AS svc_cleanup,
  has_function_privilege('service_role', 'public.ride_offer_retry_unacked_push_deliveries()'::regprocedure, 'EXECUTE') AS svc_retry,
  has_function_privilege('service_role', 'public.recalculate_drivers_compliance_london_daily()'::regprocedure, 'EXECUTE') AS svc_compliance,
  has_function_privilege('postgres', 'public.expire_stale_drivers_guarded(integer)'::regprocedure, 'EXECUTE') AS pg_guarded,
  has_function_privilege('postgres', 'public.expire_stale_drivers(integer)'::regprocedure, 'EXECUTE') AS pg_child;

ROLLBACK;
