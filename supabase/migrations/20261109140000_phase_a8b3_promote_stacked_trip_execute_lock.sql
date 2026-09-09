-- ============================================================
-- Phase A8B3: promote_stacked_trip EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- Proven callers (service-role Supabase client only):
--   Edge stop-workflow → tryPromoteStackedTripAfterCompletion
--   Edge pickup-no-show → handleQueuedTripAfterCurrentTripFailure (promote path)
--   Edge stop-workflow payment-failure path → attemptStackedTripPromotionAfterComplete
-- Shared helper: stackedRideLifecycle.ts (no direct user-JWT RPC mount).
-- No Admin/Customer/Driver/Corporate/SQL/trigger/cron mount of this RPC.
-- ACL only. Body, signature, and data unchanged.
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.promote_stacked_trip(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.promote_stacked_trip(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.promote_stacked_trip(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.promote_stacked_trip(uuid, uuid) TO service_role;

COMMIT;
