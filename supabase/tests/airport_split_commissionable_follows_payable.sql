-- ============================================================================
-- MK-007: commissionable stamp (payable follows for non-subsidised discounts; global_offer keeps
--         the pre-promotion quote ride)  --  SQL EXECUTION TEST
--   migrations: 20270222190000_airport_split_commissionable_follows_payable.sql   (history)
--               20270222210000_global_offer_commission_base_pre_promotion.sql      (supersedes the
--               190000 payable-undershoot shrink for global_offer)
--
-- LOCAL DB ONLY. One transaction, ends in ROLLBACK. The migration is applied INSIDE it
-- (idempotent when already present).
--
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 \
--     -v migration=supabase/migrations/20270222190000_airport_split_commissionable_follows_payable.sql \
--     -v global_offer_migration=supabase/migrations/20270222210000_global_offer_commission_base_pre_promotion.sql \
--     -f supabase/tests/airport_split_commissionable_follows_payable.sql
--
-- global_offer (ONECAB-funded, tripSettlement SSOT): (6800 x 0.9) + 700 = 6820, commissionable 6800.
-- Non-subsidised discount (voucher / unknown source): (7300 - 700) x 0.9 + 700 = 6640, commissionable 6600.
-- ============================================================================
\set ON_ERROR_STOP on
\if :{?migration}
\else
  \echo 'usage: -v migration=<190000 path> -v global_offer_migration=<210000 path>'
  SELECT 1/0 AS missing_migration_variable;
\endif
\if :{?global_offer_migration}
\else
  \echo 'usage: -v global_offer_migration=<210000 path>'
  SELECT 1/0 AS missing_global_offer_migration_variable;
\endif

BEGIN;
SET LOCAL client_min_messages = warning;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);

