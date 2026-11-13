-- ============================================================================
-- MK-007: commissionable stamp follows the customer payable  --  SQL EXECUTION TEST
--   migration: 20270222190000_airport_split_commissionable_follows_payable.sql
--
-- LOCAL DB ONLY. One transaction, ends in ROLLBACK. The migration is applied INSIDE it
-- (idempotent when already present).
--
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 \
--     -v migration=supabase/migrations/20270222190000_airport_split_commissionable_follows_payable.sql \
--     -f supabase/tests/airport_split_commissionable_follows_payable.sql
--
-- Driver total under the existing policy: (7300 - 700) x 0.9 + 700 = 6640.
-- ============================================================================
\set ON_ERROR_STOP on
\if :{?migration}
\else
  \echo 'usage: -v migration=<190000 path>'
  SELECT 1/0 AS missing_migration_variable;
\endif

BEGIN;
SET LOCAL client_min_messages = warning;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);

\i :migration

SET LOCAL client_min_messages = notice;

CREATE FUNCTION pg_temp.expect_true(p_name text, p_cond boolean) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  IF p_cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL %', p_name; END IF;
  RAISE NOTICE 'PASS %', p_name;
END $f$;

CREATE FUNCTION pg_temp.raw_insert(p_table regclass, p_row jsonb) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE v_cols text;
BEGIN
  SELECT string_agg(quote_ident(k), ',') INTO v_cols FROM jsonb_object_keys(p_row) AS k;
  SET LOCAL session_replication_role = replica;
  EXECUTE format('INSERT INTO %s (%s) SELECT %s FROM jsonb_populate_record(NULL::%s, $1)',
                 p_table, v_cols, v_cols, p_table) USING p_row;
  SET LOCAL session_replication_role = origin;
END $f$;

-- Builds quote + session + trip, calls the REAL function, returns (result jsonb, trip row).
-- p_evidence NULL => the function derives ride fare as gross - airport.
CREATE FUNCTION pg_temp.run_split(p_gross int, p_airport int, p_evidence jsonb, p_payable int)
RETURNS TABLE(result jsonb, trip_commissionable int, snapshot_commissionable int, trip_airport int)
LANGUAGE plpgsql AS $f$
DECLARE
  v_q uuid := gen_random_uuid();
  v_ps uuid := gen_random_uuid();
  v_trip uuid := gen_random_uuid();
  v_sa uuid := gen_random_uuid();
BEGIN
  PERFORM pg_temp.raw_insert('public.server_fare_quotes', jsonb_build_object(
    'id', v_q, 'user_id', gen_random_uuid(), 'route_quote_id', gen_random_uuid(), 'route_key', 'split-test',
    'service_area_id', v_sa, 'vehicle_type_id', gen_random_uuid(), 'currency', 'GBP',
    'distance_km', 10, 'duration_min', 20, 'gross_fare_pence', p_gross, 'airport_charge_pence', p_airport,
    'pricing_evidence', COALESCE(p_evidence, '{}'::jsonb), 'pricing_hash', 'h-' || v_q,
    'expires_at', now() + interval '1 hour'));
  PERFORM pg_temp.raw_insert('public.payment_sessions', jsonb_build_object(
    'id', v_ps, 'user_id', gen_random_uuid(), 'service_area_id', v_sa,
    'idempotency_key', 'split-' || v_ps, 'client_action_id', 'split-' || v_ps,
    'status', 'authorised_hold', 'provider_state', 'AUTHORISED', 'authorised_amount_pence', p_payable,
    'fare_snapshot', jsonb_build_object('server_fare_quote_id', v_q)));
  PERFORM pg_temp.raw_insert('public.trips', jsonb_build_object(
    'id', v_trip, 'passenger_id', gen_random_uuid(), 'pickup_address', 'a', 'dropoff_address', 'b',
    'financial_model', 'PLATFORM_COLLECTED', 'status', 'searching', 'payment_method', 'CARD', 'payment_type', 'CARD',
    'payment_session_id', v_ps, 'locked_base_fare_pence', p_payable));

  result := public.apply_consumed_server_fare_airport_split_to_trip(v_trip, v_ps, NULL, NULL, NULL, p_payable);
  SELECT t.commissionable_fare_pence, (t.fare_snapshot_json ->> 'commissionable_fare_pence')::int, t.airport_charge_pence
    INTO trip_commissionable, snapshot_commissionable, trip_airport
  FROM public.trips t WHERE t.id = v_trip;
  RETURN NEXT;
END $f$;

DO $t$
DECLARE
  r record;
BEGIN
  PERFORM pg_temp.expect_true('function patched (v_commissionable present)',
    position('v_commissionable' in pg_get_functiondef(
      'public.apply_consumed_server_fare_airport_split_to_trip(uuid,uuid,uuid,uuid,uuid,integer)'::regprocedure)) > 0);

  -- MK-007: quote ride 6800 + airport 700 = 7500, discounted payable 7300 -> commissionable 6600 (NOT 6800)
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 7300);
  PERFORM pg_temp.expect_true('MK-007 discounted payable 7300: commissionable = payable - airport = 6600 (got ' || r.trip_commissionable || ')',
    r.trip_commissionable = 6600);
  PERFORM pg_temp.expect_true('MK-007 fare_snapshot_json commissionable follows (6600)', r.snapshot_commissionable = 6600);
  PERFORM pg_temp.expect_true('MK-007 function result commissionable 6600', (r.result ->> 'commissionable_fare_pence')::int = 6600);
  PERFORM pg_temp.expect_true('MK-007 airport still stamped 700', r.trip_airport = 700);
  PERFORM pg_temp.expect_true('MK-007 driver total = (7300-700) x 0.9 + 700 = 6640',
    (r.trip_commissionable - round(r.trip_commissionable * 0.10) + r.trip_airport) = 6640);

  -- No discount: payable covers ride + airport -> quote ride fare stays the commissionable base.
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 7500);
  PERFORM pg_temp.expect_true('no discount: commissionable = quote ride 6800', r.trip_commissionable = 6800);

  -- Payable above ride + airport (e.g. extras inside payable): ride fare unchanged.
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 7600);
  PERFORM pg_temp.expect_true('payable above ride+airport: commissionable = quote ride 6800', r.trip_commissionable = 6800);

  -- Unknown payable (0): quote ride fare.
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 0);
  PERFORM pg_temp.expect_true('payable unknown (0): commissionable = quote ride 6800', r.trip_commissionable = 6800);

  -- No evidence: ride = gross - airport = 6800; discounted payable 7300 still follows payable.
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, NULL, 7300);
  PERFORM pg_temp.expect_true('no evidence, discounted payable: commissionable 6600', r.trip_commissionable = 6600);

  -- No airport: discount still caps commissionable at the payable.
  SELECT * INTO r FROM pg_temp.run_split(5000, 0, '{"trip_fare_pence":5000}', 4800);
  PERFORM pg_temp.expect_true('no airport, discounted payable 4800: commissionable 4800', r.trip_commissionable = 4800);

  -- Already-stamped trips are returned untouched (new-data-only write path).
  PERFORM pg_temp.expect_true('already_stamped trips untouched (no historical rewrite)',
    position('already_stamped' in pg_get_functiondef(
      'public.apply_consumed_server_fare_airport_split_to_trip(uuid,uuid,uuid,uuid,uuid,integer)'::regprocedure)) > 0);

  RAISE NOTICE 'ALL airport_split_commissionable_follows_payable CHECKS PASSED';
END $t$;

ROLLBACK;
