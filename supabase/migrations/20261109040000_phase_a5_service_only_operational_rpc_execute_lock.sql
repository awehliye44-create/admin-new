-- Phase A5: service-only operational RPC EXECUTE lock.
-- NOT APPLIED until explicitly approved.
--
-- Authenticated EXECUTE removed on all ten signatures.
-- service_role kept only for proven direct Edge callers.
-- Bodies, signatures, and data are unchanged.

BEGIN;

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

COMMIT;
