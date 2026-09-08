-- Phase A4 ACL simulation. Applies the draft REVOKEs, probes, then ROLLBACK.
-- Does not invoke any target as service_role or postgres.

BEGIN;

CREATE TEMP TABLE a4_hashes AS
SELECT p.proname, md5(p.prosrc) AS body_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'ops_resolve_alert_if_cleared',
    'ops_upsert_alert',
    'ops_ingest_workflow_event',
    'ops_record_event',
    'ops_run_all_detections',
    'log_audit_event'
  );

CREATE TEMP TABLE a4_counts AS
SELECT
  (SELECT count(*) FROM public.ops_alerts) AS alerts,
  (SELECT count(*) FROM public.ops_alerts WHERE status = 'open') AS open_n,
  (SELECT count(*) FROM public.ops_alerts WHERE status = 'resolved') AS resolved_n,
  (SELECT count(*) FROM public.ops_alerts WHERE status = 'suppressed') AS suppressed_n,
  (SELECT count(*) FROM public.ops_events) AS ops_events,
  (SELECT count(*) FROM public.ops_logs) AS ops_logs,
  (SELECT count(*) FROM public.audit_logs) AS audit_logs,
  (SELECT count(*) FROM public.trips) AS trips,
  (SELECT count(*) FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*) FROM public.payout_items) AS payout_items,
  (SELECT count(*) FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT COALESCE(sum(amount_pence), 0) FROM public.driver_wallet_ledger) AS wallet_sum,
  (SELECT count(*) FROM public.notifications) AS notifications,
  (SELECT count(*) FROM auth.users) AS auth_users;