\i :migration
\i :global_offer_migration

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
-- p_promo > 0 stamps a discount on the trip. p_source is written on the TRIP row ('global_offer' /
-- 'personal_voucher' / NULL); p_session_source is the payment-session booking_snapshot evidence
-- (finalize_paid_booking_session inserts the trip BEFORE bookingPostCommit stamps discount_source).
CREATE FUNCTION pg_temp.run_split(p_gross int, p_airport int, p_evidence jsonb, p_payable int,
                                  p_promo int DEFAULT 0, p_source text DEFAULT NULL,
                                  p_session_source text DEFAULT NULL, p_offer_type text DEFAULT NULL)
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
    'fare_snapshot', jsonb_build_object('server_fare_quote_id', v_q),
    'booking_snapshot', CASE WHEN p_session_source IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('discount_source', p_session_source, 'offer_discount_pence', p_promo) END));
  PERFORM pg_temp.raw_insert('public.trips', jsonb_build_object(
    'id', v_trip, 'passenger_id', gen_random_uuid(), 'pickup_address', 'a', 'dropoff_address', 'b',
    'financial_model', 'PLATFORM_COLLECTED', 'status', 'searching', 'payment_method', 'CARD', 'payment_type', 'CARD',
    'payment_session_id', v_ps, 'locked_base_fare_pence', p_payable)
    || CASE WHEN p_promo > 0 THEN jsonb_build_object(
         'offer_discount_pence', p_promo, 'discount_pence', p_promo, 'gross_fare_pence', p_payable + p_promo,
         'final_fare_pence', p_payable, 'final_customer_fare_pence', p_payable, 'estimated_total_pence', p_payable,
         'discount_source', p_source, 'locked_offer_type', p_offer_type)
       ELSE '{}'::jsonb END);

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
  PERFORM pg_temp.expect_true('function superseded by 210000 (v_promo present)',
    position('v_promo' in pg_get_functiondef(
      'public.apply_consumed_server_fare_airport_split_to_trip(uuid,uuid,uuid,uuid,uuid,integer)'::regprocedure)) > 0);

  -- ====================================================================
  -- MK-007 global_offer: quote ride 6800 + airport 700 = 7500, promotion 200, payable 7300.
  -- ONECAB-funded from commission -> commissionable stays the quote ride 6800 (NOT 6600).
  -- ====================================================================
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 7300, 200, 'global_offer');
  PERFORM pg_temp.expect_true('MK-007 global_offer: commissionable = quote ride 6800 (got ' || r.trip_commissionable || ')',
    r.trip_commissionable = 6800);
  PERFORM pg_temp.expect_true('MK-007 global_offer: fare_snapshot_json commissionable 6800', r.snapshot_commissionable = 6800);
  PERFORM pg_temp.expect_true('MK-007 global_offer: function result commissionable 6800', (r.result ->> 'commissionable_fare_pence')::int = 6800);
  PERFORM pg_temp.expect_true('MK-007 global_offer: airport still stamped 700', r.trip_airport = 700);
  PERFORM pg_temp.expect_true('MK-007 global_offer: driver total = 6800 x 0.9 + 700 = 6820',
    (r.trip_commissionable - round(r.trip_commissionable * 0.10) + r.trip_airport) = 6820);
  PERFORM pg_temp.expect_true('MK-007 global_offer: capture identity 6120 + 680 + 700 - 200 = 7300',
    (r.trip_commissionable - round(r.trip_commissionable * 0.10)) + round(r.trip_commissionable * 0.10)
      + r.trip_airport - 200 = 7300);

  -- Same, but the trip row is not yet stamped with the source: payment-session snapshot is the evidence.
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 7300, 200, NULL, 'global_offer');
  PERFORM pg_temp.expect_true('MK-007 global_offer via session evidence: commissionable 6800', r.trip_commissionable = 6800);

  -- No evidence on the quote: ride = gross - airport = 6800 -> still 6800 under global_offer.
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, NULL, 7300, 200, 'global_offer');
  PERFORM pg_temp.expect_true('global_offer, no evidence: commissionable 6800', r.trip_commissionable = 6800);

  -- No airport: promotion still never shrinks the commission base.
  SELECT * INTO r FROM pg_temp.run_split(5000, 0, '{"trip_fare_pence":5000}', 4800, 200, 'global_offer');
  PERFORM pg_temp.expect_true('global_offer, no airport: commissionable stays quote ride 5000', r.trip_commissionable = 5000);

  -- A promotion smaller than the gap cannot lift commissionable above the pre-promotion total.
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 7300, 100, 'global_offer');
  PERFORM pg_temp.expect_true('global_offer 100 < gap 200: commissionable = (7300 + 100) - 700 = 6700', r.trip_commissionable = 6700);

  -- ====================================================================
  -- NOT ONECAB-funded: the 190000 payable-follows rule is retained (voucher / unknown / negotiated).
  -- ====================================================================
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 7300, 200, 'personal_voucher');
  PERFORM pg_temp.expect_true('voucher discount: commissionable = payable - airport = 6600', r.trip_commissionable = 6600);
  PERFORM pg_temp.expect_true('voucher discount: driver total (7300-700) x 0.9 + 700 = 6640',
    (r.trip_commissionable - round(r.trip_commissionable * 0.10) + r.trip_airport) = 6640);

  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 7300, 200, NULL);
  PERFORM pg_temp.expect_true('discount with unknown source: commissionable 6600 (no invented subsidy)', r.trip_commissionable = 6600);

  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 7300, 200, 'global_offer', NULL, 'negotiated_offer');
  PERFORM pg_temp.expect_true('negotiated fare supersedes the promotion: commissionable 6600', r.trip_commissionable = 6600);

  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 7300);
  PERFORM pg_temp.expect_true('payable undershoot with no discount row: commissionable 6600 (190000 behaviour kept)', r.trip_commissionable = 6600);

  -- No discount: payable covers ride + airport -> quote ride fare stays the commissionable base.
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 7500);
  PERFORM pg_temp.expect_true('no discount: commissionable = quote ride 6800', r.trip_commissionable = 6800);

  -- Payable above ride + airport (e.g. extras inside payable): ride fare unchanged.
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 7600);
  PERFORM pg_temp.expect_true('payable above ride+airport: commissionable = quote ride 6800', r.trip_commissionable = 6800);

  -- Unknown payable (0): quote ride fare.
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, '{"trip_fare_pence":6800}', 0);
  PERFORM pg_temp.expect_true('payable unknown (0): commissionable = quote ride 6800', r.trip_commissionable = 6800);

  -- No evidence: ride = gross - airport = 6800; non-subsidised discounted payable 7300 follows payable.
  SELECT * INTO r FROM pg_temp.run_split(7500, 700, NULL, 7300);
  PERFORM pg_temp.expect_true('no evidence, discounted payable: commissionable 6600', r.trip_commissionable = 6600);

  -- No airport: a non-subsidised discount still caps commissionable at the payable.
  SELECT * INTO r FROM pg_temp.run_split(5000, 0, '{"trip_fare_pence":5000}', 4800);
  PERFORM pg_temp.expect_true('no airport, discounted payable 4800: commissionable 4800', r.trip_commissionable = 4800);

  -- Already-stamped trips are returned untouched (new-data-only write path).
  PERFORM pg_temp.expect_true('already_stamped trips untouched (no historical rewrite)',
    position('already_stamped' in pg_get_functiondef(
      'public.apply_consumed_server_fare_airport_split_to_trip(uuid,uuid,uuid,uuid,uuid,integer)'::regprocedure)) > 0);

  RAISE NOTICE 'ALL airport_split_commissionable_follows_payable CHECKS PASSED';
END $t$;

ROLLBACK;
