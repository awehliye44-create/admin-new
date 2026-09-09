-- ============================================================
-- Phase A8B1: admin_cancel_trip_negotiation EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- Proven caller: Edge admin-cancel-trip-negotiation only
-- (service-role Bearer gate + service-role Supabase client).
-- No Admin/Customer/Driver/Corporate/SQL/trigger/cron mount.
-- ACL only. Body, signature, and data unchanged.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.admin_cancel_trip_negotiation(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_cancel_trip_negotiation(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_cancel_trip_negotiation(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cancel_trip_negotiation(uuid, text) TO service_role;

COMMIT;
