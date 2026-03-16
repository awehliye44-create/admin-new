-- Reset all test trip and revenue data
TRUNCATE TABLE 
  trip_stop_waiting,
  trip_stops,
  ride_offers,
  dispatch_candidates_log,
  driver_ledger,
  trips
CASCADE;

-- Reset sequence counters for trip numbers
UPDATE service_area_sequences SET current_value = 0, updated_at = now() WHERE sequence_type = 'trip';
UPDATE id_sequences SET current_value = 0, updated_at = now() WHERE sequence_type = 'trip';

-- Clear driver current_trip_id references
UPDATE drivers SET current_trip_id = NULL WHERE current_trip_id IS NOT NULL;
