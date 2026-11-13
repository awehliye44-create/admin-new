-- ============================================================================
-- Committed offer fare + airport component  --  SQL EXECUTION TEST
--
--   MK-261113-004/005  committed 480 beside stale breakdown 500, 10% commission
--                      -> offer net 432 AT CREATION (before any Edge restamp)
--   MK-261113-007      Heathrow: committed 7300 incl. airport 700, 10% commission, NO promotion
--                      -> journey 5940 + airport 700 = total 6640 (not 6570)
--   MK-007 global_offer quote ride 6800 + airport 700, global_offer -200 -> payable 7300
--                      -> driver = 6800 x 0.9 + 700 = 6820 (promotion is ONECAB-funded from
--                         commission, never a driver deduction; tripSettlement SSOT)
--
-- LOCAL DB ONLY. Everything runs inside one transaction and ends in ROLLBACK:
-- the candidate migration is applied inside the transaction, synthetic rows are
-- created inside it, nothing is committed. Commission rates are written into the
-- global_dispatch_settings row INSIDE the transaction; the SQL under test reads
-- them (resolve_wave_commission_percent) - no rate is hardcoded in the function.
--
--   psql "$DB_URL" -X -v ON_ERROR_STOP=1 -v migration=<150000> -v global_offer_migration=<210000> -f this.sql
-- ============================================================================
\set ON_ERROR_STOP on
\if :{?migration}
\else
  \echo 'usage: -v migration=<path to 20270222150000_committed_offer_fare_sql_ssot.sql> -v global_offer_migration=<path to 20270222210000_global_offer_commission_base_pre_promotion.sql>'
  \quit
\endif
\if :{?global_offer_migration}
\else
  \echo 'usage: -v global_offer_migration=<path to 20270222210000_global_offer_commission_base_pre_promotion.sql>'
  \quit
\endif

BEGIN;
SET LOCAL client_min_messages = warning;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);

\i :migration
\i :global_offer_migration

SET LOCAL client_min_messages = notice;

-- Only the stamping triggers (and updated_at) stay live on ride_offers; the rest
-- (eligibility gate, push, delivery trace, audit) are not under test.
ALTER TABLE public.ride_offers DISABLE TRIGGER tr_block_ineligible_ride_offer;
ALTER TABLE public.ride_offers DISABLE TRIGGER tr_booking_delivery_booking_sent;
ALTER TABLE public.ride_offers DISABLE TRIGGER tr_dispatch_wave_snapshot_on_offer_insert;
ALTER TABLE public.ride_offers DISABLE TRIGGER tr_ride_offer_delivery_trace;
ALTER TABLE public.ride_offers DISABLE TRIGGER tr_send_push_on_ride_offer_insert;
ALTER TABLE public.ride_offers DISABLE TRIGGER audit_ride_offer_changes;
ALTER TABLE public.ride_offers DISABLE TRIGGER tr_audit_negotiation;
ALTER TABLE public.ride_offers DISABLE TRIGGER start_commitment_on_offer_accept;

-- --------------------------------------------------------------------------
-- Fixtures / helpers (pg_temp - vanish with the transaction)
-- --------------------------------------------------------------------------
CREATE FUNCTION pg_temp.expect(p_name text, p_got anyelement, p_want anyelement) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION 'FAIL % : got % want %', p_name, p_got, p_want;
  END IF;
  RAISE NOTICE 'PASS % = %', p_name, p_got;
END $f$;

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
  -- FKs / unrelated trip triggers are not under test.
  SET LOCAL session_replication_role = replica;
  EXECUTE format(
    'INSERT INTO public.trips (%s) SELECT %s FROM jsonb_populate_record(NULL::public.trips, $1)',
    v_cols, v_cols) USING v_row;
  SET LOCAL session_replication_role = origin;
  RETURN v_id;
END $f$;

