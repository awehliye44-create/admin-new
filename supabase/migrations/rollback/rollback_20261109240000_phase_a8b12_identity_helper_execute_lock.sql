-- Rollback Phase A8B12. Restores proven prior ACLs only.
-- Does not grant PUBLIC or anon.
-- Does not alter function bodies or production data.

BEGIN;

-- EDGE_SERVICE_ONLY → restore authenticated + service_role
GRANT EXECUTE ON FUNCTION public.check_email_available_for_change(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_email_available_for_change(text, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.check_phone_available_for_change(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.check_phone_available_for_change(uuid, text, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.staff_has_action(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_has_action(uuid, text) TO service_role;

-- POSTGRES_INTERNAL_ONLY → restore authenticated + service_role
GRANT EXECUTE ON FUNCTION public.phone_is_pending_reserved(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phone_is_pending_reserved(text, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.phone_is_verified_protected(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phone_is_verified_protected(text, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.haversine_meters(double precision, double precision, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.haversine_meters(double precision, double precision, double precision, double precision) TO service_role;

GRANT EXECUTE ON FUNCTION public.dispatch_max_driver_find_minutes(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_max_driver_find_minutes(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.log_driver_availability_event(uuid, text, text, boolean, boolean, boolean, boolean, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_driver_availability_event(uuid, text, text, boolean, boolean, boolean, boolean, jsonb, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.assert_driver_presence_online_eligible(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_driver_presence_online_eligible(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.recalculate_driver_documents_approved(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_driver_documents_approved(uuid) TO service_role;

COMMIT;
