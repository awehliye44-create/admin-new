-- Rollback Phase A3 Ops Alert client EXECUTE retirement.
-- Restores the captured baseline ACL only:
-- authenticated and service_role EXECUTE.
-- PUBLIC and anon stay denied.
-- Function bodies, signatures, and Ops data are not changed.

BEGIN;

GRANT EXECUTE ON FUNCTION public.ops_acknowledge_alert(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_acknowledge_alert(uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.ops_resolve_alert(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_resolve_alert(uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.ops_suppress_alert(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_suppress_alert(uuid, timestamptz) TO service_role;

COMMIT;
