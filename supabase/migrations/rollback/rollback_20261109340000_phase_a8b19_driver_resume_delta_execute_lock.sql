-- EMERGENCY ROLLBACK for 20261109340000_phase_a8b19_driver_resume_delta_execute_lock.sql
-- Restores only grants present in the captured production baseline.
-- Does not broaden grants beyond that baseline. Does not alter bodies.

BEGIN;

GRANT EXECUTE ON FUNCTION public.get_driver_resume_delta(timestamp with time zone, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_resume_delta(timestamp with time zone, uuid, uuid) TO service_role;

COMMIT;
