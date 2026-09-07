-- ============================================================
-- Phase 3 Batch 3C: dispatch/trip-state Edge-only RPC EXECUTE lock
-- NOT APPLIED until explicitly approved.
--
-- ACL only. No function bodies, signatures, search_path, dispatch policy,
-- wave timing, offer TTL, or financial calculations.
--
-- Proven callers are Edge Functions using SUPABASE_SERVICE_ROLE_KEY.
-- Driver accept/decline uses accept-offer / decline-trip, not these RPCs.
-- Nested SECURITY DEFINER / postgres callers keep owner EXECUTE.
--
-- Companions included so authenticated cannot bypass a revoked child:
--   accept_stacked_ride, customer_counter_ride_offer,
--   driver_accept_counter_offer, finalize_negotiated_fare,
--   finalize_negotiation_failure
-- ============================================================

BEGIN;

REVOKE ALL ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.decline_ride_offer(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decline_ride_offer(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.decline_ride_offer(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.decline_ride_offer(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.decline_ride_offer(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decline_ride_offer(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.decline_ride_offer(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.decline_ride_offer(uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.commit_dispatch_wave(uuid, integer, jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_dispatch_wave(uuid, integer, jsonb, integer) FROM anon;
REVOKE ALL ON FUNCTION public.commit_dispatch_wave(uuid, integer, jsonb, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.commit_dispatch_wave(uuid, integer, jsonb, integer) TO service_role;

REVOKE ALL ON FUNCTION public.commit_negotiation_fare(uuid, integer, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_negotiation_fare(uuid, integer, text, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.commit_negotiation_fare(uuid, integer, text, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.commit_negotiation_fare(uuid, integer, text, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.complete_trip_and_promote_next(uuid, uuid, bigint, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_trip_and_promote_next(uuid, uuid, bigint, timestamp with time zone) FROM anon;
REVOKE ALL ON FUNCTION public.complete_trip_and_promote_next(uuid, uuid, bigint, timestamp with time zone) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.complete_trip_and_promote_next(uuid, uuid, bigint, timestamp with time zone) TO service_role;

REVOKE ALL ON FUNCTION public.apply_terminal_trip_cancellation(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_terminal_trip_cancellation(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.apply_terminal_trip_cancellation(uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.apply_terminal_trip_cancellation(uuid, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_paid_booking_session(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_paid_booking_session(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_paid_booking_session(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_paid_booking_session(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.accept_stacked_ride(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_stacked_ride(uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.accept_stacked_ride(uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.accept_stacked_ride(uuid, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.customer_counter_ride_offer(uuid, integer, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_counter_ride_offer(uuid, integer, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.customer_counter_ride_offer(uuid, integer, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.customer_counter_ride_offer(uuid, integer, uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.driver_accept_counter_offer(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_accept_counter_offer(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_accept_counter_offer(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.driver_accept_counter_offer(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_negotiated_fare(uuid, uuid, integer, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_negotiated_fare(uuid, uuid, integer, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_negotiated_fare(uuid, uuid, integer, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_negotiated_fare(uuid, uuid, integer, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_negotiation_failure(uuid, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_negotiation_failure(uuid, uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_negotiation_failure(uuid, uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_negotiation_failure(uuid, uuid, uuid, text, text) TO service_role;

COMMIT;
