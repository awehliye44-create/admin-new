-- Phase A5 ACL simulation. Applies the draft REVOKEs, probes, then ROLLBACK.
-- Does not invoke any target as service_role or postgres.
-- Table-returning and mutating functions are reached only as authenticated after REVOKE,
-- so privilege validation fails before the body runs.

BEGIN;

CREATE TEMP TABLE a5_hashes AS
SELECT p.proname, md5(p.prosrc) AS body_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'resolve_active_company_operational_reserve',
    'resolve_active_company_operational_reserve_prefer_sa',
    'resolve_service_area_outbound_caller_id',
    'resolve_service_area_communication',
    'get_p95_action_metrics',
    'get_p95_screen_metrics',
    'get_performance_baseline_verdicts',
    'get_performance_p95',
    'record_push_send_result',
    'generate_lost_property_case_number'
  );

CREATE TEMP TABLE a5_counts AS
SELECT
  (SELECT count(*) FROM public.company_operational_refund_reserves) AS reserves,
  (SELECT count(*) FROM public.service_area_communication_settings) AS sa_comm,
  (SELECT count(*) FROM public.service_area_call_masking_config) AS masking_cfg,
  (SELECT count(*) FROM public.app_performance_events) AS perf_events,
  (SELECT count(*) FROM public.app_performance_baselines) AS perf_baselines,
  (SELECT count(*) FROM public.app_performance_thresholds) AS perf_thresholds,
  (SELECT count(*) FROM public.push_tokens) AS push_tokens,
  (SELECT count(*) FROM public.push_tokens WHERE is_active IS TRUE) AS push_active,
  (SELECT count(*) FROM public.customer_push_tokens) AS customer_push,
  (SELECT count(*) FROM public.lost_property_cases) AS lost_cases,
  (SELECT count(*) FROM public.lost_property_sequences) AS lp_seq_rows,
  (SELECT coalesce(sum(current_value), 0) FROM public.lost_property_sequences) AS lp_seq_sum,
  (SELECT count(*) FROM public.ops_alerts) AS alerts,
  (SELECT count(*) FROM public.ops_events) AS ops_events,
  (SELECT count(*) FROM public.ops_logs) AS ops_logs,
  (SELECT count(*) FROM public.trips) AS trips,
  (SELECT count(*) FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*) FROM public.payout_items) AS payout_items,
  (SELECT count(*) FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger) AS wallet_sum,
  (SELECT count(*) FROM public.notifications) AS notifications,
  (SELECT count(*) FROM auth.users) AS auth_users;

