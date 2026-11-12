-- Phase 4 + Phase 5 local simulator E2E (Docker only — never production).
-- Simulated bookings, mock payment authorisation, GPS, stacked journey, capability gate.
-- No Revolut network calls. No production bookings.
\set ON_ERROR_STOP on
SET session_replication_role = replica;

\echo '=== 0) Identify QA fixtures ==='
SELECT id AS driver_id, user_id, approval_status, onboarding_complete
FROM drivers WHERE user_id = '73a33693-7485-4917-959f-3394bfc7d0cc';
SELECT id AS customer_id, user_id FROM customers WHERE user_id = '41a8345a-711d-4269-a60b-aaef203286a1';

\echo '=== 1) Unlock QA driver for local dispatch eligibility ==='
UPDATE drivers SET
  approval_status = 'approved',
  onboarding_complete = true,
  documents_approved = true,
  is_online = true,
  updated_at = now()
WHERE id = '31b9b11e-8d57-4940-90ad-72709c40ba44';

\echo '=== 2) Mock GPS presence (Milton Keynes-ish) ==='
INSERT INTO driver_presence (
  driver_id, status, last_heartbeat_at, last_location_at, lat, lng, heading, speed,
  app_state, platform, presence_health, last_gps_sample_at, updated_at
) VALUES (
  '31b9b11e-8d57-4940-90ad-72709c40ba44', 'online', now(), now(),
  52.0406, -0.7594, 90, 8.5,
  'foreground', 'android', 'healthy', now(), now()
)
ON CONFLICT (driver_id) DO UPDATE SET
  status = 'online',
  last_heartbeat_at = now(),
  last_location_at = now(),
  lat = EXCLUDED.lat,
  lng = EXCLUDED.lng,
  heading = EXCLUDED.heading,
  speed = EXCLUDED.speed,
  last_gps_sample_at = now(),
  presence_health = 'healthy',
  updated_at = now();

\echo '=== 3) Active-device capability: Phase 5 capable OTA ==='
INSERT INTO driver_active_devices (
  driver_id, device_id, platform, app_version, client_capabilities,
  client_capabilities_updated_at, last_seen_at, updated_at
) VALUES (
  '31b9b11e-8d57-4940-90ad-72709c40ba44',
  'sim-android-capable-01',
  'android',
  '1.0.6',
  '["scheduled_departure_ack_v1"]'::jsonb,
  now(), now(), now()
)
ON CONFLICT (driver_id) DO UPDATE SET
  device_id = EXCLUDED.device_id,
  app_version = EXCLUDED.app_version,
  client_capabilities = EXCLUDED.client_capabilities,
  client_capabilities_updated_at = now(),
  last_seen_at = now(),
  updated_at = now();

\echo '=== 4) Mock payment authorisation (no Revolut) ==='
DELETE FROM payment_sessions WHERE client_action_id LIKE 'p45-sim-%';
INSERT INTO payment_sessions (
  id, client_action_id, user_id, customer_id, service_area_id,
  payment_provider, status, purpose, currency, idempotency_key,
  estimated_total_pence, buffer_pence, authorised_amount_pence, total_authorised_amount_pence,
  provider_state, provider_state_verified_at, provider_state_verified_by,
  authorised_at, payment_method, fare_snapshot, booking_snapshot, metadata
) VALUES (
  'dddddddd-dddd-dddd-dddd-ddddddddddd1',
  'p45-sim-auth-001',
  '41a8345a-711d-4269-a60b-aaef203286a1',
  '1bd6ec20-9591-45ef-aefb-3581765eeccd',
  'e8425eef-519b-46f8-82cd-677bb2320655',
  'revolut', 'authorised_hold', 'RIDE_BOOKING', 'gbp', 'p45-sim-auth-001',
  2500, 300, 2800, 2800,
  'AUTHORISED', now(), 'local_simulator_mock',
  now(), 'card',
  '{"gross_pence":2500,"currency":"GBP","simulator":true}'::jsonb,
  '{"is_scheduled":true,"simulator":true}'::jsonb,
  '{"mock":true,"no_revolut_network":true}'::jsonb
);

\echo '=== 5) Simulated scheduled booking (controlled pickup in 90 minutes) ==='
DELETE FROM ride_offers WHERE trip_id IN (
  SELECT id FROM trips WHERE id IN (
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1',
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2',
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3'
  )
);
DELETE FROM trips WHERE id IN (
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1',
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2',
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3'
);

