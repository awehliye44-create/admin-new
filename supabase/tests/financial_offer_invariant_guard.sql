-- ============================================================================
-- financial offer invariant guard  --  SQL EXECUTION TEST
--   migration: 20270222160000_financial_offer_invariant_guard.sql
--
-- LOCAL DB ONLY. One transaction, ends in ROLLBACK. Both candidate migrations
-- (committed-offer SSOT + the guard) are applied INSIDE the transaction.
--
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 \
--     -v ssot_migration=supabase/migrations/20270222150000_committed_offer_fare_sql_ssot.sql \
--     -v migration=supabase/migrations/20270222160000_financial_offer_invariant_guard.sql \
--     -f supabase/tests/financial_offer_invariant_guard.sql
-- ============================================================================
\set ON_ERROR_STOP on
\if :{?migration}
\else
  \echo 'usage: -v ssot_migration=<150000 path> -v migration=<160000 path>'
  \quit
\endif

BEGIN;
SET LOCAL client_min_messages = warning;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);

\i :ssot_migration
\i :migration

SET LOCAL client_min_messages = notice;

ALTER TABLE public.ride_offers DISABLE TRIGGER tr_block_ineligible_ride_offer;
ALTER TABLE public.ride_offers DISABLE TRIGGER tr_booking_delivery_booking_sent;
ALTER TABLE public.ride_offers DISABLE TRIGGER tr_dispatch_wave_snapshot_on_offer_insert;
ALTER TABLE public.ride_offers DISABLE TRIGGER tr_ride_offer_delivery_trace;
ALTER TABLE public.ride_offers DISABLE TRIGGER tr_send_push_on_ride_offer_insert;
ALTER TABLE public.ride_offers DISABLE TRIGGER audit_ride_offer_changes;
ALTER TABLE public.ride_offers DISABLE TRIGGER tr_audit_negotiation;
ALTER TABLE public.ride_offers DISABLE TRIGGER start_commitment_on_offer_accept;

CREATE FUNCTION pg_temp.expect_true(p_name text, p_cond boolean) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL %', p_name; END IF;
  RAISE NOTICE 'PASS %', p_name;
END $f$;

CREATE FUNCTION pg_temp.mk_trip(p jsonb) RETURNS uuid
LANGUAGE plpgsql AS $f$
DECLARE
  v_id uuid := gen_random_uuid();
  v_row jsonb;
  v_cols text;
BEGIN
  v_row := jsonb_build_object(
    'id', v_id,
    'passenger_id', gen_random_uuid(),
    'pickup_address', 'Patriot Drive, Milton Keynes',
    'dropoff_address', 'Heathrow Terminal 5',
    'financial_model', 'PLATFORM_COLLECTED',
    'status', 'searching',
    'payment_method', 'CARD',
    'payment_type', 'CARD'
  ) || p;
  SELECT string_agg(quote_ident(k), ',') INTO v_cols FROM jsonb_object_keys(v_row) AS k;
  SET LOCAL session_replication_role = replica;
  EXECUTE format(
    'INSERT INTO public.trips (%s) SELECT %s FROM jsonb_populate_record(NULL::public.trips, $1)',
    v_cols, v_cols) USING v_row;
  SET LOCAL session_replication_role = origin;
  RETURN v_id;
END $f$;

