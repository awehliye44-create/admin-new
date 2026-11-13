-- ============================================================================
-- Negotiation lock-order / concurrency harness  --  SETUP (+ CLEANUP)
--   migration under test: 20270222180000_negotiation_rpc_trip_first_lock_order.sql
--
-- LOCAL DB ONLY. No Edge, no Revolut, no push (offers are inserted with triggers off).
-- Drives the REAL RPCs: customer_counter_ride_offer, driver_send_preset_offer,
-- accept_ride_offer, expire_negotiation_offer, decline_ride_offer, driver_cancel_negotiation,
-- apply_customer_decline_grace, admin_cancel_trip_negotiation, apply_terminal_trip_cancellation,
-- driver_cancel_before_start_rematch.
--
-- Everything is removable:
--   * synthetic UUIDs 00000000-0000-4000-{8100 trips | 9100 passengers/customers |
--                                         a100 payment_sessions | b100 drivers}-<n>
--   * trips.client_action_id = 'TEST-NEG-<n>'
--   * helper schema neg_iso
--
-- psql variables: -v cleanup_only=1   remove every synthetic row + schema, then exit
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on

DO $cleanup$
DECLARE
  r record;
  v_trips   uuid[];
  v_drivers uuid[];
  v_ps      uuid[];
  v_cust    uuid[];
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  SELECT coalesce(array_agg(id), '{}') INTO v_trips
    FROM public.trips WHERE id::text LIKE '00000000-0000-4000-8100-%';
  SELECT coalesce(array_agg(id), '{}') INTO v_drivers
    FROM public.drivers WHERE id::text LIKE '00000000-0000-4000-b100-%';
  SELECT coalesce(array_agg(id), '{}') INTO v_ps
    FROM public.payment_sessions WHERE id::text LIKE '00000000-0000-4000-a100-%';
  SELECT coalesce(array_agg(id), '{}') INTO v_cust
    FROM public.customers WHERE id::text LIKE '00000000-0000-4000-9100-%';

  UPDATE public.customers SET active_trip_id = NULL WHERE id = ANY(v_cust);

  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables  t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.data_type = 'uuid'
       AND c.table_name NOT IN ('trips')
       AND c.column_name IN ('trip_id', 'related_trip_id', 'booking_id')
     ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format('DELETE FROM public.%I WHERE %I = ANY($1)', r.table_name, r.column_name) USING v_trips;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'cleanup: skip %.% (%)', r.table_name, r.column_name, SQLERRM;
    END;
  END LOOP;

  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables  t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.data_type = 'uuid'
       AND c.table_name NOT IN ('trips', 'payment_sessions')
       AND c.column_name IN ('payment_session_id')
  LOOP
    BEGIN
      EXECUTE format('DELETE FROM public.%I WHERE %I = ANY($1)', r.table_name, r.column_name) USING v_ps;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'cleanup: skip %.% (%)', r.table_name, r.column_name, SQLERRM;
    END;
  END LOOP;

  BEGIN
    DELETE FROM public.trips WHERE id = ANY(v_trips);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'cleanup: trips delete blocked (%)', SQLERRM;
  END;
  BEGIN
    DELETE FROM public.payment_sessions WHERE id = ANY(v_ps);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'cleanup: payment_sessions delete blocked (%)', SQLERRM;
  END;
  BEGIN
    DELETE FROM public.customers WHERE id = ANY(v_cust);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'cleanup: customers delete blocked (%)', SQLERRM;
  END;

  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables  t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.data_type = 'uuid'
       AND c.table_name NOT IN ('drivers', 'trips')
       AND c.column_name IN ('driver_id')
     ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format('DELETE FROM public.%I WHERE %I = ANY($1)', r.table_name, r.column_name) USING v_drivers;
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

DROP TRIGGER IF EXISTS neg_iso_fault ON public.ride_offers;
DROP SCHEMA IF EXISTS neg_iso CASCADE;

\if :{?cleanup_only}
  \echo 'CLEANUP_ONLY: synthetic rows + neg_iso schema removed'
  \quit
\endif

