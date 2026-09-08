-- Phase A4: Edge-only Ops and audit RPC EXECUTE lock.
-- NOT APPLIED until explicitly approved.
--
-- Authenticated EXECUTE removed. service_role kept only for proven Edge callers.
-- ops_record_event has no Edge caller, so service_role is removed too.
-- Bodies, signatures, and data are unchanged.

BEGIN;

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

COMMIT;
