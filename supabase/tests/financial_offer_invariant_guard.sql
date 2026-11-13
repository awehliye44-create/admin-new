-- ============================================================================
-- financial offer invariant guard  --  SQL EXECUTION TEST
--   migrations: 20270222150000 (committed-offer SSOT)
--               20270222160000 (guard, non-stacked / committed columns only)
--               20270222170000 (guard: stacked + breakdown-only recovery + FO002)
--               20270222210000 (global_offer commission base = pre-promotion; MK-007 6820)
--               20270222230000 (rollout-safe: pending FO001/FO002 WARN by default,
--                               EXCEPTION only when onecab.enforce_offer_financial_invariant = on)
--
-- LOCAL DB ONLY. One transaction, ends in ROLLBACK. All candidate migrations
-- are applied INSIDE the transaction (idempotent when already present).
--
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 \
--     -v ssot_migration=supabase/migrations/20270222150000_committed_offer_fare_sql_ssot.sql \
--     -v migration=supabase/migrations/20270222160000_financial_offer_invariant_guard.sql \
--     -v stacked_migration=supabase/migrations/20270222170000_financial_offer_invariant_guard_stacked_and_recovery.sql \
--     -v global_offer_migration=supabase/migrations/20270222210000_global_offer_commission_base_pre_promotion.sql \
--     -v warn_migration=supabase/migrations/20270222230000_financial_offer_invariant_warn_by_default.sql \
--     -f supabase/tests/financial_offer_invariant_guard.sql
--
-- Any FAIL raises (ON_ERROR_STOP => non-zero exit). A missing schema object also fails.
-- ============================================================================
\set ON_ERROR_STOP on
\if :{?stacked_migration}
\else
  \echo 'usage: -v ssot_migration=<150000> -v migration=<160000> -v stacked_migration=<170000> -v global_offer_migration=<210000> -v warn_migration=<230000>'
  SELECT 1/0 AS missing_stacked_migration_variable;
\endif
\if :{?global_offer_migration}
\else
  \echo 'usage: -v global_offer_migration=<210000>'
  SELECT 1/0 AS missing_global_offer_migration_variable;
\endif
\if :{?warn_migration}
\else
  \echo 'usage: -v warn_migration=<230000>'
  SELECT 1/0 AS missing_warn_migration_variable;
\endif

BEGIN;
SET LOCAL client_min_messages = warning;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);

\i :ssot_migration
\i :migration
\i :stacked_migration
\i :global_offer_migration
\i :warn_migration

SET LOCAL client_min_messages = notice;

-- Offer side effects (push, delivery trace, audit) are not under test.
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

-- Row insert with triggers/FKs off (fixture only).
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

CREATE FUNCTION pg_temp.mk_trip(p jsonb) RETURNS uuid
LANGUAGE plpgsql AS $f$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  PERFORM pg_temp.raw_insert('public.trips', jsonb_build_object(
    'id', v_id,
    'passenger_id', gen_random_uuid(),
    'pickup_address', 'Patriot Drive, Milton Keynes',
    'dropoff_address', 'Heathrow Terminal 5',
    'financial_model', 'PLATFORM_COLLECTED',
    'status', 'searching',
    'payment_method', 'CARD',
    'payment_type', 'CARD'
  ) || p);
  RETURN v_id;
END $f$;

CREATE FUNCTION pg_temp.mk_session(p_authorised int) RETURNS uuid
LANGUAGE plpgsql AS $f$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  PERFORM pg_temp.raw_insert('public.payment_sessions', jsonb_build_object(
    'id', v_id, 'user_id', gen_random_uuid(), 'service_area_id', gen_random_uuid(),
    'idempotency_key', 'guard-test-' || v_id, 'client_action_id', 'guard-test-' || v_id,
    'status', 'authorised_hold', 'provider_state', 'AUTHORISED',
    'authorised_amount_pence', p_authorised));
  RETURN v_id;
