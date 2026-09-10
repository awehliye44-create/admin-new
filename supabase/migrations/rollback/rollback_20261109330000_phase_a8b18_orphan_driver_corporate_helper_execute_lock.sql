-- EMERGENCY ROLLBACK for 20261109330000_phase_a8b18_orphan_driver_corporate_helper_execute_lock.sql
-- Restores only grants present in the captured production baseline.
-- Does not broaden grants beyond that baseline. Does not alter bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.list_driver_trip_history(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_driver_trip_history(integer) TO service_role;

GRANT EXECUTE ON FUNCTION public.create_driver_vehicle(uuid, text, text, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_driver_vehicle(uuid, text, text, integer, text, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_driver_feedback_analytics(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_feedback_analytics(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_corporate_account_service_area(uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_booking_quote_inputs(double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_booking_quote_inputs(double precision, double precision) TO service_role;

COMMIT;
