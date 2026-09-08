-- Rollback Phase A4. Restores the captured baseline ACL:
-- authenticated and service_role EXECUTE on all six.
-- PUBLIC and anon stay denied.
-- Bodies and data are not changed.

BEGIN;

GRANT EXECUTE ON FUNCTION public.ops_resolve_alert_if_cleared(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_resolve_alert_if_cleared(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.ops_upsert_alert(text, text, text, text, text, text, text, uuid, uuid, uuid, uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_upsert_alert(text, text, text, text, text, text, text, uuid, uuid, uuid, uuid, text, text, jsonb) TO service_role;

GRANT EXECUTE ON FUNCTION public.ops_ingest_workflow_event(text, text, text, uuid, uuid, uuid, text, integer, text, text, text, text, text, text, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_ingest_workflow_event(text, text, text, uuid, uuid, uuid, text, integer, text, text, text, text, text, text, jsonb, boolean) TO service_role;

GRANT EXECUTE ON FUNCTION public.ops_record_event(text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, integer, text, text, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_record_event(text, text, text, text, uuid, uuid, uuid, uuid, uuid, uuid, integer, text, text, jsonb, boolean) TO service_role;

GRANT EXECUTE ON FUNCTION public.ops_run_all_detections() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_run_all_detections() TO service_role;

GRANT EXECUTE ON FUNCTION public.log_audit_event(text, uuid, uuid, uuid, jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_audit_event(text, uuid, uuid, uuid, jsonb, text, text) TO service_role;

COMMIT;
