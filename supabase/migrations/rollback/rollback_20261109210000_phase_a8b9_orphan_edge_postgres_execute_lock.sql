-- EMERGENCY ROLLBACK for 20261109210000_phase_a8b9_orphan_edge_postgres_execute_lock.sql
-- Restores the proven pre-change grants: authenticated + service_role EXECUTE.
-- Does not grant PUBLIC or anon. Does not alter bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.get_active_stop_waiting(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_stop_waiting(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.is_user_suspended(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_suspended(uuid, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_cancel_before_start_rematch(uuid, uuid, text, text, jsonb) TO service_role;

GRANT EXECUTE ON FUNCTION public.is_driver_dispatchable(uuid, integer, boolean, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_driver_dispatchable(uuid, integer, boolean, integer) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_customer_trip_stats(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_trip_stats(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.staff_role_of(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.staff_role_of(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.towards_destination_complete_session(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_complete_session(uuid, text) TO service_role;

GRANT EXECUTE ON FUNCTION public.towards_destination_maybe_complete_on_location(uuid, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_maybe_complete_on_location(uuid, double precision, double precision) TO service_role;

GRANT EXECUTE ON FUNCTION public.compute_ride_offer_preset_options(trips) TO authenticated;
GRANT EXECUTE ON FUNCTION public.compute_ride_offer_preset_options(trips) TO service_role;

COMMIT;
