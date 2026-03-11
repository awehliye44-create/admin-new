-- Clean up ALL test data (child tables first)
DELETE FROM lost_property_status_history;
DELETE FROM lost_property_cases;
DELETE FROM trip_change_requests;
DELETE FROM scheduled_offer_attempts;
DELETE FROM ride_offers;
DELETE FROM trip_stops;
DELETE FROM trip_finance;
DELETE FROM driver_ledger;
DELETE FROM driver_wallet_ledger;
DELETE FROM dispatch_candidates_log;
DELETE FROM customer_wallet_ledger;
DELETE FROM passenger_ratings;
DELETE FROM trips;

-- Reset sequence counters
UPDATE service_area_sequences SET current_value = 0, updated_at = now() WHERE sequence_type = 'trip';
UPDATE id_sequences SET current_value = 0, updated_at = now() WHERE sequence_type = 'trip';

-- Reset driver wallet balances
UPDATE driver_wallets SET available_pence = 0, pending_pence = 0, lifetime_earned_pence = 0, updated_at = now();

-- Clear active trip references on drivers/customers
UPDATE drivers SET current_trip_id = NULL WHERE current_trip_id IS NOT NULL;
UPDATE customers SET active_trip_id = NULL WHERE active_trip_id IS NOT NULL;