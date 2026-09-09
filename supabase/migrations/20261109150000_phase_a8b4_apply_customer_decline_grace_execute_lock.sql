-- ============================================================
-- Phase A8B4: apply_customer_decline_grace EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- Proven callers (service-role Supabase client only):
--   Edge customer-fare-decision → enterDriverSecondChanceAtOriginalFare
--     (auth.getUser + trip.passenger_id ownership before RPC)
--   Edge expire-offers → enterDriverSecondChanceAtOriginalFare
--     (service-role sweep; offer rows selected from DB)
-- Shared helper: customerNegotiationGrace.ts (injected service client).
-- No Admin/Customer/Driver/Corporate/SQL/trigger/cron mount of this RPC.
-- ACL only. Body, signature, and data unchanged.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.apply_customer_decline_grace(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_customer_decline_grace(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.apply_customer_decline_grace(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_customer_decline_grace(uuid, text) TO service_role;

COMMIT;