END $f$;

CREATE FUNCTION pg_temp.mk_driver() RETURNS uuid
LANGUAGE plpgsql AS $f$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  PERFORM pg_temp.raw_insert('public.drivers', jsonb_build_object(
    'id', v_id, 'first_name', 'GUARD', 'last_name', 'TEST', 'region_id', gen_random_uuid(),
    'phone', '+4400000099' || lpad((random() * 99)::int::text, 2, '0'),
    'email', 'guard-' || v_id || '@test.invalid'));
  RETURN v_id;
END $f$;

-- Insert an offer; returns SQLSTATE or 'ok'.
CREATE FUNCTION pg_temp.try_offer(
  p_trip uuid, p_status text, p_snapshot jsonb,
  p_stacked boolean DEFAULT false, p_net int DEFAULT NULL, p_pct numeric DEFAULT NULL)
RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO public.ride_offers (trip_id, driver_id, status, expires_at, dispatch_wave, broadcast_round,
                                  offer_snapshot, is_stacked, offered_driver_net_pence,
                                  effective_commission_percent, base_commission_percent)
  VALUES (p_trip, (SELECT id FROM public.drivers WHERE email LIKE 'guard-%@test.invalid' ORDER BY id LIMIT 1),
          p_status, now() + interval '45 seconds', 1,
          1 + (SELECT count(*) FROM public.ride_offers WHERE trip_id = p_trip), p_snapshot, p_stacked,
          p_net, p_pct, p_pct);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('guard_test.last_err', SQLERRM, false);
  IF current_setting('guard_test.verbose', true) = '1' THEN RAISE NOTICE 'try_offer error % %', SQLSTATE, SQLERRM; END IF;
  RETURN SQLSTATE;
END $f$;

CREATE FUNCTION pg_temp.err_has(p_kw text) RETURNS boolean LANGUAGE sql AS $f$
  SELECT position(p_kw in coalesce(current_setting('guard_test.last_err', true), '')) > 0 $f$;

-- Stacked snapshot builder (auto-dispatch shape: base + airport + net aliases).
CREATE FUNCTION pg_temp.stk(p_base int, p_airport int, p_net int) RETURNS jsonb
LANGUAGE sql AS $f$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'baseFarePence', p_base,
    'airport_charge_pence', p_airport,
    'driver_net_fare_pence', p_net, 'driver_earnings_pence', p_net, 'driver_net_preview_pence', p_net,
    'negotiationLocked', true, 'presets_enabled', false))
$f$;

DO $t$
DECLARE
  v_committed uuid;
  v_breakdown_only uuid;
  v_offer uuid;
  v_state text;
  v_drv uuid := pg_temp.mk_driver();
  v_ps480 uuid;
  v_airport_trip uuid;       -- committed 7300, airport 700 on the column (MK-007)
  v_quote_airport_trip uuid; -- committed 7300, airport only on the quote breakdown
  v_zero_airport_trip uuid;  -- committed 480, no airport
  v_session_trip uuid;       -- breakdown-only, authorised payment session 480
  v_snapshot_trip uuid;      -- breakdown-only, fare_snapshot_json committed 480
  v_nothing_trip uuid;       -- breakdown-only, nothing verifiable
  v_other_trip uuid;         -- committed 7300, airport 700, other pass-through 100
  v_go_trip uuid;            -- MK-007 global_offer: payable 7300, promotion 200, airport 700 -> 6820
  v_vc_trip uuid;            -- voucher discount: payable 7300, airport 700 -> 6640 (not ONECAB-funded)
