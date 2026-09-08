-- Phase A3: retire client EXECUTE on orphan Ops Alert RPCs.
-- NOT APPLIED until explicitly approved.
--
-- OpsAlertDetail.tsx is dormant and not mounted. No Admin route, sidebar,
-- app, Edge, cron, trigger, view, or SQL wrapper calls these functions.
-- No service_role caller exists. ACL only: bodies, signatures, and data unchanged.

BEGIN;

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

COMMIT;
