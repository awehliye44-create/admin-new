-- ============================================================
-- Isolated Postgres integration — presence liveness (MK-260928-003) and the
-- Admin-owned customer nearby-driver radius.
--
-- Loads the REAL migration bodies:
--   20261204120000_presence_liveness_requires_fresh_location.sql
--   20261204130000_customer_nearby_drivers_radius_setting.sql
-- on top of stub tables plus helper functions copied verbatim from production
-- (find_nearby_drivers, driver_location_state*, haversine_meters,
-- is_explicit_offline_reason, sync_driver_online_from_presence, the pre-change
-- passenger_map_nearby_drivers).
--
-- Run ONLY against a disposable database:
--   scripts/run-presence-nearby-isolated.sh
-- ============================================================
\set ON_ERROR_STOP 1
-- One transaction so now() is a single fixed instant for every assertion.
BEGIN;
SET client_min_messages = warning;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT COALESCE(NULLIF(current_setting('test.role', true), ''), 'service_role') $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;

-- ── Stub tables (columns used by the functions under test) ──────────────────
CREATE TABLE public.drivers (
  id uuid PRIMARY KEY,
  user_id uuid,
  driver_online_intent boolean DEFAULT false,
  is_online boolean DEFAULT false,
  approval_status text DEFAULT 'approved',
  current_lat double precision, current_lng double precision,
  heading double precision, speed double precision,
  last_location_updated_at timestamptz, last_gps_sample_at timestamptz,
  location_source text, last_coordinate_change_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.driver_presence (
  driver_id uuid PRIMARY KEY REFERENCES public.drivers(id),
  status text,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  lat double precision, lng double precision,
  heading double precision, speed double precision,
  last_location_at timestamptz, last_gps_recorded_at timestamptz,
  last_gps_sample_at timestamptz, location_source text,
  last_coordinate_change_at timestamptz, last_significant_move_at timestamptz,
  last_significant_move_lat double precision, last_significant_move_lng double precision,
  app_state text, platform text, push_token text,
  accuracy_m double precision, battery_level smallint, low_accuracy boolean,
  socket_connected boolean, unresolved_critical_tracking boolean,
  last_socket_pong_at timestamptz, network_type text,
  presence_health text NOT NULL DEFAULT 'healthy',
  offline_reason text, last_offline_at timestamptz,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.profiles (user_id uuid, role text);
CREATE TABLE public.driver_active_devices (driver_id uuid PRIMARY KEY, device_id text);
CREATE TABLE public.global_dispatch_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton boolean NOT NULL DEFAULT true UNIQUE,
  start_radius_meters integer NOT NULL DEFAULT 4000,
  expand_radius_meters integer NOT NULL DEFAULT 8000,
  max_radius_meters integer NOT NULL DEFAULT 13000,
  stacked_search_radius_meters integer,
  presence_max_age_seconds integer
);
INSERT INTO public.global_dispatch_settings
  (start_radius_meters, expand_radius_meters, max_radius_meters, stacked_search_radius_meters, presence_max_age_seconds)
VALUES (13000, 17000, 29000, 7000, 60);

-- ── Production helpers (verbatim) ───────────────────────────────────────────
CREATE FUNCTION public.allow_driver_availability_write() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
BEGIN PERFORM set_config('app.allow_driver_availability_write', 'on', true); END; $f$;

CREATE FUNCTION public.assert_driver_presence_online_eligible(p_driver_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $f$ SELECT jsonb_build_object('eligible', true) $f$;

CREATE FUNCTION public.normalize_driver_offline_reason(p_reason text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $f$
  SELECT CASE
    WHEN NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN NULL
    WHEN lower(trim(p_reason)) IN ('manual_logout', 'active_device_takeover') THEN 'logout'
    ELSE lower(trim(p_reason))
  END; $f$;

CREATE FUNCTION public.is_explicit_offline_reason(p_reason text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $f$
  SELECT COALESCE(public.normalize_driver_offline_reason(p_reason) IN (
    'session_invalid', 'logout', 'session_signed_out', 'token_refresh_failed',
    'admin_force_offline', 'manual_go_offline'), FALSE); $f$;

CREATE FUNCTION public.driver_location_thresholds() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $f$
  SELECT jsonb_build_object(
    'heartbeat_fresh_seconds', 45, 'gps_fresh_seconds', 60,
    'stationary_speed_mps', 0.8, 'movement_threshold_meters', 50,
    'gps_sample_max_age_seconds', 180, 'out_of_order_tolerance_seconds', 5,
    'future_skew_tolerance_seconds', 10); $f$;

CREATE FUNCTION public.haversine_meters(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision)
RETURNS double precision LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE
  r double precision := 6371000;
  dlat double precision := radians(lat2 - lat1);
  dlon double precision := radians(lon2 - lon1);
  a double precision; c double precision;
BEGIN
  a := sin(dlat/2)^2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon/2)^2;
  c := 2 * atan2(sqrt(a), sqrt(1-a));
  RETURN r * c;
END; $f$;

CREATE FUNCTION public.driver_location_state(p_driver_online_intent boolean, p_last_heartbeat_at timestamptz,
  p_last_gps_sample_at timestamptz, p_speed double precision DEFAULT NULL, p_now timestamptz DEFAULT now())
RETURNS text LANGUAGE sql STABLE SET search_path TO 'public' AS $f$
  WITH t AS (SELECT public.driver_location_thresholds() AS v)
  SELECT CASE
    WHEN NOT COALESCE(p_driver_online_intent, false) THEN 'location_unavailable'
    WHEN p_last_heartbeat_at IS NULL THEN 'location_unavailable'
    WHEN p_now - p_last_heartbeat_at > make_interval(secs => (SELECT (v->>'heartbeat_fresh_seconds')::int FROM t))
      THEN 'location_stale'
    WHEN p_last_gps_sample_at IS NULL THEN 'location_unavailable'
    WHEN p_now - p_last_gps_sample_at > make_interval(secs => (SELECT (v->>'gps_fresh_seconds')::int FROM t))
      THEN 'location_frozen'
    WHEN COALESCE(p_speed, 0) < (SELECT (v->>'stationary_speed_mps')::double precision FROM t)
      THEN 'location_stationary'
    ELSE 'location_live'
  END; $f$;

CREATE FUNCTION public.driver_location_state_for_driver(p_driver_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT public.driver_location_state(d.driver_online_intent, dp.last_heartbeat_at,
    COALESCE(dp.last_gps_sample_at, d.last_gps_sample_at), COALESCE(dp.speed, d.speed))
  FROM public.drivers d LEFT JOIN public.driver_presence dp ON dp.driver_id = d.id
  WHERE d.id = p_driver_id; $f$;

CREATE FUNCTION public.driver_location_is_frozen(p_driver_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT public.driver_location_state_for_driver(p_driver_id) = 'location_frozen'; $f$;

CREATE FUNCTION public.sync_driver_online_from_presence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_driver public.drivers%ROWTYPE; v_eligible jsonb; v_should_be_online boolean;
BEGIN
  SELECT * INTO v_driver FROM public.drivers WHERE id = NEW.driver_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  v_eligible := public.assert_driver_presence_online_eligible(NEW.driver_id);
  v_should_be_online := COALESCE(v_driver.driver_online_intent, false)
    AND COALESCE((v_eligible ->> 'eligible')::boolean, false)
    AND NEW.status IN ('online', 'on_trip', 'paused');
  IF v_driver.is_online IS DISTINCT FROM v_should_be_online THEN
    PERFORM public.allow_driver_availability_write();
    UPDATE public.drivers SET is_online = v_should_be_online, updated_at = now() WHERE id = NEW.driver_id;
  END IF;
  RETURN NEW;
END; $f$;
CREATE TRIGGER trg_sync_driver_online_from_presence AFTER INSERT OR UPDATE ON public.driver_presence
  FOR EACH ROW EXECUTE FUNCTION public.sync_driver_online_from_presence();

CREATE FUNCTION public.find_nearby_drivers(p_lat double precision, p_lng double precision,
  p_radius_meters double precision, p_limit integer DEFAULT 40, p_stale_seconds integer DEFAULT 180)
RETURNS TABLE(driver_id uuid, lat double precision, lng double precision, heading double precision,
  speed double precision, distance_meters double precision, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT d.id AS driver_id,
    COALESCE(dp.lat, d.current_lat)::double precision AS lat,
    COALESCE(dp.lng, d.current_lng)::double precision AS lng,
    COALESCE(dp.heading, d.heading, 0::double precision) AS heading,
    COALESCE(dp.speed, d.speed, 0::double precision) AS speed,
    public.haversine_meters(p_lat, p_lng, COALESCE(dp.lat, d.current_lat)::double precision,
      COALESCE(dp.lng, d.current_lng)::double precision)::double precision AS distance_meters,
    COALESCE(dp.updated_at, d.updated_at, d.created_at) AS updated_at
  FROM public.drivers d LEFT JOIN public.driver_presence dp ON dp.driver_id = d.id
  WHERE d.is_online = true AND d.approval_status = 'approved'
    AND COALESCE(dp.lat, d.current_lat) IS NOT NULL AND COALESCE(dp.lng, d.current_lng) IS NOT NULL
    AND NOT (COALESCE(dp.lat, d.current_lat) = 0 AND COALESCE(dp.lng, d.current_lng) = 0)
    AND (dp.driver_id IS NULL
      OR COALESCE(dp.last_heartbeat_at, dp.updated_at, d.updated_at) > now() - make_interval(secs => p_stale_seconds))
    AND NOT public.driver_location_is_frozen(d.id)
    AND public.haversine_meters(p_lat, p_lng, COALESCE(dp.lat, d.current_lat)::double precision,
      COALESCE(dp.lng, d.current_lng)::double precision) <= p_radius_meters
  ORDER BY distance_meters ASC
  LIMIT LEAST(COALESCE(p_limit, 40), 80); $f$;
REVOKE ALL ON FUNCTION public.find_nearby_drivers(double precision, double precision, double precision, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_nearby_drivers(double precision, double precision, double precision, integer, integer) TO authenticated, service_role;

-- Production passenger_map_nearby_drivers BEFORE the radius migration.
CREATE FUNCTION public.passenger_map_nearby_drivers(p_lat double precision, p_lng double precision,
  p_radius_meters double precision, p_limit integer DEFAULT 24, p_stale_seconds integer DEFAULT 45)
RETURNS TABLE(driver_id uuid, lat double precision, lng double precision, distance_meters double precision,
  speed real, heading real, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $f$
  SELECT * FROM public.find_nearby_drivers(p_lat, p_lng, p_radius_meters, p_limit, p_stale_seconds); $f$;
REVOKE ALL ON FUNCTION public.passenger_map_nearby_drivers(double precision, double precision, double precision, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.passenger_map_nearby_drivers(double precision, double precision, double precision, integer, integer) TO authenticated, service_role;

CREATE FUNCTION pg_temp.check(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', label; END IF;
  RAISE NOTICE 'PASS: %', label;
END; $f$;
SET client_min_messages = notice;

-- ── Pre-change evidence: SELECT * column mapping ────────────────────────────
INSERT INTO public.drivers (id, driver_online_intent, approval_status) VALUES
  ('00000000-0000-0000-0000-0000000000a0', true, 'approved');
INSERT INTO public.driver_presence (driver_id, status, lat, lng, heading, speed, last_heartbeat_at,
  last_location_at, last_gps_sample_at, last_gps_recorded_at)
VALUES ('00000000-0000-0000-0000-0000000000a0', 'online', 52.0417 + 0.10791, -0.7574, 90, 5,
  now(), now(), now(), now());
SELECT pg_temp.check(
  (SELECT round(heading)::int <> 90 AND round(distance_meters)::int = 90
     FROM public.passenger_map_nearby_drivers(52.0417, -0.7574, 25000, 24, 45)),
  'before: production SELECT * maps heading into distance_meters (and distance into heading)');
DELETE FROM public.driver_presence; DELETE FROM public.drivers;

-- ── Apply the migrations under test ─────────────────────────────────────────
SET client_min_messages = warning;
\ir ../migrations/20261204120000_presence_liveness_requires_fresh_location.sql
\ir ../migrations/20261204130000_customer_nearby_drivers_radius_setting.sql
SET client_min_messages = notice;

CREATE FUNCTION public.driver_heartbeat_ping(p_driver_id uuid, p_app_state text DEFAULT NULL,
  p_platform text DEFAULT NULL, p_push_token text DEFAULT NULL, p_device_id text DEFAULT NULL,
  p_battery_level smallint DEFAULT NULL, p_socket_connected boolean DEFAULT NULL,
  p_unresolved_critical_tracking boolean DEFAULT NULL, p_network_type text DEFAULT NULL)
RETURNS public.driver_presence LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT public.upsert_driver_presence(p_driver_id => p_driver_id, p_app_state => p_app_state,
    p_platform => p_platform, p_push_token => p_push_token, p_device_id => p_device_id,
    p_battery_level => p_battery_level, p_socket_connected => p_socket_connected,
    p_unresolved_critical_tracking => p_unresolved_critical_tracking, p_network_type => p_network_type); $f$;

-- ============================================================
-- ISSUE 1 — liveness requires fresh coordinates
-- ============================================================
INSERT INTO public.drivers (id, driver_online_intent, is_online) VALUES
  ('00000000-0000-0000-0000-000000000001', true, true),
  ('00000000-0000-0000-0000-000000000002', true, false);

-- S1: first genuine GPS sample is accepted and advances liveness.
SELECT public.upsert_driver_presence(p_driver_id => '00000000-0000-0000-0000-000000000001',
  p_lat => 52.0297, p_lng => -0.6728, p_gps_recorded_at => now(), p_app_state => 'background', p_source => 'bg_task');
SELECT pg_temp.check(
  (SELECT last_heartbeat_at = now() AND last_location_at = now() AND presence_health = 'healthy'
     FROM public.driver_presence WHERE driver_id = '00000000-0000-0000-0000-000000000001'),
  'S1 accepted GPS sample advances last_heartbeat_at + last_location_at, health=healthy');

-- S2: MK-260928-002 shape — location ~3h stale, heartbeat aged; a coordinate-free ping arrives.
UPDATE public.driver_presence SET
  lat = 52.0050, lng = -0.7900,
  last_location_at = now() - interval '3 hours', last_gps_sample_at = now() - interval '3 hours',
  last_gps_recorded_at = now() - interval '3 hours',
  last_heartbeat_at = now() - interval '90 seconds', presence_health = 'degraded'
WHERE driver_id = '00000000-0000-0000-0000-000000000001';
UPDATE public.drivers SET last_seen_at = now() - interval '90 seconds' WHERE id = '00000000-0000-0000-0000-000000000001';
SELECT public.driver_heartbeat_ping('00000000-0000-0000-0000-000000000001', p_app_state => 'background', p_socket_connected => true);
SELECT pg_temp.check(
  (SELECT last_heartbeat_at = now() - interval '90 seconds' AND presence_health = 'degraded'
          AND app_state = 'background' AND socket_connected = true
     FROM public.driver_presence WHERE driver_id = '00000000-0000-0000-0000-000000000001'),
  'S2 coordinate-free ping with stale location does NOT refresh last_heartbeat_at/health (posture fields still update)');
SELECT pg_temp.check(
  (SELECT last_seen_at = now() - interval '90 seconds' FROM public.drivers WHERE id = '00000000-0000-0000-0000-000000000001'),
  'S2 coordinate-free ping does NOT refresh drivers.last_seen_at');
SELECT pg_temp.check(
  (SELECT NOT (last_heartbeat_at > now() - make_interval(secs => 60))
     FROM public.driver_presence WHERE driver_id = '00000000-0000-0000-0000-000000000001'),
  'S2 dispatch_trip_offers healthy_heartbeat (presence_max_age 60s) is now FALSE -> stale_heartbeat hard reject');

-- S3: stale timestamp and duplicate cached sample are rejected and do not revive liveness.
SELECT public.upsert_driver_presence(p_driver_id => '00000000-0000-0000-0000-000000000001',
  p_lat => 52.0301, p_lng => -0.6731, p_gps_recorded_at => now() - interval '200 seconds');
SELECT public.upsert_driver_presence(p_driver_id => '00000000-0000-0000-0000-000000000001',
  p_lat => 52.0050, p_lng => -0.7900,
  p_gps_recorded_at => (SELECT last_gps_recorded_at FROM public.driver_presence WHERE driver_id = '00000000-0000-0000-0000-000000000001'));
SELECT pg_temp.check(
  (SELECT last_heartbeat_at = now() - interval '90 seconds' AND lat = 52.0050
     FROM public.driver_presence WHERE driver_id = '00000000-0000-0000-0000-000000000001'),
  'S3 stale_gps_timestamp and duplicate_cached_sample neither move lat nor refresh liveness');

-- S4: fresh BG fix with new coordinates revives liveness and moves the position.
SELECT public.upsert_driver_presence(p_driver_id => '00000000-0000-0000-0000-000000000001',
  p_lat => 52.0297, p_lng => -0.6728, p_gps_recorded_at => now() - interval '4 seconds',
  p_app_state => 'background', p_source => 'bg_task');
SELECT pg_temp.check(
  (SELECT last_heartbeat_at = now() AND last_location_at = now() AND lat = 52.0297
          AND presence_health = 'healthy' AND last_gps_recorded_at = now() - interval '4 seconds'
     FROM public.driver_presence WHERE driver_id = '00000000-0000-0000-0000-000000000001'),
  'S4 fresh BG fix moves lat/lng and restores heartbeat + health');

-- S5: within gps_fresh_seconds a coordinate-free ping still keeps the driver live (no flapping).
UPDATE public.driver_presence SET last_location_at = now() - interval '30 seconds',
  last_heartbeat_at = now() - interval '10 seconds'
WHERE driver_id = '00000000-0000-0000-0000-000000000001';
SELECT public.driver_heartbeat_ping('00000000-0000-0000-0000-000000000001', p_app_state => 'foreground');
SELECT pg_temp.check(
  (SELECT last_heartbeat_at = now() FROM public.driver_presence WHERE driver_id = '00000000-0000-0000-0000-000000000001'),
  'S5 ping while stored location < 60s old advances heartbeat');

-- S6: MK-260921-006 — a GPS sample <2s after a heartbeat is never throttled.
UPDATE public.driver_presence SET last_heartbeat_at = now() - interval '1 second'
WHERE driver_id = '00000000-0000-0000-0000-000000000001';
SELECT public.upsert_driver_presence(p_driver_id => '00000000-0000-0000-0000-000000000001',
  p_lat => 52.0299, p_lng => -0.6725, p_gps_recorded_at => now() - interval '1 second', p_source => 'bg_task');
SELECT pg_temp.check(
  (SELECT lat = 52.0299 AND last_heartbeat_at = now() FROM public.driver_presence WHERE driver_id = '00000000-0000-0000-0000-000000000001'),
  'S6 GPS sample within 2s of last heartbeat is accepted (throttle applies only to pure heartbeats)');

-- S7: first-ever presence row from a coordinate-free ping is not "live".
SELECT public.driver_heartbeat_ping('00000000-0000-0000-0000-000000000002', p_app_state => 'background');
SELECT pg_temp.check(
  (SELECT last_heartbeat_at = 'epoch'::timestamptz AND presence_health = 'degraded'
     FROM public.driver_presence WHERE driver_id = '00000000-0000-0000-0000-000000000002'),
  'S7 insert from coordinate-free ping: last_heartbeat_at=epoch, health=degraded');

-- ============================================================
-- ISSUE 2 — Admin-owned customer nearby radius
-- ============================================================
DELETE FROM public.driver_presence; DELETE FROM public.drivers;

SELECT pg_temp.check(
  (SELECT customer_nearby_drivers_radius_meters = 25000 FROM public.global_dispatch_settings WHERE singleton),
  'R0 column default is 25000 m');
SELECT pg_temp.check(
  (SELECT start_radius_meters = 13000 AND expand_radius_meters = 17000 AND max_radius_meters = 29000
          AND stacked_search_radius_meters = 7000
     FROM public.global_dispatch_settings WHERE singleton),
  'R0 dispatch wave radii and stacked radius untouched by the migration');

-- Pickup: Milton Keynes Central. 0.0089932 deg lat ~= 1 km.
INSERT INTO public.drivers (id, driver_online_intent, approval_status) VALUES
  ('00000000-0000-0000-0000-0000000000c3', true, 'approved'),  -- 3 km, healthy
  ('00000000-0000-0000-0000-0000000000a1', true, 'approved'),  -- 12 km, healthy
  ('00000000-0000-0000-0000-0000000000b3', true, 'approved'),  -- 30 km, healthy
  ('00000000-0000-0000-0000-0000000000d1', true, 'approved'),  -- 12 km, stale heartbeat
  ('00000000-0000-0000-0000-0000000000e1', false, 'approved'), -- 12 km, offline
  ('00000000-0000-0000-0000-0000000000f1', true, 'pending'),   -- 12 km, not approved
  ('00000000-0000-0000-0000-0000000000a9', true, 'approved');  -- 12 km, frozen GPS
INSERT INTO public.driver_presence (driver_id, status, lat, lng, heading, speed,
  last_heartbeat_at, last_location_at, last_gps_sample_at, last_gps_recorded_at) VALUES
  ('00000000-0000-0000-0000-0000000000c3', 'online', 52.0417 + 3 * 0.0089932, -0.7574, 45, 3, now(), now(), now(), now()),
  ('00000000-0000-0000-0000-0000000000a1', 'online', 52.0417 + 12 * 0.0089932, -0.7574, 90, 5, now(), now(), now(), now()),
  ('00000000-0000-0000-0000-0000000000b3', 'online', 52.0417 + 30 * 0.0089932, -0.7574, 180, 5, now(), now(), now(), now()),
  ('00000000-0000-0000-0000-0000000000d1', 'online', 52.0417 + 12 * 0.0089932, -0.7574, 0, 0,
     now() - interval '90 seconds', now() - interval '90 seconds', now() - interval '90 seconds', now() - interval '90 seconds'),
  ('00000000-0000-0000-0000-0000000000e1', 'offline', 52.0417 + 12 * 0.0089932, -0.7574, 0, 0, now(), now(), now(), now()),
  ('00000000-0000-0000-0000-0000000000f1', 'online', 52.0417 + 12 * 0.0089932, -0.7574, 0, 0, now(), now(), now(), now()),
  ('00000000-0000-0000-0000-0000000000a9', 'online', 52.0417 + 12 * 0.0089932, -0.7574, 0, 0,
     now(), now() - interval '5 minutes', now() - interval '5 minutes', now() - interval '5 minutes');
UPDATE public.drivers SET approval_status = 'pending' WHERE id = '00000000-0000-0000-0000-0000000000f1';

CREATE FUNCTION pg_temp.nearby_ids(p_radius double precision DEFAULT NULL) RETURNS text[]
LANGUAGE sql AS $f$
  SELECT COALESCE(array_agg(right(driver_id::text, 2) ORDER BY distance_meters), '{}')
  FROM public.passenger_map_nearby_drivers(52.0417, -0.7574, p_radius, 24, 45); $f$;

SELECT pg_temp.check(pg_temp.nearby_ids() = ARRAY['c3','a1'],
  'R1 default 25 km: 3 km + 12 km returned; 30 km excluded; stale/offline/unapproved/frozen excluded');
SELECT pg_temp.check(
  (SELECT round(distance_meters / 100)::int = 120 AND heading = 90::real AND speed = 5::real
     FROM public.passenger_map_nearby_drivers(52.0417, -0.7574, NULL, 24, 45)
     WHERE right(driver_id::text, 2) = 'a1'),
  'R1 columns mapped by name: distance_meters ~12000, heading 90, speed 5');
SELECT pg_temp.check(pg_temp.nearby_ids(1) = ARRAY['c3','a1'] AND pg_temp.nearby_ids(500000) = ARRAY['c3','a1'],
  'R2 caller p_radius_meters (old Customer builds) is ignored: no client override');
SELECT pg_temp.check(
  (SELECT count(*) = 2 FROM public.passenger_map_nearby_drivers(p_lat => 52.0417, p_lng => -0.7574)),
  'R2 RPC callable without p_radius_meters (new Customer build)');

UPDATE public.global_dispatch_settings SET customer_nearby_drivers_radius_meters = 35000 WHERE singleton;
SELECT pg_temp.check(pg_temp.nearby_ids() = ARRAY['c3','a1','b3'], 'R3 Admin sets 35 km: 30 km driver now returned');
UPDATE public.global_dispatch_settings SET customer_nearby_drivers_radius_meters = 10000 WHERE singleton;
SELECT pg_temp.check(pg_temp.nearby_ids() = ARRAY['c3'], 'R3 Admin sets 10 km: 12 km driver now excluded');
UPDATE public.global_dispatch_settings SET customer_nearby_drivers_radius_meters = 25000 WHERE singleton;
SELECT pg_temp.check(pg_temp.nearby_ids() = ARRAY['c3','a1'], 'R3 back to 25 km');

DO $$
BEGIN
  BEGIN
    UPDATE public.global_dispatch_settings SET customer_nearby_drivers_radius_meters = 500 WHERE singleton;
    RAISE EXCEPTION 'FAIL: 500 m accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: R4 500 m rejected by CHECK';
  END;
  BEGIN
    UPDATE public.global_dispatch_settings SET customer_nearby_drivers_radius_meters = 150000 WHERE singleton;
    RAISE EXCEPTION 'FAIL: 150 km accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: R4 150 km rejected by CHECK';
  END;
END $$;

SELECT pg_temp.check(
  has_function_privilege('authenticated', 'public.passenger_map_nearby_drivers(double precision, double precision, double precision, integer, integer)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.passenger_map_nearby_drivers(double precision, double precision, double precision, integer, integer)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.passenger_map_nearby_drivers(double precision, double precision, double precision, integer, integer)', 'EXECUTE'),
  'R5 EXECUTE: authenticated + service_role yes, anon no');

-- Issue 1 x Issue 2: a driver whose location goes stale drops off the Customer map.
UPDATE public.driver_presence SET last_location_at = now() - interval '3 hours',
  last_gps_sample_at = now() - interval '3 hours', last_heartbeat_at = now() - interval '50 seconds'
WHERE driver_id = '00000000-0000-0000-0000-0000000000a1';
SELECT public.driver_heartbeat_ping('00000000-0000-0000-0000-0000000000a1', p_app_state => 'background');
SELECT pg_temp.check(pg_temp.nearby_ids() = ARRAY['c3'],
  'X1 stale-location driver stays off the Customer map after a coordinate-free ping');

ROLLBACK;
\echo ALL_PRESENCE_NEARBY_ISOLATED_CHECKS_PASSED
