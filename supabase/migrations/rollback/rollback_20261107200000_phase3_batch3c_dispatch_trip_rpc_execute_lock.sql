-- EMERGENCY ROLLBACK for 20261107200000_phase3_batch3c_dispatch_trip_rpc_execute_lock.sql
-- Restores authenticated EXECUTE only. Does not restore PUBLIC or anon.
-- Does not alter function bodies. Re-opens cross-driver dispatch holes — emergency only.

BEGIN;

GRANT EXECUTE ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decline_ride_offer(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decline_ride_offer(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_dispatch_wave(uuid, integer, jsonb, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.commit_negotiation_fare(uuid, integer, text, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_trip_and_promote_next(uuid, uuid, bigint, timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_terminal_trip_cancellation(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_paid_booking_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_stacked_ride(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_counter_ride_offer(uuid, integer, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_accept_counter_offer(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_negotiated_fare(uuid, uuid, integer, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_negotiation_failure(uuid, uuid, uuid, text, text) TO authenticated;

COMMIT;
