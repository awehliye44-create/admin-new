-- EMERGENCY ROLLBACK for 20261109320000_phase_a8b17_edge_demand_zone_audit_execute_lock.sql
-- Restores only grants present in the captured production baseline.
-- Does not broaden grants beyond that baseline. Does not alter bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.log_demand_zone_event(uuid, uuid, text, jsonb, jsonb, text) TO authenticated;
-- service_role EXECUTE was retained through the forward migration; no restore grant needed.

COMMIT;
