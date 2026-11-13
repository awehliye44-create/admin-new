-- ============================================================================
-- Scheduled rematch / waiting-segment concurrency harness  —  SETUP (+ CLEANUP)
--
-- LOCAL SUPABASE DB ONLY (postgresql://postgres:postgres@127.0.0.1:54322/postgres).
-- No Edge calls, no Revolut, no push. Pure SQL that mirrors the production CAS
-- predicates from:
--   supabase/functions/driver-cancel-before-pickup/index.ts
--   supabase/functions/_shared/scheduledDriverCancelRematchSSOT.ts
--   supabase/functions/_shared/driverCancelRematch.ts
--   supabase/functions/_shared/waitingSegmentClock.ts
--
-- Everything the harness creates is identifiable and removable:
--   * synthetic UUIDs  00000000-0000-4000-{8000 trips | 9000 passengers |
--                                          a000 payment_sessions | b000 drivers}-<n>
--   * trips.client_action_id = 'TEST-REMATCH-<n>'
--     (trips.trip_code is trigger-generated + immutable, so it cannot carry the
--      TEST-REMATCH prefix — client_action_id is the human-visible marker)
--   * helper schema rmch_iso (config, results, worker_out, functions)
--
-- psql variables (all optional):
--   -v cleanup_only=1        remove every synthetic row + the rmch_iso schema, then exit
--   -v cas_statuses='{a,b}'  DRIVER_CANCEL_REMATCH_CAS_STATUSES parsed from the TS SSOT by the .sh
--   -v find_minutes=6        fresh driver-find window for the converted trip (prod fallback = 6)
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on

-- ---------------------------------------------------------------------------
-- 0. CLEANUP (idempotent; also runs before every setup so reruns are safe)
-- ---------------------------------------------------------------------------
DO $cleanup$
DECLARE
  r record;
  v_trips   uuid[];
  v_drivers uuid[];
  v_ps      uuid[];
  v_deleted bigint;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  SELECT coalesce(array_agg(id), '{}') INTO v_trips
    FROM public.trips WHERE id::text LIKE '00000000-0000-4000-8000-%';
  SELECT coalesce(array_agg(id), '{}') INTO v_drivers
    FROM public.drivers WHERE id::text LIKE '00000000-0000-4000-b000-%';
  SELECT coalesce(array_agg(id), '{}') INTO v_ps
    FROM public.payment_sessions WHERE id::text LIKE '00000000-0000-4000-a000-%';

  -- Dependents keyed by trip (offers, segments, stops, audit/ledger-ish rows ...)
  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables  t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND c.data_type = 'uuid'
       AND c.table_name NOT IN ('trips')
       AND c.column_name IN ('trip_id', 'related_trip_id', 'booking_id')
     ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format('DELETE FROM public.%I WHERE %I = ANY($1)', r.table_name, r.column_name)
        USING v_trips;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'cleanup: skip %.% (%)', r.table_name, r.column_name, SQLERRM;
    END;
  END LOOP;

  -- Dependents keyed by payment_session
  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables  t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.data_type = 'uuid'
       AND c.table_name NOT IN ('trips', 'payment_sessions')
       AND c.column_name IN ('payment_session_id')
  LOOP
    BEGIN
      EXECUTE format('DELETE FROM public.%I WHERE %I = ANY($1)', r.table_name, r.column_name)
        USING v_ps;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'cleanup: skip %.% (%)', r.table_name, r.column_name, SQLERRM;
    END;
  END LOOP;

  BEGIN
    DELETE FROM public.trips WHERE id = ANY(v_trips);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'cleanup: trips delete blocked (%)', SQLERRM;
  END;

  BEGIN
    DELETE FROM public.payment_sessions WHERE id = ANY(v_ps);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'cleanup: payment_sessions delete blocked (%)', SQLERRM;
  END;

  -- Dependents keyed by driver (e.g. commission-wallet accounts auto-created by driver triggers)
  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables  t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.data_type = 'uuid'
       AND c.table_name NOT IN ('drivers', 'trips')
       AND c.column_name IN ('driver_id')
     ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format('DELETE FROM public.%I WHERE %I = ANY($1)', r.table_name, r.column_name)
        USING v_drivers;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'cleanup: skip %.% (%)', r.table_name, r.column_name, SQLERRM;
    END;
  END LOOP;

  BEGIN
    DELETE FROM public.drivers WHERE id = ANY(v_drivers);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'cleanup: drivers delete blocked (%)', SQLERRM;
  END;
END
$cleanup$;

DROP SCHEMA IF EXISTS rmch_iso CASCADE;

\if :{?cleanup_only}
  \echo 'CLEANUP_ONLY: synthetic rows + rmch_iso schema removed'
  \quit
\endif

-- ---------------------------------------------------------------------------
-- 1. Helper schema
-- ---------------------------------------------------------------------------
CREATE SCHEMA rmch_iso;

CREATE TABLE rmch_iso.config (k text PRIMARY KEY, v text NOT NULL);

-- One row per worker action (what each parallel session observed).
CREATE TABLE rmch_iso.worker_out (
  seq      bigserial PRIMARY KEY,
  scn      text   NOT NULL,
  iter     int    NOT NULL,
  worker   text   NOT NULL,
  outcome  text   NOT NULL,
  rows_hit int,
  detail   jsonb  NOT NULL DEFAULT '{}'::jsonb,
  t_start  timestamptz,
  t_end    timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Immutable pre-race snapshot of fields that must survive a rematch.
CREATE TABLE rmch_iso.snap (
  trip_id uuid PRIMARY KEY,
  scheduled_at timestamptz,
  is_scheduled boolean,
  final_fare_pence int,
  gross_fare_pence int,
  estimated_total_pence int,
  base_fare_pence int,
  estimated_fare numeric,
  payment_session_id uuid,
  payment_state text,
  payment_method text,
  prev_searching_expires_at timestamptz
);

-- Point-in-time state capture (E is asserted before F mutates the same trip).
CREATE TABLE rmch_iso.state (
  seq bigserial PRIMARY KEY, scn text NOT NULL, iter int NOT NULL, label text NOT NULL,
  trip jsonb, offers jsonb, segs jsonb, extra jsonb, captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Verification verdicts (written by the .sql verify script).
CREATE TABLE rmch_iso.verdict (
  seq bigserial PRIMARY KEY,
  scenario text NOT NULL,
  check_name text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('PASS','FAIL','SKIPPED','INFO')),
  evidence text
);

-- Defaults when the .sh did not pass parsed values.
\if :{?cas_statuses}
  \set cas_source PARSED_FROM_TS_SSOT
\else
  \set cas_statuses '{confirmed,accepted,driver_assigned,en_route,en_route_to_pickup,driver_en_route,enroute_to_pickup,driver_arriving,queued,arrived,arrived_pickup,arrived_at_pickup,at_pickup,pickup_waiting,waiting,driver_arrived,waiting_at_pickup}'
  \set cas_source FALLBACK_HARDCODED
\endif
\if :{?find_minutes}
\else
  \set find_minutes 6
\endif

INSERT INTO rmch_iso.config(k, v) VALUES
  ('cas_statuses', :'cas_statuses'),
  ('cas_statuses_source', :'cas_source'),
  ('find_minutes', :'find_minutes');

-- Resolve an existing service area / region / in-area coordinate from the local DB
-- (trips.tr_enforce_trip_service_area_from_pickup + drivers.region_id NOT NULL).
DO $cfg$
DECLARE v record;
BEGIN
  SELECT t.service_area_id, t.pickup_latitude, t.pickup_longitude INTO v
    FROM public.trips t
   WHERE t.service_area_id IS NOT NULL AND t.pickup_latitude IS NOT NULL
     AND t.id::text NOT LIKE '00000000-0000-4000-%'
   ORDER BY t.created_at LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BLOCKER: no pre-existing local trip with service_area_id + pickup coordinates to borrow an in-area pickup from';
  END IF;
  INSERT INTO rmch_iso.config VALUES
    ('sa_id', v.service_area_id::text),
    ('pickup_lat', v.pickup_latitude::text),
    ('pickup_lng', v.pickup_longitude::text);
  INSERT INTO rmch_iso.config
    SELECT 'region_id', region_id::text FROM public.drivers
     WHERE region_id IS NOT NULL AND id::text NOT LIKE '00000000-0000-4000-%' LIMIT 1;
  IF NOT EXISTS (SELECT 1 FROM rmch_iso.config WHERE k = 'region_id') THEN
    RAISE EXCEPTION 'BLOCKER: no pre-existing local driver with region_id (drivers.region_id NOT NULL)';
  END IF;
  INSERT INTO rmch_iso.config
    SELECT 'gds_max_find_minutes', coalesce(max_driver_find_time_minutes::text, 'null')
      FROM public.global_dispatch_settings WHERE singleton = true;
END
$cfg$;

CREATE FUNCTION rmch_iso.cfg(p_k text) RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT v FROM rmch_iso.config WHERE k = p_k $$;

CREATE FUNCTION rmch_iso.uid(p_kind text, p_n bigint) RETURNS uuid
  LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-' ||
    CASE p_kind WHEN 't' THEN '8000' WHEN 'p' THEN '9000' WHEN 's' THEN 'a000' WHEN 'd' THEN 'b000' END
    || '-' || lpad(to_hex(p_n), 12, '0'))::uuid $$;

-- Synthetic drivers: D1 original, D2 replacement, D3 stale/late, D4 second replacement.
-- service_role claim bypasses enforce_driver_onboarding_verification (same as Edge service client).
CREATE FUNCTION rmch_iso.mk_drivers() RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  FOR i IN 1..4 LOOP
    INSERT INTO public.drivers(id, first_name, last_name, phone, email, service_area_id, region_id)
    VALUES (rmch_iso.uid('d', i), 'TEST', 'RMCH' || i, '+4400000000' || lpad(i::text, 2, '0'),
            'test-rmch-' || i || '@test.invalid',
            rmch_iso.cfg('sa_id')::uuid, rmch_iso.cfg('region_id')::uuid);
  END LOOP;
END $$;

-- Synthetic scheduled / instant trip.
--   scheduled_assigned : scheduled origin, driver D1 confirmed, committed
--   scheduled_arrived  : same + Arrived, pickup waiting running, one OPEN pickup waiting segment
--   instant_assigned   : instant origin, driver D1 confirmed
-- payment_session is a synthetic authorised_hold row (no provider call) with the SAME
-- id kept through rematch — that is the "payment_session_id preserved" assertion.
CREATE FUNCTION rmch_iso.mk_trip(p_n bigint, p_variant text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_trip uuid := rmch_iso.uid('t', p_n);
  v_ps   uuid := rmch_iso.uid('s', p_n);
  v_pax  uuid := rmch_iso.uid('p', p_n);
  v_d1   uuid := rmch_iso.uid('d', 1);
  v_sched boolean := p_variant IN ('scheduled_assigned', 'scheduled_arrived');
  v_sa   uuid := rmch_iso.cfg('sa_id')::uuid;
  v_ts   timestamptz;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  INSERT INTO public.payment_sessions(
    id, user_id, service_area_id, idempotency_key, client_action_id, status,
    provider_state, authorised_amount_pence)
  VALUES (v_ps, v_pax, v_sa, 'test-rmch-ps-' || p_n, 'test-rmch-ps-' || p_n,
          'authorised_hold', 'AUTHORISED', 1500);

  INSERT INTO public.trips(
    id, passenger_id, client_action_id, pickup_address, dropoff_address,
    pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude,
    financial_model, status, is_scheduled, scheduled_at, dispatch_mode, scheduled_status,
    payment_state, payment_method, payment_session_id, service_area_id,
    final_fare_pence, gross_fare_pence, estimated_total_pence, base_fare_pence, estimated_fare)
  VALUES (
    v_trip, v_pax, 'TEST-REMATCH-' || p_n, 'TEST pickup', 'TEST dropoff',
    rmch_iso.cfg('pickup_lat')::float8, rmch_iso.cfg('pickup_lng')::float8,
    rmch_iso.cfg('pickup_lat')::float8 + 0.005, rmch_iso.cfg('pickup_lng')::float8 + 0.01,
    'PLATFORM_COLLECTED',
    CASE WHEN v_sched THEN 'scheduled' ELSE 'searching' END,
    v_sched,
    CASE WHEN v_sched THEN date_trunc('second', now() + interval '3 hours') END,
    CASE WHEN v_sched THEN 'scheduled' ELSE 'instant' END,
    CASE WHEN v_sched THEN 'scheduled_pending' END,
    'payment_authorized', 'card', v_ps, v_sa,
    1500, 1500, 1500, 1500, 15.00);

  -- Assignment (D1 accepted) — through real trip triggers.
  UPDATE public.trips SET
    confirmed_driver_id = v_d1, driver_id = v_d1, status = 'confirmed',
    scheduled_status = CASE WHEN v_sched THEN 'scheduled_committed' END,
    scheduled_accepted_at = now()
  WHERE id = v_trip;

  IF p_variant = 'scheduled_arrived' THEN
    UPDATE public.trips SET
      status = 'arrived',
      arrived_at = now() - interval '5 minutes',
      pickup_arrived_at = now() - interval '5 minutes',
      pickup_waiting_started_at = now() - interval '5 minutes',
      pickup_waiting_counted_seconds = 300,
      waiting_geofence_status = 'counting'
    WHERE id = v_trip;
    INSERT INTO public.trip_waiting_segments(trip_id, location_type, started_at, inside_radius)
    VALUES (v_trip, 'pickup', now() - interval '5 minutes', true);
  END IF;

  -- D1's accepted ride_offers row. Inserted with triggers off (replica) so the push/eligibility
  -- triggers (net.http_post -> Edge) never run: "mock external push".
  EXECUTE 'SET LOCAL session_replication_role = replica';
  INSERT INTO public.ride_offers(trip_id, driver_id, status, broadcast_round, expires_at,
                                 responded_at, negotiation_status)
  VALUES (v_trip, v_d1, 'accepted', 1, now() + interval '1 hour', now(), 'confirmed');
  EXECUTE 'SET LOCAL session_replication_role = origin';

  INSERT INTO rmch_iso.snap
  SELECT t.id, t.scheduled_at, t.is_scheduled, t.final_fare_pence, t.gross_fare_pence,
         t.estimated_total_pence, t.base_fare_pence, t.estimated_fare, t.payment_session_id,
         t.payment_state::text, t.payment_method, t.searching_expires_at
    FROM public.trips t WHERE t.id = v_trip;
  RETURN v_trip;
END $$;

-- ---------------------------------------------------------------------------
-- Production mirrors: driver-cancel-before-pickup/index.ts
-- Each is a SEPARATE statement in the Edge function, so each is a separate SQL function
-- here (workers call them as separate autocommit statements, same as PostgREST calls).
-- ---------------------------------------------------------------------------

-- index.ts: replay check -> assigned driver guard -> isDriverAssignedToTrip ->
--           pre-pickup status -> started_at guard. (plain READ, no lock)
CREATE FUNCTION rmch_iso.dc_precheck(p_trip uuid, p_driver uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE t public.trips%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.trips WHERE id = p_trip;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  -- isIdempotentDriverRematchReplay
  IF lower(coalesce(t.status, '')) = 'searching_new_driver'
     AND (p_driver = ANY(coalesce(t.cancelled_driver_ids, '{}'))
          OR p_driver = ANY(coalesce(t.excluded_driver_ids, '{}'))) THEN
    RETURN 'idempotent';
  END IF;
  IF t.confirmed_driver_id IS NULL THEN RETURN 'invalid_state_no_driver'; END IF;
  IF t.confirmed_driver_id IS DISTINCT FROM p_driver THEN RETURN 'forbidden'; END IF;
  IF NOT (lower(coalesce(t.status, '')) = ANY (rmch_iso.cfg('cas_statuses')::text[])) THEN
    RETURN 'invalid_state_status';
  END IF;
  IF t.started_at IS NOT NULL THEN RETURN 'invalid_state_started'; END IF;
  RETURN 'proceed';
END $$;

-- index.ts L195-210: revoke offers BEFORE the trip CAS (own statement, own commit).
CREATE FUNCTION rmch_iso.dc_revoke(p_trip uuid) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  UPDATE public.ride_offers
     SET status = 'revoked', revoked_reason = 'driver_cancelled_before_pickup', updated_at = now()
   WHERE trip_id = p_trip AND status IN ('pending', 'accepted', 'offered', 'countered');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- index.ts L307-314: THE ownership CAS.
--   .update(patch).eq(TRIP_ASSIGNED_DRIVER_COLUMN /*confirmed_driver_id*/, driver.id)
--   .in("status", DRIVER_CANCEL_REMATCH_CAS_STATUSES).is("started_at", null)
-- Patch = buildScheduledOriginDriverCancelRematchPatch (scheduled origin) or
--         buildInstantOriginDriverCancelRematchPatch (instant origin).
-- p_hold_ms keeps the txn (and the row lock) open after the UPDATE to force a real
-- lock-wait + READ COMMITTED re-evaluation in the competing session.
CREATE FUNCTION rmch_iso.dc_cas_core(p_trip uuid, p_driver uuid, p_hold_ms int DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  t public.trips%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_find int := rmch_iso.cfg('find_minutes')::int;
  v_expires timestamptz := clock_timestamp() + make_interval(mins => rmch_iso.cfg('find_minutes')::int);
  v_max_round int;
  v_cycle_end int;
  v_convert boolean;
  v_rows int;
  v_excl uuid[];
  v_canc uuid[];
BEGIN
  SELECT * INTO t FROM public.trips WHERE id = p_trip;           -- trip read (no lock)
  SELECT coalesce(max(broadcast_round), 0) INTO v_max_round
    FROM public.ride_offers WHERE trip_id = p_trip;              -- maxRoundRow
  v_excl := array(SELECT DISTINCT x FROM unnest(coalesce(t.excluded_driver_ids,'{}') || p_driver) x);
  v_canc := array(SELECT DISTINCT x FROM unnest(coalesce(t.cancelled_driver_ids,'{}') || p_driver) x);

  -- isScheduledInstantConversionPending
  v_convert := CASE
    WHEN lower(coalesce(t.scheduled_status,'')) = 'converted_to_instant' THEN false
    WHEN lower(coalesce(t.dispatch_mode,'')) = 'instant' THEN false
    WHEN lower(coalesce(t.dispatch_mode,'')) = 'scheduled' THEN true
    WHEN t.is_scheduled IS TRUE THEN true
    ELSE t.scheduled_at IS NOT NULL END;

  IF v_convert THEN
    v_cycle_end := ((v_max_round + 2) / 3) * 3;                   -- resolveNextRematchBroadcastRound
    UPDATE public.trips SET
      -- buildScheduledUrgentConversionPatch
      dispatch_mode = 'instant',
      scheduled_status = 'converted_to_instant',
      status = 'searching_new_driver',                            -- rematch SSOT overrides 'searching'
      dispatch_status = 'broadcasting',
      broadcast_enabled = (t.broadcast_enabled IS DISTINCT FROM false),
      searching_expires_at = v_expires,
      current_broadcast_round = v_cycle_end,
      max_broadcast_rounds = greatest(9, v_cycle_end + 3),
      updated_at = v_now,
      pending_release_kind = NULL, pending_release_at = NULL, pending_release_driver_id = NULL,
      -- buildExclusiveFailureConversionPatch
      driver_id = NULL, confirmed_driver_id = NULL,
      scheduled_broadcast_at = v_now, commitment_time = NULL, scheduled_committed_at = NULL,
      excluded_driver_ids = v_excl,
      scheduled_jit_activate_at = NULL, scheduled_jit_eta_minutes = NULL,
      scheduled_jit_eta_observed_at = NULL, scheduled_jit_distance_kind = NULL,
      scheduled_jit_eta_source = NULL, scheduled_jit_basis_scheduled_at = NULL,
      scheduled_jit_eta_spike_samples = 0,
      scheduled_ack_status = 'cancelled', scheduled_ack_resolved_at = v_now,
      scheduled_ack_resolution_reason = 'driver_cancel_after_heading_to_pickup',
      -- buildScheduledOriginDriverCancelRematchPatch
      cancelled_by = 'driver', cancel_reason = 'driver_cancelled',
      cancelled_driver_ids = v_canc, scheduled_accepted_at = NULL, previous_driver_id = p_driver
    WHERE id = p_trip
      AND confirmed_driver_id = p_driver
      AND status = ANY (rmch_iso.cfg('cas_statuses')::text[])
      AND started_at IS NULL;
  ELSE
    v_cycle_end := ((coalesce(nullif(v_max_round,0), t.current_broadcast_round, 0) + 2) / 3) * 3;
    UPDATE public.trips SET
      -- buildInstantOriginDriverCancelRematchPatch
      status = 'searching_new_driver', dispatch_status = 'broadcasting', broadcast_enabled = true,
      negotiation_status = NULL, negotiation_locked_until = NULL,
      driver_id = NULL, confirmed_driver_id = NULL,
      current_offer_driver_id = NULL, negotiation_owner_driver_id = NULL,
      cancelled_driver_ids = v_canc, excluded_driver_ids = v_excl,
      scheduled_accepted_at = NULL, cancelled_by = 'driver', cancel_reason = 'driver_cancelled',
      current_broadcast_round = v_cycle_end, searching_expires_at = v_expires,
      previous_driver_id = p_driver, updated_at = v_now
    WHERE id = p_trip
      AND confirmed_driver_id = p_driver
      AND status = ANY (rmch_iso.cfg('cas_statuses')::text[])
      AND started_at IS NULL;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF p_hold_ms > 0 THEN PERFORM pg_sleep(p_hold_ms / 1000.0); END IF;
  RETURN jsonb_build_object(
    'rows', v_rows, 'branch', CASE WHEN v_convert THEN 'scheduled_origin' ELSE 'instant_origin' END,
    'searching_expires_at', CASE WHEN v_rows = 1 THEN v_expires END,
    'current_broadcast_round', CASE WHEN v_rows = 1 THEN v_cycle_end END);
END $$;

-- index.ts L333-345: best-effort waiting reset AFTER the CAS (closeAllOpenWaitingSegmentsForTrip +
-- buildRematchPickupWaitingResetPatch .is("driver_id", null).is("started_at", null)).
CREATE FUNCTION rmch_iso.dc_post_cas(p_trip uuid) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  UPDATE public.trip_waiting_segments SET ended_at = now()
   WHERE trip_id = p_trip AND ended_at IS NULL;
  UPDATE public.trips SET
    arrived_at = NULL, pickup_arrived_at = NULL, pickup_waiting_started_at = NULL,
    pickup_paid_waiting_started_at = NULL, free_wait_expires_at = NULL,
    grace_period_expired_at = NULL, pickup_waiting_counted_seconds = 0,
    pickup_waiting_charge_pence = 0, pickup_waiting_intervals_charged = 0,
    waiting_geofence_status = 'not_started', updated_at = now()
  WHERE id = p_trip AND driver_id IS NULL AND started_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- A trigger/constraint rejection inside the CAS is a worker outcome, not a harness crash.
CREATE FUNCTION rmch_iso.dc_cas(p_trip uuid, p_driver uuid, p_hold_ms int DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN rmch_iso.dc_cas_core(p_trip, p_driver, p_hold_ms);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('rows', -1, 'error', SQLERRM, 'sqlstate', SQLSTATE);
END $$;

-- Trip already rematched through the real predicates (state used by scenarios C/F).
CREATE FUNCTION rmch_iso.mk_rematched(p_n bigint) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_trip uuid; v_res jsonb;
BEGIN
  v_trip := rmch_iso.mk_trip(p_n, 'scheduled_assigned');
  PERFORM rmch_iso.dc_revoke(v_trip);
  v_res := rmch_iso.dc_cas(v_trip, rmch_iso.uid('d', 1), 0);
  IF (v_res ->> 'rows')::int <> 1 THEN
    RAISE EXCEPTION 'mk_rematched: CAS missed for %: %', v_trip, v_res;
  END IF;
  RETURN v_trip;
END $$;

-- Pickup + drop-off stops the REAL Start Trip RPC requires (stop_index 0 = arrived pickup).
CREATE FUNCTION rmch_iso.mk_stops(p_trip uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  INSERT INTO public.trip_stops(trip_id, stop_index, type, address, lat, lng, status, arrived_at) VALUES
    (p_trip, 0, 'pickup',  'TEST pickup',  rmch_iso.cfg('pickup_lat')::float8, rmch_iso.cfg('pickup_lng')::float8,
     'arrived', now() - interval '5 minutes'),
    (p_trip, 1, 'dropoff', 'TEST dropoff', rmch_iso.cfg('pickup_lat')::float8 + 0.005, rmch_iso.cfg('pickup_lng')::float8 + 0.01,
     'pending', NULL);
END $$;

-- THE REAL production RPC: public.finalize_pickup_waiting_and_start_trip(trip, driver)
--   (trips row FOR UPDATE -> driver_id guard -> terminal guard -> started_at idempotency ->
--    pickup waiting money finalize -> trip_stops -> started_at / status = in_progress).
-- p_hold_ms keeps the transaction (and the trip row lock) open after the RPC returns so the
-- competing Cancel CAS genuinely blocks on the row lock and re-evaluates under READ COMMITTED.
-- No mirror: this replaces the former start_mirror (the table public.driver_live_locations the
-- RPC reads is now provided locally by migration 20270222140000).
CREATE FUNCTION rmch_iso.start_real(p_trip uuid, p_driver uuid, p_hold_ms int DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  v := public.finalize_pickup_waiting_and_start_trip(p_trip, p_driver);
  IF p_hold_ms > 0 THEN PERFORM pg_sleep(p_hold_ms / 1000.0); END IF;
  RETURN CASE WHEN coalesce((v ->> 'ok')::boolean, false) THEN v
              ELSE v || jsonb_build_object('ok', false) END;
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM, 'sqlstate', SQLSTATE);
END $$;

-- ---------------------------------------------------------------------------
-- Offers (push/eligibility triggers off => "mock external push", see mk_trip)
-- ---------------------------------------------------------------------------
-- p_conflict_ignore => INSERT ... ON CONFLICT (trip_id, driver_id, broadcast_round) DO NOTHING
CREATE FUNCTION rmch_iso.ins_offer(
  p_trip uuid, p_driver uuid, p_round int, p_status text DEFAULT 'pending',
  p_expires timestamptz DEFAULT NULL, p_conflict_ignore boolean DEFAULT false,
  p_revoked_reason text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  EXECUTE 'SET LOCAL session_replication_role = replica';
  INSERT INTO public.ride_offers(trip_id, driver_id, status, broadcast_round, expires_at, revoked_reason)
  VALUES (p_trip, p_driver, p_status, p_round, coalesce(p_expires, now() + interval '5 minutes'), p_revoked_reason)
  ON CONFLICT (trip_id, driver_id, broadcast_round) DO NOTHING
  RETURNING id INTO v_id;
  EXECUTE 'SET LOCAL session_replication_role = origin';
  IF v_id IS NULL AND NOT p_conflict_ignore THEN
    RAISE EXCEPTION 'ins_offer: conflict on (%,%,%)', p_trip, p_driver, p_round USING ERRCODE = '23505';
  END IF;
  RETURN v_id;
END $$;

-- Worker result recorder.
CREATE FUNCTION rmch_iso.rec(p_scn text, p_iter int, p_worker text, p_outcome text, p_rows int,
                             p_detail jsonb, p_t_start timestamptz) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO rmch_iso.worker_out(scn, iter, worker, outcome, rows_hit, detail, t_start)
  VALUES (p_scn, p_iter, p_worker, p_outcome, p_rows,
          coalesce(p_detail, '{}'::jsonb) ||
          jsonb_build_object('dur_ms', round(extract(epoch FROM (clock_timestamp() - p_t_start)) * 1000)),
          p_t_start) $$;

CREATE FUNCTION rmch_iso.cap(p_scn text, p_iter int, p_label text, p_trip uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO rmch_iso.state(scn, iter, label, trip, offers, segs, extra)
  SELECT p_scn, p_iter, p_label,
         (SELECT to_jsonb(t) FROM public.trips t WHERE t.id = p_trip),
         coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.broadcast_round, o.driver_id) FROM public.ride_offers o WHERE o.trip_id = p_trip), '[]'::jsonb),
         coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.started_at) FROM public.trip_waiting_segments g WHERE g.trip_id = p_trip), '[]'::jsonb),
         jsonb_build_object(
           'd1_excluded', public.driver_is_excluded_from_trip(p_trip, rmch_iso.uid('d', 1)),
           'd2_excluded', public.driver_is_excluded_from_trip(p_trip, rmch_iso.uid('d', 2)),
           'd4_excluded', public.driver_is_excluded_from_trip(p_trip, rmch_iso.uid('d', 4)),
           'now', clock_timestamp()) $$;

-- ---------------------------------------------------------------------------
-- Waiting segments: waitingSegmentClock.ts openWaitingSegmentOrReuse mirrors the production
-- open path:  public.open_waiting_segment_or_reuse(...)  (INSERT ... ON CONFLICT DO NOTHING on
-- uq_trip_waiting_segments_one_open_per_session, else reuse the winner's row).
-- p_gap_ms keeps the winner's INSERT uncommitted so concurrent openers genuinely block on the
-- unique index entry (the PostgREST round-trip window in production).
-- ---------------------------------------------------------------------------
CREATE FUNCTION rmch_iso.wseg_open_prod(p_trip uuid, p_gap_ms int DEFAULT 0) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_opened boolean;
BEGIN
  SELECT r.opened INTO v_opened
    FROM public.open_waiting_segment_or_reuse(p_trip, 'pickup', NULL, NULL, clock_timestamp(), NULL, 'rmch_harness') r;
  IF p_gap_ms > 0 THEN PERFORM pg_sleep(p_gap_ms / 1000.0); END IF;
  RETURN CASE WHEN v_opened THEN 'opened' ELSE 'already_open' END;
END $$;

-- LEGACY path (pre-fix): SELECT open rows, gap, then plain INSERT. The DB must now REJECT the
-- overlap (unique_violation) instead of letting a second open row exist.
CREATE FUNCTION rmch_iso.wseg_open_legacy(p_trip uuid, p_gap_ms int DEFAULT 0) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_open int;
BEGIN
  SELECT count(*) INTO v_open FROM public.trip_waiting_segments
   WHERE trip_id = p_trip AND location_type = 'pickup' AND ended_at IS NULL;
  IF p_gap_ms > 0 THEN PERFORM pg_sleep(p_gap_ms / 1000.0); END IF;
  IF v_open > 0 THEN RETURN 'already_open'; END IF;
  INSERT INTO public.trip_waiting_segments(trip_id, location_type, started_at, ended_at, inside_radius)
  VALUES (p_trip, 'pickup', clock_timestamp(), NULL, true);
  RETURN 'opened';
EXCEPTION WHEN unique_violation THEN
  RETURN 'unique_violation';
END $$;

-- planOpenWaitingSegments(counting=true): DEFENSIVE recovery only now — keep earliest open row,
-- close every other open row (a no-op while uq_trip_waiting_segments_one_open_per_session holds).
CREATE FUNCTION rmch_iso.wseg_heal(p_trip uuid) RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_keep uuid; n int;
BEGIN
  SELECT id INTO v_keep FROM public.trip_waiting_segments
   WHERE trip_id = p_trip AND location_type = 'pickup' AND ended_at IS NULL
   ORDER BY started_at ASC, id ASC LIMIT 1;
  IF v_keep IS NULL THEN RETURN 0; END IF;
  UPDATE public.trip_waiting_segments
     SET ended_at = greatest(clock_timestamp(), started_at)
   WHERE trip_id = p_trip AND location_type = 'pickup' AND ended_at IS NULL AND id <> v_keep;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- sumSegmentSecondsAt: UNION of [started_at, coalesce(ended_at, p_at)) — overlaps never double count.
CREATE FUNCTION rmch_iso.wseg_union_seconds(p_trip uuid, p_at timestamptz) RETURNS numeric
LANGUAGE sql STABLE AS $$
  WITH iv AS (
    SELECT started_at AS s, least(coalesce(ended_at, p_at), p_at) AS e
      FROM public.trip_waiting_segments
     WHERE trip_id = p_trip AND location_type = 'pickup' AND least(coalesce(ended_at, p_at), p_at) > started_at
  ), ord AS (
    SELECT s, e, max(e) OVER (ORDER BY s, e ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max FROM iv
  ), grp AS (
    SELECT s, e, sum(CASE WHEN prev_max IS NULL OR s > prev_max THEN 1 ELSE 0 END) OVER (ORDER BY s, e) AS g FROM ord
  )
  SELECT coalesce(sum(extract(epoch FROM (mx - mn))), 0)
    FROM (SELECT g, min(s) AS mn, max(e) AS mx FROM grp GROUP BY g) m $$;

-- ---------------------------------------------------------------------------
-- Real production RPC: public.accept_ride_offer(offer, driver) (FOR UPDATE offer -> FOR UPDATE trip,
-- status/driver guards, driver_is_excluded_from_trip). Wrapped so an exception is a recorded outcome.
-- p_hold_ms keeps the transaction (and the trip row lock) open after a successful accept.
-- ---------------------------------------------------------------------------
CREATE FUNCTION rmch_iso.accept_safe(p_trip uuid, p_driver uuid, p_hold_ms int DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_offer uuid; v_res jsonb; v_detail text; v_ctx text;
BEGIN
  SELECT id INTO v_offer FROM public.ride_offers
   WHERE trip_id = p_trip AND driver_id = p_driver ORDER BY broadcast_round DESC LIMIT 1;
  IF v_offer IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'NO_OFFER_ROW'); END IF;
  v_res := public.accept_ride_offer(v_offer, p_driver);
  IF p_hold_ms > 0 THEN PERFORM pg_sleep(p_hold_ms / 1000.0); END IF;
  RETURN v_res;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL, v_ctx = PG_EXCEPTION_CONTEXT;
  RETURN jsonb_build_object('success', false, 'error', 'EXCEPTION', 'message', SQLERRM, 'sqlstate', SQLSTATE,
                            'pg_detail', left(v_detail, 600), 'pg_context', left(v_ctx, 400));
END $$;

SELECT 1 AS drivers_created FROM (SELECT rmch_iso.mk_drivers()) x;
\echo 'SETUP_OK drivers=4 schema=rmch_iso'
