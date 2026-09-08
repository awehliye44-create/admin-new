-- Phase A6: check_schedule_overlap EXECUTE lock.
-- NOT APPLIED until explicitly approved.
--
-- No authenticated app, Admin, or Edge caller. service_role is not retained.
-- Body, signature, and data are unchanged.

BEGIN;

REVOKE ALL ON FUNCTION public.check_schedule_overlap(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_schedule_overlap(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.check_schedule_overlap(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.check_schedule_overlap(uuid, uuid) FROM service_role;

COMMIT;
