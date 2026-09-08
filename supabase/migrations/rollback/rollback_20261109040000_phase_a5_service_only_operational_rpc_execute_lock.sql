-- Rollback Phase A5. Restores the captured baseline ACL:
-- authenticated and service_role EXECUTE on all ten.
-- PUBLIC and anon stay denied.
-- Bodies and data are not changed.

BEGIN;

GRANT EXECUTE ON FUNCTION public.resolve_active_company_operational_reserve_prefer_sa(uuid, text, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_active_company_operational_reserve_prefer_sa(uuid, text, timestamp with time zone) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_performance_p95(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_performance_p95(text, integer) TO service_role;

GRANT EXECUTE ON FUNCTION public.generate_lost_property_case_number(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_lost_property_case_number(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.resolve_active_company_operational_reserve(uuid, text, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_active_company_operational_reserve(uuid, text, timestamp with time zone) TO service_role;

GRANT EXECUTE ON FUNCTION public.resolve_service_area_outbound_caller_id(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_service_area_outbound_caller_id(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.resolve_service_area_communication(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_service_area_communication(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_p95_action_metrics(text, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_p95_action_metrics(text, integer, text, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_p95_screen_metrics(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_p95_screen_metrics(text, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_performance_baseline_verdicts(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_performance_baseline_verdicts(text) TO service_role;

GRANT EXECUTE ON FUNCTION public.record_push_send_result(text, boolean, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_push_send_result(text, boolean, text, text, jsonb) TO service_role;

COMMIT;