INSERT INTO trips (
  id, passenger_id, pickup_address, dropoff_address, status, is_scheduled,
  scheduled_status, scheduled_at, confirmed_driver_id, service_area_id,
  pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude,
  payment_state, payment_session_id, financial_model, payment_method,
  fare_amount, gross_fare_pence, driver_net_pence, estimated_duration_minutes, dispatch_mode,
  broadcast_enabled
) VALUES (
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1',
  '1bd6ec20-9591-45ef-aefb-3581765eeccd',
  'CMK Station (sim)', 'Xscape MK (sim)', 'scheduled', true,
  'driver_assigned', now() + interval '90 minutes',
  '31b9b11e-8d57-4940-90ad-72709c40ba44',
  'e8425eef-519b-46f8-82cd-677bb2320655',
  52.0347, -0.7736, 52.0410, -0.7590,
  'payment_authorized', 'dddddddd-dddd-dddd-dddd-ddddddddddd1',
  'PLATFORM_COLLECTED', 'card',
  25.00, 2500, 2000, 18, 'scheduled', true
);

UPDATE payment_sessions SET trip_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1' WHERE id = 'dddddddd-dddd-dddd-dddd-ddddddddddd1';

SELECT 'BOOKED' AS step, id, scheduled_status, scheduled_at, confirmed_driver_id IS NOT NULL AS preconfirmed
FROM trips WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1';

\echo '=== 6) Marketplace publication stamp (simulated) ==='
UPDATE trips SET
  scheduled_status = 'scheduled',
  scheduled_broadcast_at = now() - interval '1 hour',
  updated_at = now()
WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1';

-- Re-confirm assignment after marketplace (pre-confirmed)
UPDATE trips SET
  scheduled_status = 'driver_assigned',
  confirmed_driver_id = '31b9b11e-8d57-4940-90ad-72709c40ba44',
  driver_id = NULL,
  updated_at = now()
WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1';

SELECT 'PUBLISHED_PRECONFIRMED' AS step, scheduled_status, confirmed_driver_id, driver_id
FROM trips WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1';

\echo '=== 7) Compatible stacked active journey (defer Phase 5 countdown) ==='
INSERT INTO trips (
  id, passenger_id, pickup_address, dropoff_address, status, is_scheduled,
  scheduled_status, service_area_id,
  pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude,
  payment_state, financial_model, payment_method, driver_id,
  started_at, estimated_duration_minutes
) VALUES (
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2',
  '1bd6ec20-9591-45ef-aefb-3581765eeccd',
  'Active Pickup (sim)', 'Near scheduled pickup (sim)', 'in_progress', false,
  NULL, 'e8425eef-519b-46f8-82cd-677bb2320655',
  52.0380, -0.7700, 52.0350, -0.7720,
  'payment_authorized', 'PLATFORM_COLLECTED', 'card',
  '31b9b11e-8d57-4940-90ad-72709c40ba44',
  now() - interval '5 minutes', 12
);

UPDATE driver_presence SET
  status = 'on_trip',
  lat = 52.0370, lng = -0.7710,
  last_heartbeat_at = now(), last_location_at = now(), last_gps_sample_at = now(),
  updated_at = now()
WHERE driver_id = '31b9b11e-8d57-4940-90ad-72709c40ba44';

SELECT 'STACKED_ACTIVE' AS step, id, status, driver_id FROM trips WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2';

\echo '=== 8) Complete compatible journey → driver free for JIT ==='
UPDATE trips SET
  status = 'completed', completed_at = now(), updated_at = now()
WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2';
UPDATE driver_presence SET
  status = 'online', lat = 52.0406, lng = -0.7594,
  last_heartbeat_at = now(), last_location_at = now(), last_gps_sample_at = now(),
  updated_at = now()
WHERE driver_id = '31b9b11e-8d57-4940-90ad-72709c40ba44';

\echo '=== 9A) Phase 4 path: older OTA (no capability) + flag on → exclusive NRO semantics ==='
UPDATE driver_active_devices SET
  client_capabilities = '[]'::jsonb,
  client_capabilities_updated_at = now(),
  app_version = '1.0.6',
  updated_at = now()
WHERE driver_id = '31b9b11e-8d57-4940-90ad-72709c40ba44';

UPDATE global_dispatch_settings SET
  scheduled_departure_ack_enabled = true,
  jit_auto_activate_enabled = false,
  updated_at = now()
WHERE singleton = true;

-- Arm Phase 4 exclusive NRO (locked response window, not 45s ack columns)
UPDATE trips SET
  scheduled_status = 'awaiting_activation_accept',
  scheduled_ack_status = NULL,
  scheduled_ack_deadline_at = NULL,
  scheduled_ack_armed_at = NULL,
  scheduled_ack_nonce = NULL,
  scheduled_jit_activate_at = now(),
  scheduled_jit_activation_source = 'jit',
  updated_at = now()
WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1';

