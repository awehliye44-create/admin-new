
-- Reset all test trip and revenue data

-- 1. Clear trip-related child tables first
DELETE FROM trip_stop_waiting;
DELETE FROM trip_change_requests;
DELETE FROM trip_stops;
DELETE FROM trip_finance;
DELETE FROM dispatch_candidates_log;
DELETE FROM scheduled_offer_attempts;
DELETE FROM ride_offers;

-- 2. Clear all wallet/ledger entries
DELETE FROM driver_ledger;
DELETE FROM driver_wallet_ledger;

-- 3. Reset driver wallet balances
UPDATE driver_wallets SET available_pence = 0, pending_pence = 0, lifetime_earned_pence = 0, updated_at = now();

-- 4. Clear customer active trip + driver current trip refs BEFORE deleting trips
UPDATE drivers SET current_trip_id = NULL, updated_at = now();
UPDATE customers SET active_trip_id = NULL, updated_at = now();

-- 5. Clear trips
DELETE FROM trips;

-- 6. Reset driver trip counters
UPDATE drivers SET total_trips = 0, updated_at = now();

-- 7. Reset trip sequences
UPDATE service_area_sequences SET current_value = 0, updated_at = now() WHERE sequence_type = 'trip';
UPDATE id_sequences SET current_value = 0, updated_at = now() WHERE sequence_type = 'trip';
