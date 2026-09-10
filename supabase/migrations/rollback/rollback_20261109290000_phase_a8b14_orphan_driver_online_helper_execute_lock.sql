-- EMERGENCY ROLLBACK for 20261109290000_phase_a8b14_orphan_driver_online_helper_execute_lock.sql
-- Restores the proven pre-change grants: authenticated + service_role EXECUTE.
-- Does not broaden grants beyond the production baseline. Does not alter bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.driver_availability_ssot(uuid, integer, integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_availability_ssot(uuid, integer, integer, integer, boolean) TO service_role;

GRANT EXECUTE ON FUNCTION public.driver_effective_online_snapshot(uuid, integer, integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_effective_online_snapshot(uuid, integer, integer, integer, boolean) TO service_role;

GRANT EXECUTE ON FUNCTION public.driver_effective_online_reason(uuid, integer, integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_effective_online_reason(uuid, integer, integer, integer, boolean) TO service_role;

GRANT EXECUTE ON FUNCTION public.driver_freshness_reason(uuid, integer, integer, integer, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_freshness_reason(uuid, integer, integer, integer, boolean) TO service_role;

GRANT EXECUTE ON FUNCTION public.driver_presence_last_signal_at(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_presence_last_signal_at(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.can_modify_trip(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_modify_trip(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ride_offer_is_on_voluntary_decline_cooldown(uuid, uuid, integer) TO service_role;

GRANT EXECUTE ON FUNCTION public.towards_destination_business_date(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.towards_destination_business_date(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_driver_identity_verification_gate(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_identity_verification_gate(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_has_accepted_active_or_stacked_work(uuid) TO service_role;

COMMIT;
