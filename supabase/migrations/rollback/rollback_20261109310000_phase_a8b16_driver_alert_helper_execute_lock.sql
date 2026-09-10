-- EMERGENCY ROLLBACK for 20261109310000_phase_a8b16_driver_alert_helper_execute_lock.sql
-- Restores only grants present in the captured production baseline.
-- Does not broaden grants beyond that baseline. Does not alter bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.raise_driver_alert(uuid, text, driver_alert_severity, text, uuid, jsonb) TO service_role;

GRANT EXECUTE ON FUNCTION public.resolve_driver_alert(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_driver_alert(uuid, text) TO service_role;

COMMIT;