BEGIN
  -- Sections 1-N prove the ENFORCED guard (FO001 / FO002 raised). The default (WARN) mode is
  -- proven in the last section. Enforcement is a session/DB setting, off by default.
  PERFORM set_config('onecab.enforce_offer_financial_invariant', 'on', true);

  PERFORM pg_temp.expect_true('global_dispatch_settings seeded (supabase/tests/ci/pg_harness_seed.sql)',
    EXISTS (SELECT 1 FROM public.global_dispatch_settings WHERE singleton = true));
  PERFORM pg_temp.expect_true('guard + authority helper installed',
    to_regprocedure('public.offer_trip_financial_authority(public.trips)') IS NOT NULL
    AND to_regprocedure('public.tr_ride_offer_financial_invariant_guard_fn()') IS NOT NULL);

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

  -- 2. Non-stacked: stale 500 beside committed 480 fails closed; +/-1p passes; alt key spellings.
  v_state := pg_temp.try_offer(v_committed, 'pending', '{"baseFarePence":500}'::jsonb);
  PERFORM pg_temp.expect_true('stale pending insert rejected FO001 (got ' || v_state || ')', v_state = 'FO001');
  v_state := pg_temp.try_offer(v_committed, 'pending', '{"baseFarePence":481}'::jsonb);
  PERFORM pg_temp.expect_true('within 1p passes', v_state = 'ok');
  v_state := pg_temp.try_offer(v_committed, 'pending', '{"final_trip_fare_pence":500}'::jsonb);
  PERFORM pg_temp.expect_true('final_trip_fare_pence stale rejected', v_state = 'FO001');

  -- 3. Committed trip + offer carrying no base: nothing to contradict -> skipped (unchanged).
  v_state := pg_temp.try_offer(v_committed, 'pending', '{"presets_enabled":false}'::jsonb);
  PERFORM pg_temp.expect_true('snapshot without base skipped on committed trip', v_state = 'ok');
  v_state := pg_temp.try_offer(v_committed, 'pending', NULL);
  PERFORM pg_temp.expect_true('null snapshot skipped on committed trip', v_state = 'ok');

  -- 4. Accepted is never blocked (warning only); closed statuses untouched.
  v_state := pg_temp.try_offer(v_committed, 'accepted', '{"baseFarePence":500}'::jsonb);
  PERFORM pg_temp.expect_true('accepted stale insert not blocked', v_state = 'ok');
  v_state := pg_temp.try_offer(v_committed, 'expired', '{"baseFarePence":500}'::jsonb);
  PERFORM pg_temp.expect_true('expired stale insert untouched', v_state = 'ok');

  -- 5. UPDATE of a pending (non-stacked) offer: only when the base CHANGES to a stale value.
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
  RAISE NOTICE 'PASS net-only UPDATE with unchanged base allowed (non-stacked)';
  UPDATE public.ride_offers SET offer_snapshot = '{"baseFarePence":480,"x":1}'::jsonb WHERE id = v_offer;
  RAISE NOTICE 'PASS snapshot UPDATE keeping committed base allowed';

  -- ======================================================================
  -- STACKED offers: Heathrow-shaped trip, NO promotion (payable 7300, airport 700, commission 10%)
  --   expected driver net = (7300 - 700) x 0.9 + 700 = 6640
  --   (the MK-007 global_offer variant, expected 6820, is exercised further below)
  -- ======================================================================
  v_airport_trip := pg_temp.mk_trip(jsonb_build_object(
    'locked_base_fare_pence', 7300, 'final_customer_fare_pence', 7300, 'estimated_total_pence', 7300,
    'gross_fare_pence', 7300, 'airport_charge_pence', 700));
  v_quote_airport_trip := pg_temp.mk_trip(jsonb_build_object(
    'locked_base_fare_pence', 7300, 'final_customer_fare_pence', 7300, 'estimated_total_pence', 7300,
    'gross_fare_pence', 7300,
    'fare_breakdown', jsonb_build_object('airport_charge_pence', 700, 'trip_fare_pence', 6600)));
  v_zero_airport_trip := v_committed;

  -- PASS: valid stacked offers
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(7300, 700, 6640), true, 6640, 10);
  PERFORM pg_temp.expect_true('valid stacked (airport, 10%) passes (' || v_state || ')', v_state = 'ok');
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(7301, 700, 6641), true, 6641, 10);
  PERFORM pg_temp.expect_true('valid stacked within 1p passes', v_state = 'ok');
  v_state := pg_temp.try_offer(v_zero_airport_trip, 'pending', pg_temp.stk(480, NULL, 432), true, 432, 10);
  PERFORM pg_temp.expect_true('valid stacked without airport passes', v_state = 'ok');
  v_state := pg_temp.try_offer(v_quote_airport_trip, 'pending', pg_temp.stk(7300, 700, 6640), true, 6640, 10);
  PERFORM pg_temp.expect_true('valid stacked with quote-derived airport passes', v_state = 'ok');
  v_state := pg_temp.try_offer(v_zero_airport_trip, 'pending', pg_temp.stk(480, NULL, 480), true, 480, 0);
  PERFORM pg_temp.expect_true('valid stacked at 0% commission passes', v_state = 'ok');

  -- REJECT: each class of bad stacked offer
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(7500, 700, 6820), true, 6820, 10);
  PERFORM pg_temp.expect_true('stacked stale quote over committed rejected (got ' || v_state || ')', v_state = 'FO001');
  PERFORM pg_temp.expect_true('  ... for the right reason (stale_quote_over_committed)', pg_temp.err_has('stale_quote_over_committed'));
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(7300, NULL, 6570), true, 6570, 10);
  PERFORM pg_temp.expect_true('stacked missing airport (trip airport 700) rejected', v_state = 'FO001');
  PERFORM pg_temp.expect_true('  ... for the right reason (airport_missing)', pg_temp.err_has('airport_missing'));
  v_state := pg_temp.try_offer(v_quote_airport_trip, 'pending', pg_temp.stk(7300, NULL, 6570), true, 6570, 10);
  PERFORM pg_temp.expect_true('stacked missing airport (quote airport 700) rejected', v_state = 'FO001');
  PERFORM pg_temp.expect_true('  ... for the right reason (airport_missing)', pg_temp.err_has('airport_missing'));
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(7300, 700, 7300), true, 7300, 10);
  PERFORM pg_temp.expect_true('stacked fabricated earnings (net = gross, 10% stored) rejected', v_state = 'FO001');
  PERFORM pg_temp.expect_true('  ... for the right reason (fabricated_earnings)', pg_temp.err_has('fabricated_earnings'));
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(7300, 700, 7000), true, 7000, 10);
  PERFORM pg_temp.expect_true('stacked inflated net 7000 rejected', v_state = 'FO001');
  PERFORM pg_temp.expect_true('  ... for the right reason (fabricated_earnings)', pg_temp.err_has('fabricated_earnings'));
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(7300, 700, 6570), true, 6570, 10);
  PERFORM pg_temp.expect_true('stacked wrong commission (airport commissioned: 6570) rejected', v_state = 'FO001');
  PERFORM pg_temp.expect_true('  ... for the right reason (wrong_commission)', pg_temp.err_has('wrong_commission'));
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(8000, 700, 7340), true, 7340, 10);
  PERFORM pg_temp.expect_true('stacked double-counted airport (base 8000) rejected', v_state = 'FO001');
  PERFORM pg_temp.expect_true('  ... for the right reason (airport_double_counted)', pg_temp.err_has('airport_double_counted'));
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(7300, 700, 7340), true, 7340, 10);
  PERFORM pg_temp.expect_true('stacked double-counted airport (net 7340) rejected', v_state = 'FO001');
  PERFORM pg_temp.expect_true('  ... for the right reason (airport_double_counted)', pg_temp.err_has('airport_double_counted'));
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(7300, 300, 6640), true, 6640, 10);
  PERFORM pg_temp.expect_true('stacked airport mismatch (300 vs 700) rejected', v_state = 'FO001');
  PERFORM pg_temp.expect_true('  ... for the right reason (airport_mismatch)', pg_temp.err_has('airport_mismatch'));
  v_state := pg_temp.try_offer(v_zero_airport_trip, 'pending', pg_temp.stk(480, 700, 432), true, 432, 10);
  PERFORM pg_temp.expect_true('stacked airport not backed by trip/quote (480 trip, airport 700) rejected', v_state = 'FO001');
  PERFORM pg_temp.expect_true('  ... for the right reason (wrong_commission)', pg_temp.err_has('wrong_commission'));
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(7300, 700, 6640) || '{"driver_net_preview_pence":9999}', true, 6640, 10);
  PERFORM pg_temp.expect_true('stacked fabricated SNAPSHOT net rejected', v_state = 'FO001');
  PERFORM pg_temp.expect_true('  ... for the right reason (fabricated_earnings)', pg_temp.err_has('fabricated_earnings'));
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(7300, 700, 9999), true, 9999, NULL);
  PERFORM pg_temp.expect_true('stacked net above payable rejected even without a stored commission', v_state = 'FO001');

  -- other pass-through on the trip: edge nets without it, the SQL stamp nets with it -> both are valid,
  -- inflated earnings still are not.
  v_other_trip := pg_temp.mk_trip(jsonb_build_object(
    'locked_base_fare_pence', 7300, 'final_customer_fare_pence', 7300, 'estimated_total_pence', 7300,
    'gross_fare_pence', 7300, 'airport_charge_pence', 700, 'other_pass_through_charges_pence', 100));
  -- with other: (7300-700-100) x 0.9 + 700 + 100 = 6650 ; without other: 6640
  v_state := pg_temp.try_offer(v_other_trip, 'pending', pg_temp.stk(7300, 700, 6650), true, 6650, 10);
  PERFORM pg_temp.expect_true('stacked net WITH trip other pass-through (6650) passes (' || v_state || ')', v_state = 'ok');
  v_state := pg_temp.try_offer(v_other_trip, 'pending', pg_temp.stk(7300, 700, 6640), true, 6640, 10);
  PERFORM pg_temp.expect_true('stacked net edge-style (other not carried, 6640) passes', v_state = 'ok');
  v_state := pg_temp.try_offer(v_other_trip, 'pending', pg_temp.stk(7300, 700, 6800), true, 6800, 10);
  PERFORM pg_temp.expect_true('stacked inflated net on a trip with other pass-through rejected', v_state = 'FO001');
  PERFORM pg_temp.expect_true('  ... for the right reason (fabricated_earnings)', pg_temp.err_has('fabricated_earnings'));

  -- Stacked is not blocked where it must not be.
  v_state := pg_temp.try_offer(v_airport_trip, 'accepted', pg_temp.stk(8000, NULL, 9999), true, 9999, 10);
  PERFORM pg_temp.expect_true('stacked accepted never blocked (warning only)', v_state = 'ok');
  v_state := pg_temp.try_offer(v_airport_trip, 'expired', pg_temp.stk(8000, NULL, 9999), true, 9999, 10);
  PERFORM pg_temp.expect_true('stacked closed/historical untouched', v_state = 'ok');
  v_state := pg_temp.try_offer(v_airport_trip, 'revoked', pg_temp.stk(8000, NULL, 9999), true, 9999, 10);
  PERFORM pg_temp.expect_true('stacked revoked untouched', v_state = 'ok');

  -- Stacked UPDATE: re-validated only when base / net / airport change.
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(7300, 700, 6640), true, 6640, 10);
  SELECT id INTO v_offer FROM public.ride_offers
   WHERE trip_id = v_airport_trip AND is_stacked AND status = 'pending' AND offered_driver_net_pence = 6640
   ORDER BY created_at DESC LIMIT 1;
  BEGIN
    UPDATE public.ride_offers SET offered_driver_net_pence = 9999 WHERE id = v_offer;
    RAISE EXCEPTION 'FAIL stacked pending net UPDATE to 9999 was not rejected';
  EXCEPTION WHEN SQLSTATE 'FO001' THEN
    RAISE NOTICE 'PASS stacked pending net UPDATE (fabricated) rejected FO001';
  END;
  BEGIN
    UPDATE public.ride_offers SET offer_snapshot = pg_temp.stk(7500, 700, 6640) WHERE id = v_offer;
    RAISE EXCEPTION 'FAIL stacked pending stale base UPDATE was not rejected';
  EXCEPTION WHEN SQLSTATE 'FO001' THEN
    RAISE NOTICE 'PASS stacked pending stale base UPDATE rejected FO001';
  END;
  UPDATE public.ride_offers SET offer_snapshot = pg_temp.stk(7300, 700, 6640) || '{"x":1}' WHERE id = v_offer;
  RAISE NOTICE 'PASS stacked snapshot UPDATE that keeps base/net/airport allowed';

  -- Stacked eligibility / workflow preserved: the guard is a financial check only.
  v_state := pg_temp.try_offer(v_zero_airport_trip, 'pending',
    pg_temp.stk(480, NULL, 432) || '{"negotiationLocked":true,"negotiationDisabled":true,"presets_enabled":false}',
    true, 432, 10);
  PERFORM pg_temp.expect_true('stacked negotiation-lock snapshot fields untouched by guard', v_state = 'ok');

  -- ======================================================================
  -- BREAKDOWN-ONLY legacy trips: recover, do not blindly reject
  -- ======================================================================
  v_ps480 := pg_temp.mk_session(480);
  v_session_trip := pg_temp.mk_trip(jsonb_build_object(
    'payment_session_id', v_ps480,
    'fare_breakdown', jsonb_build_object('final_fare_pence', 500)));
  v_snapshot_trip := pg_temp.mk_trip(jsonb_build_object(
    'fare_snapshot_json', jsonb_build_object('committed_fare_pence', 480),
    'fare_breakdown', jsonb_build_object('final_fare_pence', 500)));
  v_nothing_trip := v_breakdown_only;

  PERFORM pg_temp.expect_true('authority: committed',
    (SELECT authority FROM public.offer_trip_financial_authority((SELECT t FROM public.trips t WHERE t.id = v_committed))) = 'committed');
  PERFORM pg_temp.expect_true('authority: session-backed breakdown-only recovers 480',
    (SELECT authority = 'recovered' AND payable = 480 FROM public.offer_trip_financial_authority((SELECT t FROM public.trips t WHERE t.id = v_session_trip))));
  PERFORM pg_temp.expect_true('authority: snapshot-backed breakdown-only recovers 480',
    (SELECT authority = 'recovered' AND payable = 480 FROM public.offer_trip_financial_authority((SELECT t FROM public.trips t WHERE t.id = v_snapshot_trip))));
  PERFORM pg_temp.expect_true('authority: breakdown-only with nothing verifiable is none',
    (SELECT authority FROM public.offer_trip_financial_authority((SELECT t FROM public.trips t WHERE t.id = v_nothing_trip))) = 'none');

  v_state := pg_temp.try_offer(v_session_trip, 'pending', '{"baseFarePence":480}'::jsonb);
  PERFORM pg_temp.expect_true('session-backed breakdown-only: matching 480 accepted (not blindly rejected)', v_state = 'ok');
  v_state := pg_temp.try_offer(v_session_trip, 'pending', '{"baseFarePence":500}'::jsonb);
  PERFORM pg_temp.expect_true('session-backed breakdown-only: stale 500 rejected FO001 (got ' || v_state || ')', v_state = 'FO001');
  v_state := pg_temp.try_offer(v_snapshot_trip, 'pending', '{"baseFarePence":480}'::jsonb);
  PERFORM pg_temp.expect_true('snapshot-backed breakdown-only: matching 480 accepted', v_state = 'ok');
  v_state := pg_temp.try_offer(v_snapshot_trip, 'pending', '{"baseFarePence":500}'::jsonb);
  PERFORM pg_temp.expect_true('snapshot-backed breakdown-only: stale 500 rejected', v_state = 'FO001');
  v_state := pg_temp.try_offer(v_session_trip, 'pending', pg_temp.stk(500, NULL, 450), true, 450, 10);
  PERFORM pg_temp.expect_true('session-backed breakdown-only: stacked stale 500 rejected', v_state = 'FO001');
  v_state := pg_temp.try_offer(v_session_trip, 'pending', pg_temp.stk(480, NULL, 432), true, 432, 10);
  PERFORM pg_temp.expect_true('session-backed breakdown-only: stacked 480 accepted', v_state = 'ok');

  -- Unverifiable: a NEW actionable (pending) offer fails closed (FO002); nothing else changes.
  v_state := pg_temp.try_offer(v_nothing_trip, 'pending', '{"baseFarePence":123}'::jsonb);
  PERFORM pg_temp.expect_true('no verifiable snapshot: new pending offer rejected FO002 (got ' || v_state || ')', v_state = 'FO002');
  v_state := pg_temp.try_offer(v_nothing_trip, 'pending', pg_temp.stk(500, NULL, 450), true, 450, 10);
  PERFORM pg_temp.expect_true('no verifiable snapshot: new stacked offer rejected FO002', v_state = 'FO002');
  v_state := pg_temp.try_offer(v_nothing_trip, 'pending', NULL);
  PERFORM pg_temp.expect_true('no verifiable snapshot: null-snapshot pending offer rejected FO002', v_state = 'FO002');
  v_state := pg_temp.try_offer(v_nothing_trip, 'accepted', '{"baseFarePence":123}'::jsonb);
  PERFORM pg_temp.expect_true('no verifiable snapshot: accepted not blocked', v_state = 'ok');
  v_state := pg_temp.try_offer(v_nothing_trip, 'expired', '{"baseFarePence":123}'::jsonb);
  PERFORM pg_temp.expect_true('no verifiable snapshot: closed offers untouched', v_state = 'ok');

  -- ======================================================================
  -- MK-007 global_offer: payable 7300 = quote 7500 - ONECAB-funded promotion 200, airport 700.
  --   expected driver net = (7300 + 200 - 700) x 0.9 + 700 = 6820 (NOT 6640)
  -- ======================================================================
  v_go_trip := pg_temp.mk_trip(jsonb_build_object(
    'locked_base_fare_pence', 7500, 'gross_fare_pence', 7500,
    'final_customer_fare_pence', 7300, 'final_fare_pence', 7300, 'estimated_total_pence', 7300,
    'airport_charge_pence', 700, 'offer_discount_pence', 200, 'discount_pence', 200,
    'discount_source', 'global_offer'));
  v_vc_trip := pg_temp.mk_trip(jsonb_build_object(
    'locked_base_fare_pence', 7500, 'gross_fare_pence', 7500,
    'final_customer_fare_pence', 7300, 'final_fare_pence', 7300, 'estimated_total_pence', 7300,
    'airport_charge_pence', 700, 'voucher_discount_pence', 200, 'discount_pence', 200,
    'discount_source', 'personal_voucher'));

  v_state := pg_temp.try_offer(v_go_trip, 'pending', pg_temp.stk(7300, 700, 6820), true, 6820, 10);
  PERFORM pg_temp.expect_true('MK-007 global_offer stacked 6820 passes (' || v_state || ')', v_state = 'ok');
  v_state := pg_temp.try_offer(v_go_trip, 'pending', pg_temp.stk(7300, 700, 6640), true, 6640, 10);
  PERFORM pg_temp.expect_true('MK-007 global_offer stacked 6640 (driver pays the promotion) rejected (got ' || v_state || ')', v_state = 'FO001');
  PERFORM pg_temp.expect_true('  ... for the right reason (wrong_commission)', pg_temp.err_has('wrong_commission'));
  v_state := pg_temp.try_offer(v_go_trip, 'pending', pg_temp.stk(7300, 700, 7000), true, 7000, 10);
  PERFORM pg_temp.expect_true('MK-007 global_offer stacked inflated 7000 rejected', v_state = 'FO001');
  v_state := pg_temp.try_offer(v_vc_trip, 'pending', pg_temp.stk(7300, 700, 6640), true, 6640, 10);
  PERFORM pg_temp.expect_true('voucher stacked 6640 passes (promotion is not ONECAB-funded)', v_state = 'ok');
  v_state := pg_temp.try_offer(v_vc_trip, 'pending', pg_temp.stk(7300, 700, 6820), true, 6820, 10);
  PERFORM pg_temp.expect_true('voucher stacked 6820 rejected (driver would be paid the voucher)', v_state = 'FO001');

  -- ======================================================================
  -- ROLLOUT-SAFE DEFAULT: pending FO001 / FO002 WARN (never block a booking while old Edge is live)
  -- ======================================================================
  PERFORM set_config('onecab.enforce_offer_financial_invariant', '', true);
  v_state := pg_temp.try_offer(v_committed, 'pending', '{"baseFarePence":500}'::jsonb);
  PERFORM pg_temp.expect_true('WARN mode: stale pending insert is NOT rejected (got ' || v_state || ')', v_state = 'ok');
  v_state := pg_temp.try_offer(v_go_trip, 'pending', pg_temp.stk(7300, 700, 6640), true, 6640, 10);
  PERFORM pg_temp.expect_true('WARN mode: old-Edge stacked 6640 on a global_offer trip is NOT rejected', v_state = 'ok');
  v_state := pg_temp.try_offer(v_airport_trip, 'pending', pg_temp.stk(7300, 700, 9999), true, 9999, NULL);
  PERFORM pg_temp.expect_true('WARN mode: fabricated stacked net is NOT rejected (monitor still flags it)', v_state = 'ok');
  v_state := pg_temp.try_offer(v_nothing_trip, 'pending', '{"baseFarePence":123}'::jsonb);
  PERFORM pg_temp.expect_true('WARN mode: FO002 (no verifiable snapshot) is NOT rejected', v_state = 'ok');
  SELECT id INTO v_offer FROM public.ride_offers
   WHERE trip_id = v_committed AND status = 'pending' AND (offer_snapshot ->> 'baseFarePence') = '480'
   ORDER BY created_at DESC LIMIT 1;
  UPDATE public.ride_offers SET offer_snapshot = '{"baseFarePence":500}'::jsonb WHERE id = v_offer;
  RAISE NOTICE 'PASS WARN mode: stale pending UPDATE is NOT rejected';
  v_state := pg_temp.try_offer(v_go_trip, 'accepted', pg_temp.stk(8000, NULL, 9999), true, 9999, 10);
  PERFORM pg_temp.expect_true('WARN mode: accepted still never blocked (got ' || v_state || ')', v_state = 'ok');

  -- Explicit opt-in flips it back to EXCEPTION (the post-Edge-cutover follow-up).
  PERFORM set_config('onecab.enforce_offer_financial_invariant', 'on', true);
  v_state := pg_temp.try_offer(v_committed, 'pending', '{"baseFarePence":500}'::jsonb);
  PERFORM pg_temp.expect_true('enforce=on: stale pending insert rejected FO001 again', v_state = 'FO001');
  v_state := pg_temp.try_offer(v_nothing_trip, 'pending', '{"baseFarePence":123}'::jsonb);
  PERFORM pg_temp.expect_true('enforce=on: FO002 raised again', v_state = 'FO002');

  RAISE NOTICE 'ALL financial_offer_invariant_guard CHECKS PASSED';
END $t$;

ROLLBACK;
