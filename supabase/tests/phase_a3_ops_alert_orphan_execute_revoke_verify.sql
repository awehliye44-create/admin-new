-- Phase A3 ACL simulation. Applies the draft REVOKEs, probes, then ROLLBACK.
-- Does not invoke any target as postgres. Does not change Ops data.

BEGIN;

CREATE TEMP TABLE a3_ops_baseline AS
SELECT
  md5(p.prosrc) AS body_md5,
  p.proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('ops_acknowledge_alert', 'ops_resolve_alert', 'ops_suppress_alert');

CREATE TEMP TABLE a3_ops_counts AS
SELECT
  (SELECT count(*) FROM public.ops_alerts) AS alerts,
  (SELECT count(*) FROM public.ops_alerts WHERE status = 'open') AS open_n,
  (SELECT count(*) FROM public.ops_alerts WHERE status = 'resolved') AS resolved_n,
  (SELECT count(*) FROM public.ops_alerts WHERE status = 'suppressed') AS suppressed_n,
  (SELECT count(*) FROM public.ops_alerts WHERE acknowledged_at IS NOT NULL) AS acknowledged_at_n,
  (SELECT count(*) FROM public.ops_alerts WHERE resolved_at IS NOT NULL) AS resolved_at_n,
  (SELECT count(*) FROM public.ops_alerts WHERE suppressed_until IS NOT NULL) AS suppressed_until_n,
  (SELECT count(*) FROM public.ops_events) AS ops_events,
  (SELECT count(*) FROM public.trips) AS trips,
  (SELECT count(*) FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*) FROM public.payout_items) AS payout_items,
  (SELECT count(*) FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT COALESCE(sum(amount_pence), 0) FROM public.driver_wallet_ledger) AS wallet_sum;

REVOKE ALL ON FUNCTION public.ops_acknowledge_alert(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_acknowledge_alert(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ops_acknowledge_alert(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.ops_acknowledge_alert(uuid, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.ops_resolve_alert(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_resolve_alert(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ops_resolve_alert(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.ops_resolve_alert(uuid, uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.ops_suppress_alert(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_suppress_alert(uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.ops_suppress_alert(uuid, timestamptz) FROM authenticated;
REVOKE ALL ON FUNCTION public.ops_suppress_alert(uuid, timestamptz) FROM service_role;

DO $probe$
DECLARE
  v_missing text;
  v_auth_secdef int;
BEGIN
  IF has_function_privilege('public', 'public.ops_acknowledge_alert(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'public.ops_resolve_alert(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'public.ops_suppress_alert(uuid,timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ops_acknowledge_alert(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ops_resolve_alert(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ops_suppress_alert(uuid,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ops_acknowledge_alert(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ops_resolve_alert(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ops_suppress_alert(uuid,timestamptz)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.ops_acknowledge_alert(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.ops_resolve_alert(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.ops_suppress_alert(uuid,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.ops_acknowledge_alert(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.ops_resolve_alert(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.ops_suppress_alert(uuid,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ops alert acl matrix mismatch';
  END IF;

  SELECT count(*) INTO v_auth_secdef
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_auth_secdef <> 221 THEN
    RAISE EXCEPTION 'authenticated SECURITY DEFINER count % expected 221', v_auth_secdef;
  END IF;

  SELECT string_agg(b.proname, ',')
  INTO v_missing
  FROM a3_ops_baseline b
  JOIN pg_proc p ON p.proname = b.proname
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE md5(p.prosrc) IS DISTINCT FROM b.body_md5;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'ops alert body hash changed: %', v_missing;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM a3_ops_counts c
    WHERE c.alerts IS DISTINCT FROM (SELECT count(*) FROM public.ops_alerts)
       OR c.open_n IS DISTINCT FROM (SELECT count(*) FROM public.ops_alerts WHERE status = 'open')
       OR c.resolved_n IS DISTINCT FROM (SELECT count(*) FROM public.ops_alerts WHERE status = 'resolved')
       OR c.suppressed_n IS DISTINCT FROM (SELECT count(*) FROM public.ops_alerts WHERE status = 'suppressed')
       OR c.acknowledged_at_n IS DISTINCT FROM (SELECT count(*) FROM public.ops_alerts WHERE acknowledged_at IS NOT NULL)
       OR c.resolved_at_n IS DISTINCT FROM (SELECT count(*) FROM public.ops_alerts WHERE resolved_at IS NOT NULL)
       OR c.suppressed_until_n IS DISTINCT FROM (SELECT count(*) FROM public.ops_alerts WHERE suppressed_until IS NOT NULL)
       OR c.ops_events IS DISTINCT FROM (SELECT count(*) FROM public.ops_events)
       OR c.trips IS DISTINCT FROM (SELECT count(*) FROM public.trips)
       OR c.payment_sessions IS DISTINCT FROM (SELECT count(*) FROM public.payment_sessions)
       OR c.payout_items IS DISTINCT FROM (SELECT count(*) FROM public.payout_items)
       OR c.wallet_rows IS DISTINCT FROM (SELECT count(*) FROM public.driver_wallet_ledger)
       OR c.wallet_sum IS DISTINCT FROM (SELECT COALESCE(sum(amount_pence), 0) FROM public.driver_wallet_ledger)
  ) THEN
    RAISE EXCEPTION 'ops alert integrity counts changed inside simulation';
  END IF;
END;
$probe$;

DO $role_ack$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.ops_acknowledge_alert('00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000002'::uuid);
  RAISE EXCEPTION 'authenticated acknowledge was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$role_ack$;
RESET ROLE;

DO $role_res$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.ops_resolve_alert('00000000-0000-0000-0000-000000000003'::uuid, '00000000-0000-0000-0000-000000000004'::uuid);
  RAISE EXCEPTION 'authenticated resolve was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$role_res$;
RESET ROLE;

DO $role_sup$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.ops_suppress_alert('00000000-0000-0000-0000-000000000005'::uuid, now());
  RAISE EXCEPTION 'authenticated suppress was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$role_sup$;
RESET ROLE;

DO $svc_ack$
BEGIN
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.ops_acknowledge_alert('00000000-0000-0000-0000-000000000006'::uuid, '00000000-0000-0000-0000-000000000007'::uuid);
  RAISE EXCEPTION 'service_role acknowledge was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$svc_ack$;
RESET ROLE;

DO $svc_res$
BEGIN
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.ops_resolve_alert('00000000-0000-0000-0000-000000000008'::uuid, '00000000-0000-0000-0000-000000000009'::uuid);
  RAISE EXCEPTION 'service_role resolve was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$svc_res$;
RESET ROLE;

DO $svc_sup$
BEGIN
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.ops_suppress_alert('00000000-0000-0000-0000-000000000010'::uuid, now());
  RAISE EXCEPTION 'service_role suppress was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$svc_sup$;
RESET ROLE;

DO $anon_ack$
BEGIN
  EXECUTE 'SET LOCAL ROLE anon';
  PERFORM public.ops_acknowledge_alert('00000000-0000-0000-0000-000000000011'::uuid, '00000000-0000-0000-0000-000000000012'::uuid);
  RAISE EXCEPTION 'anon acknowledge was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$anon_ack$;
RESET ROLE;

ROLLBACK;