REVOKE ALL ON FUNCTION public.resolve_active_company_operational_reserve_prefer_sa(uuid, text, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_active_company_operational_reserve_prefer_sa(uuid, text, timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_active_company_operational_reserve_prefer_sa(uuid, text, timestamp with time zone) FROM authenticated;

REVOKE ALL ON FUNCTION public.get_performance_p95(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_performance_p95(text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_performance_p95(text, integer) FROM authenticated;

REVOKE ALL ON FUNCTION public.generate_lost_property_case_number(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.generate_lost_property_case_number(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.generate_lost_property_case_number(uuid) FROM authenticated;

REVOKE ALL ON FUNCTION public.resolve_active_company_operational_reserve(uuid, text, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_active_company_operational_reserve(uuid, text, timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_active_company_operational_reserve(uuid, text, timestamp with time zone) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_active_company_operational_reserve(uuid, text, timestamp with time zone) FROM service_role;

REVOKE ALL ON FUNCTION public.resolve_service_area_outbound_caller_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_service_area_outbound_caller_id(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_service_area_outbound_caller_id(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_service_area_outbound_caller_id(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.resolve_service_area_communication(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_service_area_communication(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_service_area_communication(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.resolve_service_area_communication(uuid) FROM service_role;

REVOKE ALL ON FUNCTION public.get_p95_action_metrics(text, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_p95_action_metrics(text, integer, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.get_p95_action_metrics(text, integer, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_p95_action_metrics(text, integer, text, text) FROM service_role;

REVOKE ALL ON FUNCTION public.get_p95_screen_metrics(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_p95_screen_metrics(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.get_p95_screen_metrics(text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_p95_screen_metrics(text, text) FROM service_role;

REVOKE ALL ON FUNCTION public.get_performance_baseline_verdicts(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_performance_baseline_verdicts(text) FROM anon;
REVOKE ALL ON FUNCTION public.get_performance_baseline_verdicts(text) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_performance_baseline_verdicts(text) FROM service_role;

REVOKE ALL ON FUNCTION public.record_push_send_result(text, boolean, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_push_send_result(text, boolean, text, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.record_push_send_result(text, boolean, text, text, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.record_push_send_result(text, boolean, text, text, jsonb) FROM service_role;

DO $acl$
BEGIN
  IF has_function_privilege('authenticated', 'public.resolve_active_company_operational_reserve_prefer_sa(uuid, text, timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_performance_p95(text, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.generate_lost_property_case_number(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_active_company_operational_reserve(uuid, text, timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_service_area_outbound_caller_id(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_service_area_communication(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_p95_action_metrics(text, integer, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_p95_screen_metrics(text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_performance_baseline_verdicts(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_push_send_result(text, boolean, text, text, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.resolve_active_company_operational_reserve_prefer_sa(uuid, text, timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.record_push_send_result(text, boolean, text, text, jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.resolve_active_company_operational_reserve(uuid, text, timestamp with time zone)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.resolve_service_area_outbound_caller_id(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.resolve_service_area_communication(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.get_p95_action_metrics(text, integer, text, text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.get_p95_screen_metrics(text, text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.get_performance_baseline_verdicts(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.resolve_active_company_operational_reserve_prefer_sa(uuid, text, timestamp with time zone)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_performance_p95(text, integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.generate_lost_property_case_number(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.record_push_send_result(text, boolean, text, text, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.generate_lost_property_case_number(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'phase a5 ACL assertion failed';
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
  IF n <> 205 THEN
    RAISE EXCEPTION 'expected authenticated SECURITY DEFINER 205, got %', n;
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
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AND (
      p.prosrc ILIKE '%resolve_active_company_operational_reserve%'
      OR p.prosrc ILIKE '%resolve_service_area_outbound_caller_id%'
      OR p.prosrc ILIKE '%resolve_service_area_communication%'
      OR p.prosrc ILIKE '%get_p95_action_metrics%'
      OR p.prosrc ILIKE '%get_p95_screen_metrics%'
      OR p.prosrc ILIKE '%get_performance_baseline_verdicts%'
      OR p.prosrc ILIKE '%get_performance_p95%'
      OR p.prosrc ILIKE '%record_push_send_result%'
      OR p.prosrc ILIKE '%generate_lost_property_case_number%'
    );
  IF n <> 0 THEN
    RAISE EXCEPTION 'authenticated SECURITY DEFINER wrapper remains: %', n;
  END IF;
END;
$wrappers$;

DO $auth_prefer$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.resolve_active_company_operational_reserve_prefer_sa(
    '00000000-0000-0000-0000-000000000001'::uuid, 'GBP', now()
  );
  RAISE EXCEPTION 'authenticated prefer_sa was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_prefer$;
RESET ROLE;

DO $auth_p95$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.get_performance_p95('probe', 1);
  RAISE EXCEPTION 'authenticated get_performance_p95 was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_p95$;
RESET ROLE;

DO $auth_case$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.generate_lost_property_case_number('00000000-0000-0000-0000-000000000001'::uuid);
  RAISE EXCEPTION 'authenticated generate_lost_property_case_number was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_case$;
RESET ROLE;

DO $auth_reserve$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.resolve_active_company_operational_reserve(
    '00000000-0000-0000-0000-000000000001'::uuid, 'GBP', now()
  );
  RAISE EXCEPTION 'authenticated reserve was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_reserve$;
RESET ROLE;

DO $auth_caller$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.resolve_service_area_outbound_caller_id('00000000-0000-0000-0000-000000000001'::uuid);
  RAISE EXCEPTION 'authenticated outbound caller id was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_caller$;
RESET ROLE;

DO $auth_comm$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.resolve_service_area_communication('00000000-0000-0000-0000-000000000001'::uuid);
  RAISE EXCEPTION 'authenticated communication was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_comm$;
RESET ROLE;

DO $auth_action$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.get_p95_action_metrics('probe', 1, NULL, NULL);
  RAISE EXCEPTION 'authenticated get_p95_action_metrics was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_action$;
RESET ROLE;

DO $auth_screen$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.get_p95_screen_metrics('probe', 'probe');
  RAISE EXCEPTION 'authenticated get_p95_screen_metrics was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_screen$;
RESET ROLE;

DO $auth_verdict$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.get_performance_baseline_verdicts('probe');
  RAISE EXCEPTION 'authenticated get_performance_baseline_verdicts was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_verdict$;
RESET ROLE;

DO $auth_push$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.record_push_send_result('probe-token-does-not-exist', false, 'probe', 'probe', '{}'::jsonb);
  RAISE EXCEPTION 'authenticated record_push_send_result was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_push$;
RESET ROLE;

DO $hashes$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM a5_hashes h
    JOIN pg_proc p ON p.proname = h.proname
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND md5(p.prosrc) IS DISTINCT FROM h.body_md5
  ) THEN
    RAISE EXCEPTION 'body hash changed';
  END IF;
END;
$hashes$;

ROLLBACK;