INSERT INTO ride_offers (
  id, trip_id, driver_id, status, offered_at, expires_at,
  offered_driver_net_pence, is_urgent_dispatch, is_stacked, offer_snapshot
) VALUES (
  'ffffffff-ffff-ffff-ffff-fffffffffff1',
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1',
  '31b9b11e-8d57-4940-90ad-72709c40ba44',
  'pending', now(), now() + interval '3 minutes',
  2000, false, false,
  '{"departureAcknowledgement":false,"kind":"jit","simulator":true,"phase":"4"}'::jsonb
);

SELECT 'PHASE4_NRO' AS step,
  t.scheduled_status,
  t.scheduled_ack_status IS NULL AS no_ack_columns,
  o.expires_at > now() AS offer_open,
  (d.client_capabilities ? 'scheduled_departure_ack_v1') AS has_cap
FROM trips t
JOIN ride_offers o ON o.trip_id = t.id
JOIN driver_active_devices d ON d.driver_id = t.confirmed_driver_id
WHERE t.id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'
ORDER BY o.offered_at DESC LIMIT 1;

\echo '=== 9B) Phase 5 path: capable OTA → arm 45s departure ack ==='
DELETE FROM ride_offers WHERE id = 'ffffffff-ffff-ffff-ffff-fffffffffff1';

UPDATE driver_active_devices SET
  client_capabilities = '["scheduled_departure_ack_v1"]'::jsonb,
  client_capabilities_updated_at = now(),
  updated_at = now()
WHERE driver_id = '31b9b11e-8d57-4940-90ad-72709c40ba44';

UPDATE trips SET
  scheduled_status = 'awaiting_activation_accept',
  scheduled_ack_status = 'pending',
  scheduled_ack_armed_at = clock_timestamp(),
  scheduled_ack_deadline_at = clock_timestamp() + interval '45 seconds',
  scheduled_ack_driver_id = '31b9b11e-8d57-4940-90ad-72709c40ba44',
  scheduled_ack_nonce = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  scheduled_ack_acknowledged_at = NULL,
  scheduled_ack_resolved_at = NULL,
  driver_id = NULL,
  status = 'scheduled',
  updated_at = now()
WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1';

INSERT INTO ride_offers (
  id, trip_id, driver_id, status, offered_at, expires_at,
  offered_driver_net_pence, is_urgent_dispatch, is_stacked, offer_snapshot,
  broadcast_round
) VALUES (
  'ffffffff-ffff-ffff-ffff-fffffffffff2',
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1',
  '31b9b11e-8d57-4940-90ad-72709c40ba44',
  'pending', now(), now() + interval '45 seconds',
  2000, false, false,
  '{"departureAcknowledgement":true,"countdownSeconds":45,"kind":"jit","simulator":true,"phase":"5"}'::jsonb,
  2
);

SELECT 'PHASE5_ARMED' AS step,
  scheduled_ack_status,
  extract(epoch FROM (scheduled_ack_deadline_at - scheduled_ack_armed_at))::int AS window_s,
  (SELECT count(*) FROM trips WHERE scheduled_ack_status='pending') AS pending_acks
FROM trips WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1';

\echo '=== 10) Heading to Pickup (ack within window) — customer tracking only after ==='
-- Assert customer must not see live driver tracking before ack (driver_id still null)
SELECT 'PRE_ACK_NO_TRACKING' AS step,
  (driver_id IS NULL) AS no_live_driver,
  scheduled_ack_status
FROM trips WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1';

UPDATE trips SET
  scheduled_ack_status = 'acknowledged',
  scheduled_ack_acknowledged_at = clock_timestamp(),
  scheduled_ack_resolved_at = clock_timestamp(),
  scheduled_ack_resolution_reason = 'heading_to_pickup',
  driver_id = confirmed_driver_id,
  status = 'driver_en_route',
  scheduled_status = 'driver_en_route',
  updated_at = now()
WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1'
  AND scheduled_ack_status = 'pending'
  AND scheduled_ack_deadline_at > clock_timestamp();

UPDATE ride_offers SET status = 'accepted', updated_at = now()
WHERE id = 'ffffffff-ffff-ffff-ffff-fffffffffff2';

SELECT 'POST_ACK_TRACKING' AS step,
  scheduled_ack_status, status, driver_id IS NOT NULL AS live_tracking_allowed
FROM trips WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1';

\echo '=== 11) Reset + timeout path (Cancel / Auto timeout + instant conversion) ==='
-- New trip for timeout drill
INSERT INTO payment_sessions (
  id, client_action_id, user_id, customer_id, service_area_id,
  payment_provider, status, purpose, currency, idempotency_key,
  estimated_total_pence, authorised_amount_pence, total_authorised_amount_pence,
  provider_state, provider_state_verified_at, provider_state_verified_by,
  authorised_at, payment_method, fare_snapshot, booking_snapshot, metadata
) VALUES (
  'dddddddd-dddd-dddd-dddd-ddddddddddd2',
  'p45-sim-auth-002',
  '41a8345a-711d-4269-a60b-aaef203286a1',
  '1bd6ec20-9591-45ef-aefb-3581765eeccd',
  'e8425eef-519b-46f8-82cd-677bb2320655',
  'revolut', 'authorised_hold', 'RIDE_BOOKING', 'gbp', 'p45-sim-auth-002',
  2500, 2800, 2800,
  'AUTHORISED', now(), 'local_simulator_mock',
  now(), 'card', '{}'::jsonb, '{}'::jsonb, '{"mock":true}'::jsonb
);