REVOKE ALL ON FUNCTION public.ops_resolve_alert_if_cleared(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_resolve_alert_if_cleared(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ops_resolve_alert_if_cleared(uuid) FROM authenticated;

REVOKE ALL ON FUNCTION public.ops_upsert_alert(text, text, text, text, text, text, text, uuid, uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_upsert_alert(text, text, text, text, text, text, text, uuid, uuid, uuid, uuid, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.ops_upsert_alert(text, text, text, text, text, text, text, uuid, uuid, uuid, uuid, text, text, jsonb) FROM authenticated;

REVOKE ALL ON FUNCTION public.ops_ingest_workflow_event(text, text, text, uuid, uuid, uuid, text, integer, text, text, text, text, text, text, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_ingest_workflow_event(text, text, text, uuid, uuid, uuid, text, integer, text, text, text, text, text, text, jsonb, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.ops_ingest_workflow_event(text, text, text, uuid, uuid, uuid, text, integer, text, text, text, text, text, text, jsonb, boolean) FROM authenticated;

REVOKE ALL ON FUNCTION public.ops_record_event(text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, integer, text, text, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_record_event(text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, integer, text, text, jsonb, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.ops_record_event(text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, integer, text, text, jsonb, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public.ops_record_event(text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, integer, text, text, jsonb, boolean) FROM service_role;

REVOKE ALL ON FUNCTION public.ops_run_all_detections() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_run_all_detections() FROM anon;
REVOKE ALL ON FUNCTION public.ops_run_all_detections() FROM authenticated;

REVOKE ALL ON FUNCTION public.log_audit_event(text, uuid, uuid, uuid, jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_audit_event(text, uuid, uuid, uuid, jsonb, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.log_audit_event(text, uuid, uuid, uuid, jsonb, text, text) FROM authenticated;

DO $matrix$
DECLARE
  v_auth int;
  v_missing text;
BEGIN
  IF has_function_privilege('authenticated', 'public.ops_resolve_alert_if_cleared(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ops_upsert_alert(text, text, text, text, text, text, text, uuid, uuid, uuid, uuid, text, text, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ops_ingest_workflow_event(text, text, text, uuid, uuid, uuid, text, integer, text, text, text, text, text, text, jsonb, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ops_record_event(text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, integer, text, text, jsonb, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ops_run_all_detections()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.log_audit_event(text, uuid, uuid, uuid, jsonb, text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ops_resolve_alert_if_cleared(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.ops_record_event(text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, integer, text, text, jsonb, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.ops_resolve_alert_if_cleared(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.ops_upsert_alert(text, text, text, text, text, text, text, uuid, uuid, uuid, uuid, text, text, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.ops_ingest_workflow_event(text, text, text, uuid, uuid, uuid, text, integer, text, text, text, text, text, text, jsonb, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.ops_run_all_detections()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.log_audit_event(text, uuid, uuid, uuid, jsonb, text, text)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.ops_resolve_alert_if_cleared(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.ops_upsert_alert(text, text, text, text, text, text, text, uuid, uuid, uuid, uuid, text, text, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.ops_ingest_workflow_event(text, text, text, uuid, uuid, uuid, text, integer, text, text, text, text, text, text, jsonb, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.ops_record_event(text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, integer, text, text, jsonb, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.ops_run_all_detections()', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.log_audit_event(text, uuid, uuid, uuid, jsonb, text, text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'phase a4 acl matrix mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
      AND p.proname NOT IN (
        'ops_resolve_alert_if_cleared',
        'ops_upsert_alert',
        'ops_ingest_workflow_event',
        'ops_record_event',
        'ops_run_all_detections',
        'log_audit_event'
      )
      AND (
        p.prosrc ILIKE '%ops_upsert_alert%'
        OR p.prosrc ILIKE '%ops_record_event%'
        OR p.prosrc ILIKE '%ops_ingest_workflow_event%'
        OR p.prosrc ILIKE '%log_audit_event%'
      )
  ) THEN
    RAISE EXCEPTION 'authenticated security definer wrapper still reaches a target';
  END IF;

  SELECT count(*) INTO v_auth
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_auth <> 215 THEN
    RAISE EXCEPTION 'authenticated SECURITY DEFINER count % expected 215', v_auth;
  END IF;

  SELECT string_agg(h.proname, ',')
  INTO v_missing
  FROM a4_hashes h
  JOIN pg_proc p ON p.proname = h.proname
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE md5(p.prosrc) IS DISTINCT FROM h.body_md5;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'body hash changed: %', v_missing;
  END IF;

  IF EXISTS (
    SELECT 1 FROM a4_counts c
    WHERE c.alerts IS DISTINCT FROM (SELECT count(*) FROM public.ops_alerts)
       OR c.open_n IS DISTINCT FROM (SELECT count(*) FROM public.ops_alerts WHERE status = 'open')
       OR c.resolved_n IS DISTINCT FROM (SELECT count(*) FROM public.ops_alerts WHERE status = 'resolved')
       OR c.suppressed_n IS DISTINCT FROM (SELECT count(*) FROM public.ops_alerts WHERE status = 'suppressed')
       OR c.ops_events IS DISTINCT FROM (SELECT count(*) FROM public.ops_events)
       OR c.ops_logs IS DISTINCT FROM (SELECT count(*) FROM public.ops_logs)
       OR c.audit_logs IS DISTINCT FROM (SELECT count(*) FROM public.audit_logs)
       OR c.trips IS DISTINCT FROM (SELECT count(*) FROM public.trips)
       OR c.payment_sessions IS DISTINCT FROM (SELECT count(*) FROM public.payment_sessions)
       OR c.payout_items IS DISTINCT FROM (SELECT count(*) FROM public.payout_items)
       OR c.wallet_rows IS DISTINCT FROM (SELECT count(*) FROM public.driver_wallet_ledger)
       OR c.wallet_sum IS DISTINCT FROM (SELECT COALESCE(sum(amount_pence), 0) FROM public.driver_wallet_ledger)
       OR c.notifications IS DISTINCT FROM (SELECT count(*) FROM public.notifications)
       OR c.auth_users IS DISTINCT FROM (SELECT count(*) FROM auth.users)
  ) THEN
    RAISE EXCEPTION 'integrity counts changed inside simulation';
  END IF;
END;
$matrix$;

DO $auth_resolve$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.ops_resolve_alert_if_cleared('00000000-0000-0000-0000-000000000001'::uuid);
  RAISE EXCEPTION 'authenticated resolve_if_cleared was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_resolve$;
RESET ROLE;

DO $auth_upsert$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.ops_upsert_alert('probe', 'ops', 'info', 'probe', 'backend', 'probe', 'probe', NULL, NULL, NULL, NULL, NULL, NULL, '{}'::jsonb);
  RAISE EXCEPTION 'authenticated upsert was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_upsert$;
RESET ROLE;

DO $auth_ingest$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.ops_ingest_workflow_event('probe', 'backend', 'info', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'probe', '{}'::jsonb, false);
  RAISE EXCEPTION 'authenticated ingest was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_ingest$;
RESET ROLE;

DO $auth_record$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.ops_record_event('probe', 'ops', 'info', 'backend', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'probe', '{}'::jsonb, false);
  RAISE EXCEPTION 'authenticated record was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_record$;
RESET ROLE;

DO $auth_run$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.ops_run_all_detections();
  RAISE EXCEPTION 'authenticated run_all_detections was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_run$;
RESET ROLE;

DO $auth_audit$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.log_audit_event('probe', NULL, NULL, NULL, '{}'::jsonb, NULL, NULL);
  RAISE EXCEPTION 'authenticated log_audit_event was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_audit$;
RESET ROLE;

ROLLBACK;