-- ---------------------------------------------------------------------------
-- Preconditions: the RPCs under test must exist (a missing RPC FAILS the run, never skips).
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(x, ', ') INTO v_missing FROM unnest(ARRAY[
    'public.customer_counter_ride_offer(uuid,integer,uuid,uuid)',
    'public.customer_counter_ride_offer_core(uuid,integer,uuid,uuid)',
    'public.driver_send_preset_offer(uuid,integer,integer[],integer)',
    'public.driver_send_preset_offer_core(uuid,integer,integer[],integer)',
    'public.driver_cancel_negotiation_core(uuid,uuid)',
    'public.expire_negotiation_offer_core(uuid)',
    'public.decline_ride_offer_core(uuid,uuid,text)',
    'public.apply_customer_decline_grace_core(uuid,text)',
    'public.negotiation_contention_outcome(uuid,text)',
    'public.accept_ride_offer(uuid,uuid,boolean)',
    'public.accept_ride_offer_core(uuid,uuid,boolean)',
    'public.admin_cancel_trip_negotiation(uuid,text)',
    'public.apply_terminal_trip_cancellation(uuid,text,text)',
    'public.driver_cancel_before_start_rematch(uuid,uuid,text,text,jsonb)'
  ]) AS x WHERE to_regprocedure(x) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'BLOCKER: required RPC(s) missing (apply 20270222180000 first): %', v_missing;
  END IF;
END
$pre$;

CREATE SCHEMA neg_iso;

CREATE TABLE neg_iso.config (k text PRIMARY KEY, v text NOT NULL);

CREATE TABLE neg_iso.worker_out (
  seq      bigserial PRIMARY KEY,
  scn      text   NOT NULL,
  iter     int    NOT NULL,
  worker   text   NOT NULL,
  action   text   NOT NULL,
  result   jsonb  NOT NULL DEFAULT '{}'::jsonb,
  t_start  timestamptz,
  t_end    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE neg_iso.trip_scn (
  trip_id uuid PRIMARY KEY, scn text NOT NULL, iter int NOT NULL, variant text NOT NULL
);

CREATE TABLE neg_iso.verdict (
  seq bigserial PRIMARY KEY,
  scenario text NOT NULL,
  check_name text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('PASS','FAIL','SKIPPED','INFO')),
  evidence text
);

-- Borrow an in-area service area / region / pickup from a pre-existing (non-synthetic) trip + driver
-- (tr_enforce_trip_service_area_from_pickup, drivers.region_id NOT NULL).
DO $cfg$
DECLARE v record;
BEGIN
  SELECT t.service_area_id, t.pickup_latitude, t.pickup_longitude INTO v
    FROM public.trips t
   WHERE t.service_area_id IS NOT NULL AND t.pickup_latitude IS NOT NULL
     AND t.id::text NOT LIKE '00000000-0000-4000-%'
   ORDER BY t.created_at LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BLOCKER: no pre-existing trip with service_area_id + pickup coordinates (seed supabase/tests/ci/pg_harness_seed.sql)';
  END IF;
  INSERT INTO neg_iso.config VALUES
    ('sa_id', v.service_area_id::text), ('pickup_lat', v.pickup_latitude::text), ('pickup_lng', v.pickup_longitude::text);
  INSERT INTO neg_iso.config
    SELECT 'region_id', region_id::text FROM public.drivers
     WHERE region_id IS NOT NULL AND id::text NOT LIKE '00000000-0000-4000-%' LIMIT 1;
  IF NOT EXISTS (SELECT 1 FROM neg_iso.config WHERE k = 'region_id') THEN
    RAISE EXCEPTION 'BLOCKER: no pre-existing driver with region_id';
  END IF;
END
$cfg$;

CREATE FUNCTION neg_iso.cfg(p_k text) RETURNS text LANGUAGE sql STABLE AS $$ SELECT v FROM neg_iso.config WHERE k = p_k $$;

CREATE FUNCTION neg_iso.uid(p_kind text, p_n bigint) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('00000000-0000-4000-' ||
    CASE p_kind WHEN 't' THEN '8100' WHEN 'p' THEN '9100' WHEN 's' THEN 'a100' WHEN 'd' THEN 'b100' END
    || '-' || lpad(to_hex(p_n), 12, '0'))::uuid $$;

