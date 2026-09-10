-- EMERGENCY ROLLBACK for 20261109300000_phase_a8b15_orphan_driver_trip_helper_execute_lock.sql
-- Restores only grants present in the captured production baseline.
-- Does not broaden grants beyond that baseline. Does not alter bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.is_customer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_customer(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.get_marketplace_delivery_config(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_marketplace_delivery_config(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.resolve_driver_tier_category_priority(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_driver_tier_category_priority(uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_lost_property_public_trip_ref(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.driver_is_assigned_to_live_trip(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_is_assigned_to_live_trip(uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.driver_is_excluded_from_trip(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_is_excluded_from_trip(uuid, uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.driver_location_state_for_driver(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_location_state_for_driver(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.driver_location_is_frozen(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_location_is_frozen(uuid) TO service_role;

GRANT EXECUTE ON FUNCTION public.resolve_driver_tier_name(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_driver_tier_name(uuid) TO service_role;

-- Baseline had authenticated only (no service_role EXECUTE)
GRANT EXECUTE ON FUNCTION public.validate_driver_signup_region_service_areas(uuid, uuid[]) TO authenticated;

COMMIT;