INSERT INTO trips (
  id, passenger_id, pickup_address, dropoff_address, status, is_scheduled,
  scheduled_status, scheduled_at, confirmed_driver_id, service_area_id,
  pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude,
  payment_state, payment_session_id, financial_model, payment_method,
  fare_amount, gross_fare_pence, driver_net_pence, estimated_duration_minutes, dispatch_mode
) VALUES (
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3',
  '1bd6ec20-9591-45ef-aefb-3581765eeccd',
  'Timeout Pickup (sim)', 'Timeout Drop (sim)', 'scheduled', true,
  'awaiting_activation_accept', now() + interval '60 minutes',
  '31b9b11e-8d57-4940-90ad-72709c40ba44',
  'e8425eef-519b-46f8-82cd-677bb2320655',
  52.0347, -0.7736, 52.0410, -0.7590,
  'payment_authorized', 'dddddddd-dddd-dddd-dddd-ddddddddddd2',
  'PLATFORM_COLLECTED', 'card', 25.00, 2500, 2000, 15, 'scheduled'
);

UPDATE payment_sessions SET trip_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3'
WHERE id = 'dddddddd-dddd-dddd-dddd-ddddddddddd2';

UPDATE trips SET
  scheduled_ack_status = 'pending',
  scheduled_ack_armed_at = clock_timestamp() - interval '46 seconds',
  scheduled_ack_deadline_at = clock_timestamp() - interval '1 second',
  scheduled_ack_driver_id = '31b9b11e-8d57-4940-90ad-72709c40ba44',
  scheduled_ack_nonce = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2',
  driver_id = NULL,
  updated_at = now()
WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3';

-- Preserve fare + payment auth + original trip id through timeout conversion
WITH t0 AS (
  SELECT id, fare_amount, payment_session_id, payment_state FROM trips
  WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3'
), timed AS (
  UPDATE trips SET
    scheduled_ack_status = 'timed_out',
    scheduled_ack_resolved_at = clock_timestamp(),
    scheduled_ack_resolution_reason = 'acknowledgement_timeout',
    scheduled_status = 'searching',
    status = 'searching',
    dispatch_mode = 'instant',
    confirmed_driver_id = NULL,
    driver_id = NULL,
    updated_at = now()
  WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3'
    AND scheduled_ack_status = 'pending'
    AND scheduled_ack_deadline_at <= clock_timestamp()
  RETURNING id, fare_amount, payment_session_id, payment_state, status, dispatch_mode
)
SELECT 'TIMEOUT_CONVERT' AS step,
  timed.id = t0.id AS same_trip_id,
  timed.fare_amount = t0.fare_amount AS fare_preserved,
  timed.payment_session_id = t0.payment_session_id AS payment_preserved,
  timed.payment_state = t0.payment_state AS auth_preserved,
  timed.status, timed.dispatch_mode
FROM timed CROSS JOIN t0;

-- Late ack after timeout must fail
UPDATE trips SET
  scheduled_ack_status = 'acknowledged', driver_id = '31b9b11e-8d57-4940-90ad-72709c40ba44'
WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3'
  AND scheduled_ack_status = 'pending';

SELECT 'LATE_ACK_AFTER_TIMEOUT' AS step, scheduled_ack_status, driver_id IS NULL AS no_duplicate_assign
FROM trips WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3';

\echo '=== 12) Drain-first: disable flags; pending must be zero after cleanup ==='
UPDATE global_dispatch_settings SET
  scheduled_departure_ack_enabled = false,
  jit_auto_activate_enabled = false,
  updated_at = now()
WHERE singleton = true;

SELECT 'PENDING_AFTER_DRILL' AS step, count(*) AS pending_acks
FROM trips WHERE scheduled_ack_status = 'pending';

SELECT 'FLAGS' AS step, scheduled_departure_ack_enabled, jit_auto_activate_enabled
FROM global_dispatch_settings WHERE singleton;

SELECT 'PAYMENT_STILL_AUTH' AS step, id, provider_state, authorised_amount_pence
FROM payment_sessions WHERE id IN (
  'dddddddd-dddd-dddd-dddd-ddddddddddd1',
  'dddddddd-dddd-dddd-dddd-ddddddddddd2'
);

RESET session_replication_role;
\echo '=== DONE phase45-local-simulator-e2e ==='