CREATE FUNCTION neg_iso.mk_drivers() RETURNS void LANGUAGE plpgsql AS $$
DECLARE i int;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  FOR i IN 1..4 LOOP
    INSERT INTO public.drivers(id, first_name, last_name, phone, email, service_area_id, region_id)
    VALUES (neg_iso.uid('d', i), 'TEST', 'NEG' || i, '+4400000010' || lpad(i::text, 2, '0'),
            'test-neg-' || i || '@test.invalid', neg_iso.cfg('sa_id')::uuid, neg_iso.cfg('region_id')::uuid);
  END LOOP;
END $$;

-- Offer fixture. Triggers off (push / delivery / eligibility are not under test).
CREATE FUNCTION neg_iso.mk_offer(
  p_trip uuid, p_driver uuid, p_round int, p_status text, p_neg_status text DEFAULT NULL,
  p_driver_fare int DEFAULT NULL, p_options jsonb DEFAULT NULL, p_expires interval DEFAULT interval '10 minutes',
  p_revoked_reason text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid;
BEGIN
  EXECUTE 'SET LOCAL session_replication_role = replica';
  INSERT INTO public.ride_offers(trip_id, driver_id, status, broadcast_round, expires_at, negotiation_status,
                                 driver_offer_fare, offer_options, offer_snapshot, responded_at,
                                 dispatch_wave, effective_commission_percent, base_commission_percent,
                                 offered_driver_net_pence, revoked_reason)
  VALUES (p_trip, p_driver, p_status, p_round, now() + p_expires, p_neg_status, p_driver_fare, p_options,
          jsonb_build_object('baseFarePence', 600, 'driver_net_fare_pence', 540, 'driver_earnings_pence', 540,
                             'driver_net_preview_pence', 540, 'commission_percent', 10),
          CASE WHEN p_status = 'accepted' THEN now() END,
          1, 10, 10, 540, p_revoked_reason)
  RETURNING id INTO v_id;
  EXECUTE 'SET LOCAL session_replication_role = origin';
  RETURN v_id;
END $$;

-- Base trip: searching, payment-authorised, committed 600p, customer row attached.
CREATE FUNCTION neg_iso.mk_base_trip(p_n bigint) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_trip uuid := neg_iso.uid('t', p_n);
  v_ps   uuid := neg_iso.uid('s', p_n);
  v_pax  uuid := neg_iso.uid('p', p_n);
  v_sa   uuid := neg_iso.cfg('sa_id')::uuid;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  INSERT INTO public.payment_sessions(id, user_id, service_area_id, idempotency_key, client_action_id, status,
                                      provider_state, authorised_amount_pence)
  VALUES (v_ps, v_pax, v_sa, 'test-neg-ps-' || p_n, 'test-neg-ps-' || p_n, 'authorised_hold', 'AUTHORISED', 1500);

  INSERT INTO public.trips(
    id, passenger_id, client_action_id, pickup_address, dropoff_address,
    pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude,
    financial_model, status, payment_state, payment_method, payment_session_id, service_area_id,
    final_fare_pence, gross_fare_pence, estimated_total_pence, base_fare_pence, estimated_fare,
    locked_base_fare_pence, final_customer_fare_pence)
  VALUES (
    v_trip, v_pax, 'TEST-NEG-' || p_n, 'TEST pickup', 'TEST dropoff',
    neg_iso.cfg('pickup_lat')::float8, neg_iso.cfg('pickup_lng')::float8,
    neg_iso.cfg('pickup_lat')::float8 + 0.005, neg_iso.cfg('pickup_lng')::float8 + 0.01,
    'PLATFORM_COLLECTED', 'searching', 'payment_authorized', 'card', v_ps, v_sa,
    600, 600, 600, 600, 6.00, 600, 600);

  -- customers row: the rematch RPC proves customers.active_trip_id is preserved (user_id NULL: no auth.users FK).
  EXECUTE 'SET LOCAL session_replication_role = replica';
  INSERT INTO public.customers(id, user_id, active_trip_id, first_name, last_name)
  VALUES (v_pax, NULL, v_trip, 'Test', 'Customer');
  EXECUTE 'SET LOCAL session_replication_role = origin';
  RETURN v_trip;
END $$;

-- Scenario trips.
--   negotiating : O1 (D1) countered / waiting_customer (driver sent 600, chips 540/570/600), trip negotiating and
--                 held by D1; O2 (D2) revoked 'negotiation_locked' (what driver_send_preset_offer leaves behind)
--   waiting_final : negotiating + the customer countered 570 via the REAL RPC (O1 waiting_driver_final)
--   preset_pending: O1 (D1) + O2 (D2) plain pending (driver_send_preset_offer / cancel / decline targets)
--   assigned_stale: trip assigned to D1 (accepted offer), stale O3 (D3) waiting_customer left from a prior cycle
CREATE FUNCTION neg_iso.mk_trip(p_n bigint, p_variant text, p_scn text, p_iter int) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_trip uuid := neg_iso.mk_base_trip(p_n);
  v_pax uuid := neg_iso.uid('p', p_n);
  d1 uuid := neg_iso.uid('d', 1); d2 uuid := neg_iso.uid('d', 2); d3 uuid := neg_iso.uid('d', 3);
  o1 uuid; r jsonb;
BEGIN
  IF p_variant IN ('negotiating', 'waiting_final') THEN
    o1 := neg_iso.mk_offer(v_trip, d1, 1, 'countered', 'waiting_customer', 600, '[540,570,600]'::jsonb);
    -- Exactly what driver_send_preset_offer leaves behind: the sibling offer is revoked (negotiation_locked),
    -- the trip is held by D1 until negotiation_locked_until, dispatch is paused.
    PERFORM neg_iso.mk_offer(v_trip, d2, 2, 'revoked', NULL, NULL, NULL, interval '10 minutes', 'negotiation_locked');
    UPDATE public.trips SET status = 'negotiating', negotiation_owner_driver_id = d1, current_offer_driver_id = d1,
           current_negotiation_id = o1, negotiation_locked_until = now() + interval '10 minutes',
           dispatch_status = 'paused', broadcast_enabled = false WHERE id = v_trip;
    IF p_variant = 'waiting_final' THEN
      r := public.customer_counter_ride_offer(o1, 570, v_pax, NULL);
      IF coalesce((r ->> 'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'mk_trip waiting_final: serial counter failed: %', r;
      END IF;
    END IF;
  ELSIF p_variant = 'preset_pending' THEN
    PERFORM neg_iso.mk_offer(v_trip, d1, 1, 'pending');
    PERFORM neg_iso.mk_offer(v_trip, d2, 2, 'pending');
  ELSIF p_variant = 'assigned_stale' THEN
    UPDATE public.trips SET confirmed_driver_id = d1, driver_id = d1, status = 'confirmed' WHERE id = v_trip;
    PERFORM neg_iso.mk_offer(v_trip, d1, 1, 'accepted', 'confirmed');
    PERFORM neg_iso.mk_offer(v_trip, d3, 0, 'countered', 'waiting_customer', 600, '[540,570,600]'::jsonb);
  ELSE
    RAISE EXCEPTION 'unknown variant %', p_variant;
  END IF;
  INSERT INTO neg_iso.trip_scn VALUES (v_trip, p_scn, p_iter, p_variant);
  RETURN v_trip;
END $$;

CREATE FUNCTION neg_iso.offer_of(p_trip uuid, p_driver_n int) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM public.ride_offers WHERE trip_id = p_trip AND driver_id = neg_iso.uid('d', p_driver_n)
   ORDER BY broadcast_round DESC LIMIT 1 $$;

-- One negotiation action through the REAL RPC. Never throws: records SQLSTATE so the verifier can tell a
-- domain error (P0001 business message) from a raw lock failure (40P01 / 40001 / 55P03).
-- p_hold_ms keeps the transaction (and every lock the RPC took) open after it returns.
CREATE FUNCTION neg_iso.act(p_action text, p_trip uuid, p_offer uuid, p_driver uuid, p_fare int, p_hold_ms int DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_res jsonb; v_pax uuid;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  SELECT passenger_id INTO v_pax FROM public.trips WHERE id = p_trip;
  v_res := CASE p_action
    WHEN 'counter'         THEN public.customer_counter_ride_offer(p_offer, p_fare, v_pax, NULL)
    WHEN 'send_preset'     THEN public.driver_send_preset_offer(p_offer, p_fare, ARRAY[540, 570, 600], 30)
    WHEN 'accept'          THEN public.accept_ride_offer(p_offer, p_driver, true)    -- driver accepts the customer counter
    WHEN 'accept_offer'    THEN public.accept_ride_offer(p_offer, p_driver, false)   -- customer accepts the driver's offer
    WHEN 'expire'          THEN public.expire_negotiation_offer(p_offer)
    WHEN 'decline'         THEN public.decline_ride_offer(p_offer, p_driver, 'declined')
    WHEN 'driver_cancel_neg' THEN public.driver_cancel_negotiation(p_offer, p_driver)
    WHEN 'grace'           THEN public.apply_customer_decline_grace(p_offer, 'decline')
    WHEN 'admin_cancel'    THEN public.admin_cancel_trip_negotiation(p_trip, 'neg_iso_admin_cancel')
    WHEN 'customer_cancel' THEN public.apply_terminal_trip_cancellation(p_trip, 'customer', 'neg_iso_customer_cancel')
    WHEN 'rematch'         THEN public.driver_cancel_before_start_rematch(p_trip, p_driver, 'neg_iso',
                                  'neg-iso-' || p_trip::text, '{"actor_mode":"edge"}'::jsonb)
    ELSE NULL END;
  IF v_res IS NULL AND p_action NOT IN ('counter','send_preset','accept','accept_offer','expire','decline','driver_cancel_neg','grace','admin_cancel','customer_cancel','rematch') THEN
    RAISE EXCEPTION 'unknown action %', p_action;
  END IF;
  IF p_hold_ms > 0 THEN PERFORM pg_sleep(p_hold_ms / 1000.0); END IF;
  RETURN jsonb_build_object('threw', false, 'res', v_res,
    'ok', coalesce((v_res ->> 'success')::boolean, (v_res ->> 'ok')::boolean, false));
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('threw', true, 'ok', false, 'sqlstate', SQLSTATE, 'message', SQLERRM,
    'raw_contention', SQLSTATE IN ('40P01', '40001', '55P03'));
END $$;

CREATE FUNCTION neg_iso.rec(p_scn text, p_iter int, p_worker text, p_action text, p_result jsonb, p_t_start timestamptz)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO neg_iso.worker_out(scn, iter, worker, action, result, t_start)
  VALUES (p_scn, p_iter, p_worker, p_action,
          coalesce(p_result, '{}'::jsonb) ||
          jsonb_build_object('dur_ms', round(extract(epoch FROM (clock_timestamp() - p_t_start)) * 1000)),
          p_t_start) $$;

-- ---------------------------------------------------------------------------
-- Fault injection (scenario M): raise a REAL 40P01 inside the core UPDATE for synthetic trips.
-- A sequence is used because a sequence value survives the sub-transaction rollback.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE neg_iso.fault_seq;
CREATE FUNCTION neg_iso.fault_fn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_limit int := coalesce(nullif(current_setting('neg_iso.fault_limit', true), '')::int, 0);
BEGIN
  IF v_limit > 0 AND nextval('neg_iso.fault_seq') <= v_limit THEN
    RAISE EXCEPTION 'neg_iso injected deadlock' USING ERRCODE = '40P01';
  END IF;
  RETURN NEW;
END $$;

-- Lock-order proof probe: is the OFFER row free while an RPC is still waiting for the TRIP lock?
CREATE FUNCTION neg_iso.probe_offer_lock(p_offer uuid) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM public.ride_offers WHERE id = p_offer FOR UPDATE NOWAIT;
  RETURN 'free';
EXCEPTION WHEN lock_not_available THEN
  RETURN 'locked';
END $$;

SELECT 1 AS drivers_created FROM (SELECT neg_iso.mk_drivers()) x;
\echo 'SETUP_OK drivers=4 schema=neg_iso'