-- Insert a pending/accepted offer with an explicit snapshot; returns SQLSTATE or 'ok'.
CREATE FUNCTION pg_temp.try_offer(p_trip uuid, p_status text, p_snapshot jsonb, p_stacked boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO public.ride_offers (trip_id, driver_id, status, expires_at, dispatch_wave, broadcast_round, offer_snapshot, is_stacked)
  VALUES (p_trip, (SELECT id FROM public.drivers ORDER BY id LIMIT 1), p_status, now() + interval '45 seconds', 1,
          1 + (SELECT count(*) FROM public.ride_offers WHERE trip_id = p_trip), p_snapshot, p_stacked);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $f$;

DO $t$
DECLARE
  v_committed uuid;
  v_breakdown_only uuid;
  v_offer uuid;
  v_state text;
BEGIN
  v_committed := pg_temp.mk_trip(jsonb_build_object(
    'locked_base_fare_pence', 480, 'gross_fare_pence', 480, 'final_customer_fare_pence', 480,
    'estimated_total_pence', 480,
    'fare_breakdown', jsonb_build_object('final_fare_pence', 500)));
  v_breakdown_only := pg_temp.mk_trip(jsonb_build_object(
    'fare_breakdown', jsonb_build_object('final_fare_pence', 500)));

  -- 1. Normal path: the stamp trigger rewrites the snapshot to committed 480 -> guard passes.
  v_state := pg_temp.try_offer(v_committed, 'pending', '{}'::jsonb);
  PERFORM pg_temp.expect_true('stamped pending insert passes (' || v_state || ')', v_state = 'ok');
  PERFORM pg_temp.expect_true('stamped base is committed 480',
    (SELECT (offer_snapshot ->> 'baseFarePence')::int = 480 FROM public.ride_offers
      WHERE trip_id = v_committed ORDER BY created_at DESC LIMIT 1));

  -- From here the stamp is OFF so a stale quote can actually reach the guard.
  ALTER TABLE public.ride_offers DISABLE TRIGGER tr_stamp_offer_presets;

  -- 2. Stale 500 beside committed 480 on a NEW pending insert fails closed.
  v_state := pg_temp.try_offer(v_committed, 'pending', '{"baseFarePence":500}'::jsonb);
  PERFORM pg_temp.expect_true('stale pending insert rejected FO001 (got ' || v_state || ')', v_state = 'FO001');

  -- 2b. Within +/-1p passes.
  v_state := pg_temp.try_offer(v_committed, 'pending', '{"baseFarePence":481}'::jsonb);
  PERFORM pg_temp.expect_true('within 1p passes', v_state = 'ok');

  -- 2c. Alternate key spellings are covered.
  v_state := pg_temp.try_offer(v_committed, 'pending', '{"final_trip_fare_pence":500}'::jsonb);
  PERFORM pg_temp.expect_true('final_trip_fare_pence stale rejected', v_state = 'FO001');

  -- 3. Skips: no snapshot base, null snapshot, no committed payable, stacked.
  v_state := pg_temp.try_offer(v_committed, 'pending', '{"presets_enabled":false}'::jsonb);
  PERFORM pg_temp.expect_true('snapshot without base skipped', v_state = 'ok');
  v_state := pg_temp.try_offer(v_committed, 'pending', NULL);
  PERFORM pg_temp.expect_true('null snapshot skipped', v_state = 'ok');
  v_state := pg_temp.try_offer(v_breakdown_only, 'pending', '{"baseFarePence":123}'::jsonb);
  PERFORM pg_temp.expect_true('breakdown-only trip is not a committed payable -> skipped', v_state = 'ok');
  v_state := pg_temp.try_offer(v_committed, 'pending', '{"baseFarePence":500}'::jsonb, true);
  PERFORM pg_temp.expect_true('stacked offer skipped', v_state = 'ok');

  -- 4. Accepted is never blocked (warning only).
  v_state := pg_temp.try_offer(v_committed, 'accepted', '{"baseFarePence":500}'::jsonb);
  PERFORM pg_temp.expect_true('accepted stale insert not blocked', v_state = 'ok');

  -- 5. Closed historical statuses are not in the trigger WHEN.
  v_state := pg_temp.try_offer(v_committed, 'expired', '{"baseFarePence":500}'::jsonb);
  PERFORM pg_temp.expect_true('expired stale insert untouched', v_state = 'ok');

  -- 6. UPDATE of a pending offer: only when the base CHANGES to a stale value.
  v_state := pg_temp.try_offer(v_committed, 'pending', '{"baseFarePence":480}'::jsonb);
  SELECT id INTO v_offer FROM public.ride_offers
   WHERE trip_id = v_committed AND status = 'pending' AND (offer_snapshot ->> 'baseFarePence') = '480'
   ORDER BY created_at DESC LIMIT 1;
  BEGIN
    UPDATE public.ride_offers SET offer_snapshot = '{"baseFarePence":500}'::jsonb WHERE id = v_offer;
    RAISE EXCEPTION 'FAIL stale pending UPDATE was not rejected';
  EXCEPTION WHEN SQLSTATE 'FO001' THEN
    RAISE NOTICE 'PASS stale pending UPDATE rejected FO001';
  END;
  UPDATE public.ride_offers SET offered_driver_net_pence = 432 WHERE id = v_offer;
  RAISE NOTICE 'PASS net-only UPDATE with unchanged base allowed';
  UPDATE public.ride_offers SET offer_snapshot = '{"baseFarePence":480,"x":1}'::jsonb WHERE id = v_offer;
  RAISE NOTICE 'PASS snapshot UPDATE keeping committed base allowed';

  RAISE NOTICE 'ALL financial_offer_invariant_guard CHECKS PASSED';
END $t$;

ROLLBACK;