CREATE FUNCTION pg_temp.mk_offer(p_trip uuid, p_wave int DEFAULT 1, p_expires interval DEFAULT interval '45 seconds')
RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.ride_offers (trip_id, driver_id, status, expires_at, dispatch_wave, broadcast_round)
  VALUES (p_trip, (SELECT id FROM public.drivers ORDER BY id LIMIT 1), 'pending', now() + p_expires, p_wave,
          1 + (SELECT count(*) FROM public.ride_offers WHERE trip_id = p_trip))
  RETURNING id INTO v_id;
  RETURN v_id;
END $f$;

CREATE FUNCTION pg_temp.snap(p_offer uuid, p_key text) RETURNS text
LANGUAGE sql AS $f$ SELECT offer_snapshot ->> p_key FROM public.ride_offers WHERE id = p_offer $f$;

CREATE FUNCTION pg_temp.snap_int(p_offer uuid, p_key text) RETURNS int
LANGUAGE sql AS $f$ SELECT (offer_snapshot ->> p_key)::int FROM public.ride_offers WHERE id = p_offer $f$;

CREATE FUNCTION pg_temp.offer_net(p_offer uuid) RETURNS int
LANGUAGE sql AS $f$ SELECT offered_driver_net_pence FROM public.ride_offers WHERE id = p_offer $f$;

CREATE FUNCTION pg_temp.base(p_trip uuid) RETURNS int
LANGUAGE sql AS $f$ SELECT public.trip_negotiation_base_fare_pence(t) FROM public.trips t WHERE t.id = p_trip $f$;

-- Commission config lives in the DB row under test - the function reads it.
UPDATE public.global_dispatch_settings
   SET base_driver_commission_percent = 10,
       wave1_commission_reduction_percent = 0,
       wave2_commission_reduction_percent = 5,
       wave3_commission_reduction_percent = 10
 WHERE singleton = true;

DO $t$
DECLARE
  v_trip uuid;
  v_offer uuid;
  v_ps uuid := gen_random_uuid();
  v_sfq uuid := gen_random_uuid();
  v_ps2 uuid := gen_random_uuid();
  v_sfq2 uuid := gen_random_uuid();
