SET session_replication_role = 'replica';

DELETE FROM public.driver_wallet_ledger;
DELETE FROM public.customer_wallet_ledger;

DELETE FROM public.payout_items;
DELETE FROM public.payout_batches;
DELETE FROM public.driver_statements;
DELETE FROM public.statement_runs;

DELETE FROM public.dispatch_candidates_log;
DELETE FROM public.trip_offers;
DELETE FROM public.call_masking_sessions;
DELETE FROM public.complaints;
DELETE FROM public.rider_feedback;
DELETE FROM public.lost_property_messages;
DELETE FROM public.lost_property_status_history;
DELETE FROM public.lost_property_cases;
DELETE FROM public.corporate_invoices;

UPDATE public.customers SET active_trip_id = NULL WHERE active_trip_id IS NOT NULL;

DELETE FROM public.trips;

UPDATE public.driver_wallets SET 
  available_pence = 0, 
  pending_pence = 0,
  lifetime_earned_pence = 0,
  updated_at = now();

UPDATE public.customer_wallets SET 
  balance_pence = 0,
  updated_at = now();

UPDATE public.complaint_sequences SET current_value = 0;
UPDATE public.lost_property_sequences SET current_value = 0;

SET session_replication_role = 'origin';