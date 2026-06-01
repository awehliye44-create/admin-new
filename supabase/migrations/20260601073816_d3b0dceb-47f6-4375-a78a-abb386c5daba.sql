BEGIN;

DELETE FROM public.dispatch_wave_snapshot;
DELETE FROM public.dispatch_wave_snapshots;
DELETE FROM public.dispatch_audit_log;
DELETE FROM public.dispatch_candidates_log;
DELETE FROM public.dispatch_eligibility_log;
DELETE FROM public.dispatch_round_advance_log;
DELETE FROM public.booking_delivery_log;
DELETE FROM public.scheduled_offer_attempts;
DELETE FROM public.ride_offers;

DELETE FROM public.payout_items;
DELETE FROM public.payout_batches;
DELETE FROM public.driver_statements;
DELETE FROM public.statement_runs;
DELETE FROM public.driver_wallet_ledger;
DELETE FROM public.driver_ledger;
DELETE FROM public.customer_wallet_ledger;
DELETE FROM public.trip_finance;

DELETE FROM public.trip_messages;
DELETE FROM public.trip_change_requests;
DELETE FROM public.trip_driver_exclusions;
DELETE FROM public.trip_stop_waiting;
DELETE FROM public.trip_stops;
DELETE FROM public.trip_route_cache;

DELETE FROM public.trips;

UPDATE public.driver_wallets
   SET available_pence = 0,
       pending_pence = 0,
       lifetime_earned_pence = 0,
       updated_at = now();

COMMIT;