BEGIN
  -- ==========================================================================
  -- TASK 4  committed gross priority (same order as committedBookingOfferFareSSOT.ts)
  -- ==========================================================================

  -- MK-004: committed 480 + stale breakdown 500
  v_trip := pg_temp.mk_trip(jsonb_build_object(
    'locked_base_fare_pence', 480, 'gross_fare_pence', 480, 'final_customer_fare_pence', 480,
    'estimated_total_pence', 480, 'estimated_fare', 4.80,
    'fare_snapshot_json', jsonb_build_object('committed_fare_pence', 480, 'canonical_payable_fare_pence', 480),
    'fare_breakdown', jsonb_build_object('trip_fare_pence', 500, 'totalFare', 5, 'final_fare_pence', 500, 'finalFare', 5)));
  PERFORM pg_temp.expect('MK-004 base follows committed 480 (not breakdown 500)', pg_temp.base(v_trip), 480);

  v_offer := pg_temp.mk_offer(v_trip);
  PERFORM pg_temp.expect('MK-004 offer baseFarePence at creation', pg_temp.snap_int(v_offer, 'baseFarePence'), 480);
  PERFORM pg_temp.expect('MK-004 offer net at creation = 480 x (1 - 10%)', pg_temp.offer_net(v_offer), 432);
  PERFORM pg_temp.expect('MK-004 snapshot driver_net_fare_pence', pg_temp.snap_int(v_offer, 'driver_net_fare_pence'), 432);
  PERFORM pg_temp.expect('MK-004 snapshot driver_earnings_pence', pg_temp.snap_int(v_offer, 'driver_earnings_pence'), 432);
  PERFORM pg_temp.expect('MK-004 effective commission from config row', (SELECT effective_commission_percent FROM public.ride_offers WHERE id = v_offer), 10::numeric);
  PERFORM pg_temp.expect('MK-004 platform commission 48', pg_temp.snap_int(v_offer, 'platform_commission_pence'), 48);
  PERFORM pg_temp.expect('MK-004 no airport invented', pg_temp.snap(v_offer, 'airport_charge_pence'), NULL::text);
  PERFORM pg_temp.expect('MK-004 airport state unknown (never zero)', pg_temp.snap(v_offer, 'airport_charge_state'), 'unknown');

  -- Rate comes from config, not a constant: change the row, same shape, new net.
  UPDATE public.global_dispatch_settings SET base_driver_commission_percent = 20 WHERE singleton = true;
  v_offer := pg_temp.mk_offer(v_trip);
  PERFORM pg_temp.expect('MK-004 shape at 20% config -> 384 (rate is read, not hardcoded)', pg_temp.offer_net(v_offer), 384);
  UPDATE public.global_dispatch_settings SET base_driver_commission_percent = 10 WHERE singleton = true;

  -- Wave 2 commission reduction (5%) flows from the trip/offer wave columns.
  v_offer := pg_temp.mk_offer(v_trip, 2);
  PERFORM pg_temp.expect('MK-004 wave 2 effective 5% -> 480 x 0.95 = 456', pg_temp.offer_net(v_offer), 456);

  -- Priority ladder: each tier wins only when the tiers above it are empty.
  PERFORM pg_temp.expect('locked_base wins when no discount / mod',
    pg_temp.base(pg_temp.mk_trip(jsonb_build_object('locked_base_fare_pence', 480, 'final_customer_fare_pence', 470,
      'fare_breakdown', jsonb_build_object('final_fare_pence', 500)))), 480);
  PERFORM pg_temp.expect('locked_base skipped when discount present -> final_customer',
    pg_temp.base(pg_temp.mk_trip(jsonb_build_object('locked_base_fare_pence', 500, 'discount_pence', 20,
      'final_customer_fare_pence', 480, 'fare_breakdown', jsonb_build_object('final_fare_pence', 500)))), 480);
  PERFORM pg_temp.expect('locked_base skipped when modification folded -> final_customer',
    pg_temp.base(pg_temp.mk_trip(jsonb_build_object('locked_base_fare_pence', 500, 'customer_modification_charge_pence', 100,
      'final_customer_fare_pence', 600, 'fare_breakdown', jsonb_build_object('final_fare_pence', 500)))), 600);
  PERFORM pg_temp.expect('final_fare when no final_customer',
    pg_temp.base(pg_temp.mk_trip(jsonb_build_object('final_fare_pence', 480,
      'fare_breakdown', jsonb_build_object('final_fare_pence', 500)))), 480);
  PERFORM pg_temp.expect('final_fare equal to discounted gross is netted',
    pg_temp.base(pg_temp.mk_trip(jsonb_build_object('final_fare_pence', 500, 'gross_fare_pence', 500, 'discount_pence', 20))), 480);
  PERFORM pg_temp.expect('estimated_total beats snapshot + breakdown',
    pg_temp.base(pg_temp.mk_trip(jsonb_build_object('estimated_total_pence', 480,
      'fare_snapshot_json', jsonb_build_object('committed_fare_pence', 470),
      'fare_breakdown', jsonb_build_object('final_fare_pence', 500)))), 480);
  PERFORM pg_temp.expect('snapshot committed key beats breakdown',
    pg_temp.base(pg_temp.mk_trip(jsonb_build_object('fare_snapshot_json', jsonb_build_object('committed_fare_pence', 480),
      'fare_breakdown', jsonb_build_object('final_fare_pence', 500)))), 480);
  PERFORM pg_temp.expect('snapshot original_fare is netted by discount',
    pg_temp.base(pg_temp.mk_trip(jsonb_build_object('discount_pence', 20,
      'fare_snapshot_json', jsonb_build_object('original_fare_pence', 500)))), 480);
  PERFORM pg_temp.expect('gross - discount beats authorised + breakdown',
    pg_temp.base(pg_temp.mk_trip(jsonb_build_object('gross_fare_pence', 500, 'discount_pence', 20,
      'authorised_amount_pence', 490, 'fare_breakdown', jsonb_build_object('final_fare_pence', 510)))), 480);
  PERFORM pg_temp.expect('authorised beats breakdown',
    pg_temp.base(pg_temp.mk_trip(jsonb_build_object('authorised_amount_pence', 480,
      'fare_breakdown', jsonb_build_object('final_fare_pence', 500)))), 480);
  PERFORM pg_temp.expect('breakdown used ONLY when nothing committed (final)',
    pg_temp.base(pg_temp.mk_trip(jsonb_build_object('fare_breakdown', jsonb_build_object('finalFare', 5, 'tripFare', 4.5)))), 500);
  PERFORM pg_temp.expect('breakdown ride + airport when no final',
    pg_temp.base(pg_temp.mk_trip(jsonb_build_object('fare_breakdown', jsonb_build_object('trip_fare_pence', 6800, 'airport_charge_pence', 700)))), 7500);
  PERFORM pg_temp.expect('legacy fare column last',
    pg_temp.base(pg_temp.mk_trip(jsonb_build_object('estimated_fare', 4.8))), 480);

  -- ==========================================================================
  -- TASK 5  MK-261113-007 Heathrow: production-shaped trip, NO promotion
  --   committed 7300 with the airport 700 INSIDE the payable (the consumed quote is 7500 = ride
  --   6800 + airport 700, but nothing ONECAB-funded sits between quote and payable here).
  --   Offer is created INSIDE the trip INSERT, when trips.airport_charge_pence is still 0 and
  --   fare_breakdown is NULL.
  -- ==========================================================================
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.payment_sessions (id, client_action_id, idempotency_key, service_area_id, user_id, fare_snapshot)
  VALUES (v_ps, 'mk007-' || v_ps::text, 'mk007-idem-' || v_ps::text, gen_random_uuid(), gen_random_uuid(),
          jsonb_build_object('server_fare_quote_id', v_sfq));
  INSERT INTO public.server_fare_quotes (id, currency, distance_km, duration_min, expires_at, gross_fare_pence,
                                         pricing_hash, route_key, route_quote_id, service_area_id, user_id,
                                         vehicle_type_id, airport_charge_pence)
  VALUES (v_sfq, 'gbp', 92.25, 86, now() + interval '1 hour', 7500, 'h', 'rk', gen_random_uuid(),
          gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 700);
  SET LOCAL session_replication_role = origin;

  v_trip := pg_temp.mk_trip(jsonb_build_object(
    'payment_session_id', v_ps,
    'airport_charge_pence', 0,
    'final_customer_fare_pence', 7300, 'locked_base_fare_pence', 7300, 'gross_fare_pence', 7300,
    'estimated_total_pence', 7300, 'estimated_fare', 73, 'authorised_amount_pence', 7300,
    'dropoff_address', 'Heathrow Long Stay Terminal 5, Northern Perimeter Rd W, Hounslow, TW6 2RL'));
  PERFORM pg_temp.expect('Heathrow committed payable 7300', pg_temp.base(v_trip), 7300);
  PERFORM pg_temp.expect('Heathrow airport resolved from consumed quote (trip row unstamped)',
    (SELECT public.offer_resolve_airport_pence(t) FROM public.trips t WHERE t.id = v_trip), 700);

  v_offer := pg_temp.mk_offer(v_trip);
  PERFORM pg_temp.expect('Heathrow offer gross', pg_temp.snap_int(v_offer, 'baseFarePence'), 7300);
  PERFORM pg_temp.expect('Heathrow airport on snapshot', pg_temp.snap_int(v_offer, 'airport_charge_pence'), 700);
  PERFORM pg_temp.expect('Heathrow airport state', pg_temp.snap(v_offer, 'airport_charge_state'), 'present');
  PERFORM pg_temp.expect('Heathrow airport chip row amount',
    (SELECT (offer_snapshot -> 'route_extra_items' -> 0 ->> 'amount_pence')::int FROM public.ride_offers WHERE id = v_offer), 700);
  PERFORM pg_temp.expect('Heathrow airport chip row type',
    (SELECT offer_snapshot -> 'route_extra_items' -> 0 ->> 'type' FROM public.ride_offers WHERE id = v_offer), 'airport');
  -- commissionable = 7300 - 700 = 6600 ; commission 10% = 660 ; journey = 5940
  PERFORM pg_temp.expect('Heathrow journey net = 6600 - 660', pg_temp.snap_int(v_offer, 'driver_journey_net_pence'), 5940);
  PERFORM pg_temp.expect('Heathrow total driver payable = journey + airport', pg_temp.offer_net(v_offer), 6640);
  PERFORM pg_temp.expect('Heathrow driver_net_fare_pence includes airport', pg_temp.snap_int(v_offer, 'driver_net_fare_pence'), 6640);
  PERFORM pg_temp.expect('Heathrow no double add: journey + airport = total',
    pg_temp.snap_int(v_offer, 'driver_journey_net_pence') + pg_temp.snap_int(v_offer, 'airport_charge_pence'),
    pg_temp.snap_int(v_offer, 'driver_net_fare_pence'));
  PERFORM pg_temp.expect('Heathrow platform commission 660 (airport not commissioned)', pg_temp.snap_int(v_offer, 'platform_commission_pence'), 660);
  -- the production loss: net 7300 x 0.9 = 6570 with no airport
  PERFORM pg_temp.expect_true('Heathrow not the production-loss net 6570', pg_temp.offer_net(v_offer) <> 6570);

  -- Push data payload (built from the stamped offer) carries the airport.
  PERFORM pg_temp.expect('Heathrow push airport_charge_pence',
    (public.ride_offer_build_send_notification_body(v_offer) -> 'data' ->> 'airport_charge_pence'), '700');
  PERFORM pg_temp.expect('Heathrow push driver_journey_net_pence',
    (public.ride_offer_build_send_notification_body(v_offer) -> 'data' ->> 'driver_journey_net_pence'), '5940');
  PERFORM pg_temp.expect('Heathrow push driver_earnings_pence = total payable',
    (public.ride_offer_build_send_notification_body(v_offer) -> 'data' ->> 'driver_earnings_pence'), '6640');

  -- Wave commission applies to the commissionable journey only.
  v_offer := pg_temp.mk_offer(v_trip, 2);
  PERFORM pg_temp.expect('Heathrow wave 2 (5%): 6600 x 0.95 + 700 = 6970', pg_temp.offer_net(v_offer), 6970);

  -- ==========================================================================
  -- MK-007 global_offer: quote ride 6800 + airport 700 = 7500, global_offer -200 -> payable 7300.
  --   tripSettlement SSOT: the promotion is ONECAB-funded from commission and NEVER reduces the
  --   driver. Commission base = PRE-promotion total (payable + promotion = 7500, ride 6800).
  --   driver = 6800 x 0.9 + 700 = 6820 ; ONECAB absorbs 200 of the 680 commission.
  --   (NOT 6640: that took the 200 out of the driver's pocket.)
  -- ==========================================================================
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.payment_sessions (id, client_action_id, idempotency_key, service_area_id, user_id, fare_snapshot)
  VALUES (v_ps2, 'mk007go-' || v_ps2::text, 'mk007go-idem-' || v_ps2::text, gen_random_uuid(), gen_random_uuid(),
          jsonb_build_object('server_fare_quote_id', v_sfq2));
  INSERT INTO public.server_fare_quotes (id, currency, distance_km, duration_min, expires_at, gross_fare_pence,
                                         pricing_hash, route_key, route_quote_id, service_area_id, user_id,
                                         vehicle_type_id, airport_charge_pence)
  VALUES (v_sfq2, 'gbp', 92.25, 86, now() + interval '1 hour', 7500, 'h2', 'rk2', gen_random_uuid(),
          gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 700);
  SET LOCAL session_replication_role = origin;

  v_trip := pg_temp.mk_trip(jsonb_build_object(
    'payment_session_id', v_ps2,
    'airport_charge_pence', 0,
    'locked_base_fare_pence', 7500, 'gross_fare_pence', 7500,
    'discount_source', 'global_offer', 'offer_discount_pence', 200, 'discount_pence', 200,
    'final_customer_fare_pence', 7300, 'final_fare_pence', 7300, 'estimated_total_pence', 7300, 'authorised_amount_pence', 7300,
    'dropoff_address', 'Heathrow Long Stay Terminal 5, Northern Perimeter Rd W, Hounslow, TW6 2RL'));
  PERFORM pg_temp.expect('MK-007 global_offer promotion resolver = 200',
    (SELECT public.offer_global_offer_promotion_pence(t) FROM public.trips t WHERE t.id = v_trip), 200);
  PERFORM pg_temp.expect('MK-007 global_offer committed payable stays 7300', pg_temp.base(v_trip), 7300);

  v_offer := pg_temp.mk_offer(v_trip);
  PERFORM pg_temp.expect('MK-007 global_offer offer gross (payment) stays the payable 7300', pg_temp.snap_int(v_offer, 'baseFarePence'), 7300);
  PERFORM pg_temp.expect('MK-007 global_offer airport on snapshot', pg_temp.snap_int(v_offer, 'airport_charge_pence'), 700);
  PERFORM pg_temp.expect('MK-007 global_offer journey net = 6800 - 680', pg_temp.snap_int(v_offer, 'driver_journey_net_pence'), 6120);
  PERFORM pg_temp.expect('MK-007 global_offer total driver payable = 6820', pg_temp.offer_net(v_offer), 6820);
  PERFORM pg_temp.expect('MK-007 global_offer driver_net_fare_pence = 6820', pg_temp.snap_int(v_offer, 'driver_net_fare_pence'), 6820);
  PERFORM pg_temp.expect_true('MK-007 global_offer is NOT 6640', pg_temp.offer_net(v_offer) <> 6640);
  PERFORM pg_temp.expect('MK-007 global_offer platform gross commission 680', pg_temp.snap_int(v_offer, 'platform_commission_pence'), 680);
  PERFORM pg_temp.expect('MK-007 global_offer capture identity 6120 + 680 + 700 - 200 = 7300',
    pg_temp.snap_int(v_offer, 'driver_journey_net_pence') + pg_temp.snap_int(v_offer, 'platform_commission_pence')
      + pg_temp.snap_int(v_offer, 'airport_charge_pence') - 200, 7300);
  PERFORM pg_temp.expect('MK-007 global_offer push driver_earnings_pence',
    (public.ride_offer_build_send_notification_body(v_offer) -> 'data' ->> 'driver_earnings_pence'), '6820');
  v_offer := pg_temp.mk_offer(v_trip, 2);
  PERFORM pg_temp.expect('MK-007 global_offer wave 2 (5%): 6800 x 0.95 + 700 = 7160', pg_temp.offer_net(v_offer), 7160);

  -- Trip row not yet stamped (finalize inserts before bookingPostCommit): the consumed payment
  -- session snapshot is the evidence for the global_offer source.
  UPDATE public.payment_sessions
     SET booking_snapshot = jsonb_build_object('discount_source', 'global_offer', 'offer_discount_pence', 200)
   WHERE id = v_ps2;
  v_trip := pg_temp.mk_trip(jsonb_build_object(
    'payment_session_id', v_ps2, 'airport_charge_pence', 0,
    'offer_discount_pence', 200, 'discount_pence', 200,
    'final_customer_fare_pence', 7300, 'final_fare_pence', 7300, 'estimated_total_pence', 7300));
  PERFORM pg_temp.expect('MK-007 global_offer evidence from payment session when trip source unstamped',
    (SELECT public.offer_global_offer_promotion_pence(t) FROM public.trips t WHERE t.id = v_trip), 200);
  v_offer := pg_temp.mk_offer(v_trip);
  PERFORM pg_temp.expect('MK-007 global_offer (session evidence) driver total 6820', pg_temp.offer_net(v_offer), 6820);

  -- Controls: only ONECAB-funded global_offer keeps the pre-promotion base.
  v_trip := pg_temp.mk_trip(jsonb_build_object(
    'airport_charge_pence', 700, 'offer_discount_pence', 0, 'voucher_discount_pence', 200, 'discount_pence', 200,
    'discount_source', 'personal_voucher', 'gross_fare_pence', 7500,
    'final_customer_fare_pence', 7300, 'final_fare_pence', 7300, 'estimated_total_pence', 7300));
  v_offer := pg_temp.mk_offer(v_trip);
  PERFORM pg_temp.expect('voucher discount is NOT ONECAB-funded: (7300 - 700) x 0.9 + 700 = 6640', pg_temp.offer_net(v_offer), 6640);
  v_trip := pg_temp.mk_trip(jsonb_build_object(
    'airport_charge_pence', 700, 'offer_discount_pence', 200, 'discount_pence', 200,
    'discount_source', 'global_offer', 'locked_offer_type', 'negotiated_offer', 'gross_fare_pence', 7500,
    'final_customer_fare_pence', 7300, 'final_fare_pence', 7300, 'estimated_total_pence', 7300));
  v_offer := pg_temp.mk_offer(v_trip);
  PERFORM pg_temp.expect('negotiated fare supersedes the promotion: 6640', pg_temp.offer_net(v_offer), 6640);

  -- Airport stamped AFTER a global_offer offer exists: restamp lands on 6820, not 6640.
  v_trip := pg_temp.mk_trip(jsonb_build_object(
    'airport_charge_pence', 0, 'offer_discount_pence', 200, 'discount_pence', 200,
    'discount_source', 'global_offer', 'gross_fare_pence', 7500,
    'final_customer_fare_pence', 7300, 'final_fare_pence', 7300, 'estimated_total_pence', 7300));
  v_offer := pg_temp.mk_offer(v_trip);
  UPDATE public.trips
     SET airport_charge_pence = 700, commissionable_fare_pence = 6800,
         fare_breakdown = jsonb_build_object('airport_charge_pence', 700, 'trip_fare_pence', 6800, 'final_fare_pence', 7500)
   WHERE id = v_trip;
  PERFORM pg_temp.expect('MK-007 global_offer late airport stamp restamps offer net to 6820', pg_temp.offer_net(v_offer), 6820);
  PERFORM pg_temp.expect('MK-007 global_offer late stamp gross stays committed 7300', pg_temp.snap_int(v_offer, 'baseFarePence'), 7300);
  PERFORM pg_temp.expect('MK-007 global_offer late stamp restamp idempotent', public.restamp_pending_offer_financials_for_trip(v_trip), 0);

  -- --------------------------------------------------------------------------
  -- Defence: trip stamped AFTER the offer exists (the pre-fix order).
  -- --------------------------------------------------------------------------
  v_trip := pg_temp.mk_trip(jsonb_build_object(
    'airport_charge_pence', 0,
    'final_customer_fare_pence', 7300, 'locked_base_fare_pence', 7300, 'gross_fare_pence', 7300,
    'estimated_total_pence', 7300));
  v_offer := pg_temp.mk_offer(v_trip);
  PERFORM pg_temp.expect('late stamp: offer starts at the pre-fix production net 6570', pg_temp.offer_net(v_offer), 6570);
  PERFORM pg_temp.expect('late stamp: airport state unknown (not zero)', pg_temp.snap(v_offer, 'airport_charge_state'), 'unknown');
  PERFORM pg_temp.expect('late stamp: airport key absent while unknown', pg_temp.snap(v_offer, 'airport_charge_pence'), NULL::text);
  PERFORM pg_temp.expect('late stamp: push omits airport while unknown',
    (public.ride_offer_build_send_notification_body(v_offer) -> 'data' ? 'airport_charge_pence'), false);

  PERFORM (SELECT expires_at FROM public.ride_offers WHERE id = v_offer);
  CREATE TEMP TABLE pg_temp.before_offer ON COMMIT DROP AS
    SELECT status, expires_at, dispatch_wave, effective_commission_percent
      FROM public.ride_offers WHERE id = v_offer;
  UPDATE public.trips
     SET airport_charge_pence = 700, commissionable_fare_pence = 6600,
         fare_breakdown = jsonb_build_object('airport_charge_pence', 700, 'trip_fare_pence', 6800, 'final_fare_pence', 7500)
   WHERE id = v_trip;
  PERFORM pg_temp.expect('late stamp: trip trigger restamps offer net 6640', pg_temp.offer_net(v_offer), 6640);
  PERFORM pg_temp.expect('late stamp: snapshot airport 700', pg_temp.snap_int(v_offer, 'airport_charge_pence'), 700);
  PERFORM pg_temp.expect('late stamp: journey 5940', pg_temp.snap_int(v_offer, 'driver_journey_net_pence'), 5940);
  PERFORM pg_temp.expect('late stamp: gross stays committed 7300 (breakdown 7500 ignored)', pg_temp.snap_int(v_offer, 'baseFarePence'), 7300);
  PERFORM pg_temp.expect_true('late stamp: status/expiry/wave/rate untouched',
    (SELECT (o.status, o.expires_at, o.dispatch_wave, o.effective_commission_percent)
            IS NOT DISTINCT FROM (b.status, b.expires_at, b.dispatch_wave, b.effective_commission_percent)
       FROM public.ride_offers o, pg_temp.before_offer b WHERE o.id = v_offer));

  -- Idempotent: a second call writes nothing.
  PERFORM pg_temp.expect('restamp idempotent', public.restamp_pending_offer_financials_for_trip(v_trip), 0);

  -- Non-pending / expired / stacked offers are never restamped.
  v_trip := pg_temp.mk_trip(jsonb_build_object(
    'airport_charge_pence', 0, 'final_customer_fare_pence', 7300, 'locked_base_fare_pence', 7300));
  v_offer := pg_temp.mk_offer(v_trip);
  UPDATE public.ride_offers SET status = 'revoked' WHERE id = v_offer;
  UPDATE public.trips SET airport_charge_pence = 700 WHERE id = v_trip;
  PERFORM pg_temp.expect('revoked offer not restamped', pg_temp.offer_net(v_offer), 6570);

  v_trip := pg_temp.mk_trip(jsonb_build_object(
    'airport_charge_pence', 0, 'final_customer_fare_pence', 7300, 'locked_base_fare_pence', 7300));
  v_offer := pg_temp.mk_offer(v_trip, 1, interval '-1 second');
  UPDATE public.trips SET airport_charge_pence = 700 WHERE id = v_trip;
  PERFORM pg_temp.expect('expired offer not restamped', pg_temp.offer_net(v_offer), 6570);

  -- --------------------------------------------------------------------------
  -- Authoritative zero vs unknown
  -- --------------------------------------------------------------------------
  v_trip := pg_temp.mk_trip(jsonb_build_object(
    'final_customer_fare_pence', 4500, 'locked_base_fare_pence', 4500,
    'fare_breakdown', jsonb_build_object('airportCharge', 0, 'tripFare', 45, 'finalFare', 45)));
  v_offer := pg_temp.mk_offer(v_trip);
  PERFORM pg_temp.expect('authoritative zero: state', pg_temp.snap(v_offer, 'airport_charge_state'), 'zero');
  PERFORM pg_temp.expect('authoritative zero: amount 0', pg_temp.snap_int(v_offer, 'airport_charge_pence'), 0);
  PERFORM pg_temp.expect('authoritative zero: no airport row', (SELECT offer_snapshot ? 'route_extra_items' FROM public.ride_offers WHERE id = v_offer), false);
  PERFORM pg_temp.expect('authoritative zero: net 4500 x 0.9', pg_temp.offer_net(v_offer), 4050);
  PERFORM pg_temp.expect('authoritative zero: push sends 0',
    (public.ride_offer_build_send_notification_body(v_offer) -> 'data' ->> 'airport_charge_pence'), '0');

  -- Airport can never exceed the gross it sits inside.
  v_trip := pg_temp.mk_trip(jsonb_build_object('final_customer_fare_pence', 500, 'airport_charge_pence', 900));
  v_offer := pg_temp.mk_offer(v_trip);
  PERFORM pg_temp.expect('airport clamped to gross: net = gross', pg_temp.offer_net(v_offer), 500);
  PERFORM pg_temp.expect('airport clamped to gross: journey 0', pg_temp.snap_int(v_offer, 'driver_journey_net_pence'), 0);

  RAISE NOTICE 'ALL committed_offer_fare_sql_ssot CHECKS PASSED';
END
$t$;

ROLLBACK;
\echo 'ROLLED BACK - nothing committed'
