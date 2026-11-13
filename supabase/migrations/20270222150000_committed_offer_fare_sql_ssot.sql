-- Release candidate. Not applied. NO prod deploy from this change set.
--
-- MK-261113-004/005 (stale breakdown 500 beside committed 480) and
-- MK-261113-007 (Heathrow airport component lost between quote and Driver card).
--
-- 1. public.trip_negotiation_base_fare_pence(trips)
--    The SQL gross seed for every offer / preset. It used to prefer
--    fare_breakdown.finalFare / tripFare over the committed payable, so an offer
--    inserted before (or beside) a re-written breakdown was seeded from 500
--    instead of the committed 480. It now follows the SAME priority as
--    supabase/functions/_shared/committedBookingOfferFareSSOT.ts
--    (resolveCommittedOfferGross):
--      locked_base (only when no discount / folded modification)
--      -> final_customer_fare_pence -> final_fare_pence -> estimated_total_pence
--      -> fare_snapshot_json committed keys -> gross - discount
--      -> authorised amount (trip, then payment session)
--      -> ONLY THEN fare_breakdown, gross column, fare columns.
--    fare_breakdown is never preferred over a committed column / snapshot.
--
-- 2. public.tr_stamp_offer_presets_fn (BEFORE INSERT ride_offers)
--    Net at creation = committed gross x effective wave commission
--    (resolve_wave_commission_percent - no constant rate), airport and other
--    pass-through are non-commissionable and added back. Airport is resolved from
--    the trip column, the quote breakdown / snapshot, or - when the trip row is
--    still unstamped because the offer is created inside the trip INSERT - the
--    consumed server_fare_quotes row of the trip's payment session. The snapshot
--    now carries airport_charge_state (present | zero | unknown) and
--    driver_journey_net_pence so a missing airport can never silently become 0.
--
-- 3. public.restamp_pending_offer_financials_for_trip + trips trigger
--    Defence in depth (NOT the primary fix): if airport_charge_pence is written
--    to the trip after a pending offer already exists, the offer snapshot and
--    offered_driver_net_pence are re-derived in the same transaction. Only
--    calculated financial fields change; never status, wave, expiry, presets'
--    gross, or any notification.
--
-- 4. public.ride_offer_build_send_notification_body
--    The offer push data payload never carried the airport amount. It now adds
--    airport_charge_pence (known amount, incl. authoritative 0) and
--    driver_journey_net_pence. Unknown airport stays absent (never 0).
--
-- Not changed: Revolut, capture, settlement, ledgers, trips.commissionable_fare_pence
-- stamping, tips, waiting charges, negotiation presets' gross values.
--
-- Rollback: supabase/migrations/rollback/rollback_20270222150000_committed_offer_fare_sql_ssot.sql

-- ---------------------------------------------------------------------------
-- 0. Small pure helpers (IMMUTABLE, no table access)
-- ---------------------------------------------------------------------------

-- Positive whole pence from a jsonb key (number or numeric string), else 0.
CREATE OR REPLACE FUNCTION public.offer_jsonb_pence(p_json jsonb, p_key text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_text text;
BEGIN
  IF p_json IS NULL OR jsonb_typeof(p_json) <> 'object' THEN RETURN 0; END IF;
  v_text := p_json ->> p_key;
  IF v_text IS NULL OR v_text !~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN RETURN 0; END IF;
  RETURN GREATEST(0, round(btrim(v_text)::numeric)::integer);
END;
$function$;

-- Positive pence from a MAJOR-unit (pounds) jsonb key, else 0.
CREATE OR REPLACE FUNCTION public.offer_jsonb_major_to_pence(p_json jsonb, p_key text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_text text;
BEGIN
  IF p_json IS NULL OR jsonb_typeof(p_json) <> 'object' THEN RETURN 0; END IF;
  v_text := p_json ->> p_key;
  IF v_text IS NULL OR v_text !~ '^\s*[0-9]+(\.[0-9]+)?\s*$' THEN RETURN 0; END IF;
  RETURN GREATEST(0, round(btrim(v_text)::numeric * 100)::integer);
END;
$function$;

-- Mirrors resolveQuoteFinalFarePence: explicit pence keys win, else major keys.
CREATE OR REPLACE FUNCTION public.offer_quote_final_pence(p_quote jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    NULLIF(public.offer_jsonb_pence(p_quote, 'final_fare_pence'), 0),
    NULLIF(public.offer_jsonb_pence(p_quote, 'total_fare_pence'), 0),
    NULLIF(public.offer_jsonb_pence(p_quote, 'finalFarePence'), 0),
    NULLIF(public.offer_jsonb_pence(p_quote, 'totalFarePence'), 0),
    NULLIF(public.offer_jsonb_major_to_pence(p_quote, 'finalFare'), 0),
    NULLIF(public.offer_jsonb_major_to_pence(p_quote, 'totalFare'), 0),
    NULLIF(public.offer_jsonb_major_to_pence(p_quote, 'final_fare'), 0),
    NULLIF(public.offer_jsonb_major_to_pence(p_quote, 'total_fare'), 0),
    0
  );
$function$;

-- Mirrors resolveQuoteRideFarePence.
CREATE OR REPLACE FUNCTION public.offer_quote_ride_pence(p_quote jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    NULLIF(public.offer_jsonb_pence(p_quote, 'trip_fare_pence'), 0),
    NULLIF(public.offer_jsonb_pence(p_quote, 'tripFarePence'), 0),
    NULLIF(public.offer_jsonb_major_to_pence(p_quote, 'tripFare'), 0),
    NULLIF(public.offer_jsonb_major_to_pence(p_quote, 'trip_fare'), 0),
    0
  );
$function$;

-- Mirrors resolveQuoteAirportChargePence. NULL when the quote has no airport key
-- at all (unknown); 0 when a key is present and zero (authoritative zero).
CREATE OR REPLACE FUNCTION public.offer_quote_airport_pence(p_quote jsonb)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_pence integer;
  v_pickup integer;
  v_dropoff integer;
BEGIN
  IF p_quote IS NULL OR jsonb_typeof(p_quote) <> 'object' THEN RETURN NULL; END IF;

  v_pence := COALESCE(
    NULLIF(public.offer_jsonb_pence(p_quote, 'airport_charge_pence'), 0),
    NULLIF(public.offer_jsonb_pence(p_quote, 'airportChargePence'), 0)
  );
  IF v_pence IS NOT NULL THEN RETURN v_pence; END IF;

  v_pence := COALESCE(
    NULLIF(public.offer_jsonb_major_to_pence(p_quote, 'airportCharge'), 0),
    NULLIF(public.offer_jsonb_major_to_pence(p_quote, 'airport_charge'), 0)
  );
  IF v_pence IS NOT NULL THEN RETURN v_pence; END IF;

  -- Fee keys are major units on the quote.
  v_pickup := COALESCE(
    NULLIF(public.offer_jsonb_major_to_pence(p_quote, 'airport_pickup_fee'), 0),
    public.offer_jsonb_major_to_pence(p_quote, 'airportPickupFee'),
    0
  );
  v_dropoff := COALESCE(
    NULLIF(public.offer_jsonb_major_to_pence(p_quote, 'airport_dropoff_fee'), 0),
    public.offer_jsonb_major_to_pence(p_quote, 'airportDropoffFee'),
    0
  );
  IF v_pickup > 0 OR v_dropoff > 0 THEN
    RETURN v_pickup + v_dropoff;
  END IF;

  -- Any airport key present with a zero value is an authoritative zero.
  IF p_quote ? 'airport_charge_pence' OR p_quote ? 'airportChargePence'
     OR p_quote ? 'airportCharge' OR p_quote ? 'airport_charge' THEN
    RETURN 0;
  END IF;
  RETURN NULL;
END;
$function$;

-- Pure net split. Airport and other pass-through are non-commissionable and
-- clamped so they can never exceed the gross they sit inside.
--   commissionable = gross - airport - other
--   net            = commissionable - commission + airport + other   (INCLUDES airport)
--   journey_net    = commissionable - commission                     (EXCLUDES airport)
-- display_* is the existing zero-effective-commission display case: when the wave
-- commission is 0 the driver sees the net after the BASE commission.
CREATE OR REPLACE FUNCTION public.offer_driver_net_split(
  p_gross integer,
  p_airport integer,
  p_other integer,
  p_effective_percent numeric,
  p_base_percent numeric
) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_gross integer := GREATEST(0, COALESCE(p_gross, 0));
  v_airport integer;
  v_other integer;
  v_commissionable integer;
  v_commission integer;
  v_net integer;
  v_display_net integer;
  v_display_commission integer;
BEGIN
  v_airport := LEAST(GREATEST(0, COALESCE(p_airport, 0)), v_gross);
  v_other := LEAST(GREATEST(0, COALESCE(p_other, 0)), GREATEST(0, v_gross - v_airport));
  v_commissionable := GREATEST(0, v_gross - v_airport - v_other);
  v_commission := ROUND((v_commissionable::numeric * COALESCE(p_effective_percent, 0)) / 100.0);
  v_net := GREATEST(0, v_commissionable - v_commission) + v_airport + v_other;
  v_display_net := v_net;
  IF v_net = v_gross AND COALESCE(p_base_percent, 0) > 0 THEN
    v_display_commission := ROUND((v_commissionable::numeric * p_base_percent) / 100.0);
    v_display_net := GREATEST(0, v_commissionable - v_display_commission) + v_airport + v_other;
  END IF;
  RETURN jsonb_build_object(
    'gross_pence', v_gross,
    'airport_pence', v_airport,
    'other_pass_through_pence', v_other,
    'commissionable_pence', v_commissionable,
    'commission_pence', v_commission,
    'net_pence', v_net,
    'journey_net_pence', GREATEST(0, v_net - v_airport - v_other),
    'display_net_pence', v_display_net,
    'display_journey_net_pence', GREATEST(0, v_display_net - v_airport - v_other)
  );
END;
$function$;

-- Re-annotate preset driver nets so airport is not commissioned (grossFarePence
-- values are never touched).
CREATE OR REPLACE FUNCTION public.offer_annotate_preset_nets(
  p_presets jsonb,
  p_airport integer,
  p_other integer,
  p_effective_percent numeric
) RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_gross integer;
  v_net integer;
BEGIN
  IF p_presets IS NULL OR jsonb_typeof(p_presets) <> 'array' THEN RETURN p_presets; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_presets)
  LOOP
    v_gross := COALESCE(NULLIF(v_item ->> 'grossFarePence', '')::numeric, 0)::integer;
    IF v_gross > 0 THEN
      v_net := (public.offer_driver_net_split(v_gross, p_airport, p_other, p_effective_percent, NULL) ->> 'net_pence')::int;
      v_item := v_item || jsonb_build_object('driverNetPence', v_net, 'driver_net_pence', v_net);
    END IF;
    v_out := v_out || jsonb_build_array(v_item);
  END LOOP;
  RETURN v_out;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 1. Committed gross seed (SAME priority as committedBookingOfferFareSSOT.ts)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trip_negotiation_base_fare_pence(p_trip trips)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_discount integer;
  v_mod integer;
  v_gross integer;
  v_locked integer;
  v_final_customer integer;
  v_final integer;
  v_estimated_total integer;
  v_snap jsonb;
  v_key text;
  v_val integer;
  v_original integer;
  v_net integer;
  v_authorised integer;
  v_fb jsonb;
  v_breakdown jsonb;
  v_ride integer;
  v_major numeric;
BEGIN
  v_discount := GREATEST(0, COALESCE(p_trip.discount_pence, 0));
  IF v_discount = 0 THEN
    IF p_trip.discount_source = 'personal_voucher' THEN
      v_discount := GREATEST(0, COALESCE(p_trip.voucher_discount_pence, 0));
    ELSIF p_trip.discount_source = 'global_offer' THEN
      v_discount := GREATEST(0, COALESCE(p_trip.offer_discount_pence, 0));
    ELSE
      v_discount := GREATEST(
        GREATEST(0, COALESCE(p_trip.offer_discount_pence, 0)),
        GREATEST(0, COALESCE(p_trip.voucher_discount_pence, 0))
      );
    END IF;
  END IF;
  v_mod := COALESCE(p_trip.customer_modification_charge_pence, 0);
  v_gross := GREATEST(0, COALESCE(p_trip.gross_fare_pence, 0));

  -- 1. locked_base - a GROSS basis: skipped when a discount / modification makes it != payable.
  v_locked := GREATEST(0, COALESCE(p_trip.locked_base_fare_pence, 0));
  IF v_locked > 0 AND v_discount = 0 AND v_mod = 0 THEN
    RETURN v_locked;
  END IF;

  -- 2. final_customer_fare_pence
  v_final_customer := GREATEST(0, COALESCE(p_trip.final_customer_fare_pence, 0));
  IF v_final_customer > 0 THEN RETURN v_final_customer; END IF;

  -- 3. final_fare_pence (equal to a discounted gross means it is still pre-discount)
  v_final := GREATEST(0, COALESCE(p_trip.final_fare_pence, 0));
  IF v_final > 0 THEN
    IF v_discount > 0 AND v_gross > 0 AND v_final = v_gross THEN
      v_net := GREATEST(0, v_final - v_discount);
    ELSE
      v_net := v_final;
    END IF;
    IF v_net > 0 THEN RETURN v_net; END IF;
  END IF;

  -- 4. estimated_total_pence
  v_estimated_total := GREATEST(0, COALESCE(p_trip.estimated_total_pence, 0));
  IF v_estimated_total > 0 THEN RETURN v_estimated_total; END IF;

  -- 5. fare_snapshot_json committed / canonical / final_payable / original (net of discount)
  v_snap := CASE WHEN jsonb_typeof(p_trip.fare_snapshot_json) = 'object' THEN p_trip.fare_snapshot_json ELSE NULL END;
  IF v_snap IS NOT NULL THEN
    FOREACH v_key IN ARRAY ARRAY[
      'committed_fare_pence',
      'canonical_payable_fare_pence',
      'final_payable_fare_pence',
      'final_customer_fare_pence',
      'base_payable_fare_pence',
      'fare_after_discount_pence'
    ] LOOP
      v_val := public.offer_jsonb_pence(v_snap, v_key);
      IF v_val > 0 THEN RETURN v_val; END IF;
    END LOOP;
    v_original := public.offer_jsonb_pence(v_snap, 'original_fare_pence');
    IF v_original > 0 THEN
      v_net := CASE WHEN v_discount > 0 THEN GREATEST(0, v_original - v_discount) ELSE v_original END;
      IF v_net > 0 THEN RETURN v_net; END IF;
    END IF;
  END IF;

  -- gross - discount from the trip columns
  IF v_gross > 0 AND v_discount > 0 THEN
    v_net := GREATEST(0, v_gross - v_discount);
    IF v_net > 0 THEN RETURN v_net; END IF;
  END IF;

  -- 6. authorised amount on the trip, then its payment session
  v_authorised := GREATEST(0, COALESCE(p_trip.authorised_amount_pence, 0));
  IF v_authorised <= 0 AND p_trip.payment_session_id IS NOT NULL THEN
    BEGIN
      SELECT GREATEST(0, COALESCE(ps.authorised_amount_pence, 0))
        INTO v_authorised
      FROM public.payment_sessions ps
      WHERE ps.id = p_trip.payment_session_id;
    EXCEPTION WHEN OTHERS THEN
      v_authorised := 0;
    END;
    v_authorised := COALESCE(v_authorised, 0);
  END IF;
  IF v_authorised > 0 THEN RETURN v_authorised; END IF;

  -- 7. ONLY THEN fare_breakdown (final -> ride + airport), then the legacy columns.
  v_fb := CASE WHEN jsonb_typeof(p_trip.fare_breakdown) = 'object' THEN p_trip.fare_breakdown ELSE NULL END;
  v_breakdown := COALESCE(v_fb, v_snap);
  IF v_breakdown IS NOT NULL THEN
    v_val := public.offer_quote_final_pence(v_breakdown);
    IF v_val > 0 THEN RETURN v_val; END IF;
    v_ride := public.offer_quote_ride_pence(v_breakdown);
    IF v_ride > 0 THEN
      RETURN v_ride + COALESCE(public.offer_quote_airport_pence(v_breakdown), 0);
    END IF;
  END IF;

  IF v_gross > 0 THEN RETURN v_gross; END IF;

  v_major := CASE WHEN COALESCE(p_trip.fare, 0) > 0 THEN p_trip.fare ELSE COALESCE(p_trip.estimated_fare, 0) END;
  IF v_major > 0 THEN RETURN round(v_major * 100)::integer; END IF;

  RETURN GREATEST(0, COALESCE(p_trip.base_fare_pence, 0));
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Airport resolver. NULL = unknown, 0 = authoritative zero, >0 = amount.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.offer_resolve_airport_pence(p_trip trips)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_col integer := GREATEST(0, COALESCE(p_trip.airport_charge_pence, 0));
  v_fb integer;
  v_snap integer;
  v_quote_id uuid;
  v_quote integer;
  v_known_zero boolean := false;
BEGIN
  IF v_col > 0 THEN RETURN v_col; END IF;

  v_fb := public.offer_quote_airport_pence(p_trip.fare_breakdown);
  IF v_fb IS NOT NULL AND v_fb > 0 THEN RETURN v_fb; END IF;
  IF v_fb = 0 THEN v_known_zero := true; END IF;

  v_snap := public.offer_quote_airport_pence(p_trip.fare_snapshot_json);
  IF v_snap IS NOT NULL AND v_snap > 0 THEN RETURN v_snap; END IF;
  IF v_snap = 0 THEN v_known_zero := true; END IF;

  -- The offer is created INSIDE the trip INSERT, before the airport split is
  -- stamped on the trip row. The consumed server fare quote is the authority the
  -- later stamp uses, so read the same row (display only; binding checks stay in
  -- apply_consumed_server_fare_airport_split_to_trip).
  IF p_trip.payment_session_id IS NOT NULL THEN
    BEGIN
      SELECT NULLIF(ps.fare_snapshot ->> 'server_fare_quote_id', '')::uuid
        INTO v_quote_id
      FROM public.payment_sessions ps
      WHERE ps.id = p_trip.payment_session_id;

      IF v_quote_id IS NULL THEN
        SELECT bpq.server_fare_quote_id INTO v_quote_id
        FROM public.booking_payment_quotes bpq
        WHERE bpq.consumed_payment_session_id = p_trip.payment_session_id
        ORDER BY bpq.updated_at DESC NULLS LAST
        LIMIT 1;
      END IF;

      IF v_quote_id IS NULL AND p_trip.client_action_id IS NOT NULL THEN
        SELECT bpq.server_fare_quote_id INTO v_quote_id
        FROM public.booking_payment_quotes bpq
        WHERE bpq.client_action_id = p_trip.client_action_id
        ORDER BY bpq.updated_at DESC NULLS LAST
        LIMIT 1;
      END IF;

      IF v_quote_id IS NOT NULL THEN
        SELECT COALESCE(sfq.airport_charge_pence, 0) INTO v_quote
        FROM public.server_fare_quotes sfq
        WHERE sfq.id = v_quote_id;
        IF FOUND THEN
          IF v_quote > 0 THEN RETURN v_quote; END IF;
          v_known_zero := true;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG '[offer_resolve_airport_pence] consumed quote lookup failed trip_id=% err=%', p_trip.id, SQLERRM;
    END;
  END IF;

  IF v_known_zero THEN RETURN 0; END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.offer_resolve_airport_pence(trips) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offer_resolve_airport_pence(trips) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Offer insert stamp (committed gross x effective commission, airport split)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tr_stamp_offer_presets_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips;
  v_result jsonb;
  v_base_pence integer;
  v_net_pence integer;
  v_display_net integer;
  v_airport_known integer;
  v_airport_pence integer;
  v_airport_state text;
  v_other_pence integer;
  v_split jsonb;
  v_wave integer;
  v_base_pct numeric;
  v_reduction_pct numeric;
  v_effective_pct numeric;
  v_net_fields jsonb := '{}'::jsonb;
  v_airport_fields jsonb := '{}'::jsonb;
BEGIN
  IF NEW.status IS DISTINCT FROM 'pending' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.is_stacked, false) THEN RETURN NEW; END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = NEW.trip_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  BEGIN
    v_result := public.compute_ride_offer_preset_options(v_trip);
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[tr_stamp_offer_presets] compute failed trip_id=% offer_id=% err=%',
      NEW.trip_id, NEW.id, SQLERRM;
    v_result := jsonb_build_object('ok', false, 'reason', 'preset_compute_failed');
  END;

  -- Gross = COMMITTED payable (trip_negotiation_base_fare_pence follows
  -- committedBookingOfferFareSSOT priority; fare_breakdown is last).
  IF COALESCE((v_result->>'ok')::boolean, false) IS TRUE
     AND jsonb_typeof(v_result->'preset_options') = 'array'
     AND jsonb_array_length(v_result->'preset_options') >= 3 THEN
    v_base_pence := (v_result->>'base_pence')::int;
  ELSE
    v_base_pence := public.trip_negotiation_base_fare_pence(v_trip);
  END IF;

  v_wave := COALESCE(
    NEW.dispatch_wave,
    CASE
      WHEN NEW.broadcast_round IS NOT NULL AND NEW.broadcast_round > 0
        THEN ((NEW.broadcast_round - 1) % 3) + 1
      ELSE 1
    END
  );
  IF v_wave < 1 OR v_wave > 3 THEN
    v_wave := 1;
  END IF;

  -- Admin per-wave table only. Pass floor 0 so W1 cannot pin later waves.
  SELECT wc.base_percent, wc.reduction_percent, wc.effective_percent
    INTO v_base_pct, v_reduction_pct, v_effective_pct
  FROM public.resolve_wave_commission_percent(v_wave, 0) AS wc;

  NEW.dispatch_wave := v_wave;
  NEW.base_commission_percent := v_base_pct;
  NEW.wave_commission_reduction_percent := v_reduction_pct;
  NEW.effective_commission_percent := v_effective_pct;

  -- Airport: NULL unknown / 0 authoritative zero / >0 amount (never invented).
  v_airport_known := public.offer_resolve_airport_pence(v_trip);
  v_airport_pence := COALESCE(v_airport_known, 0);
  v_airport_state := CASE
    WHEN v_airport_known IS NULL THEN 'unknown'
    WHEN v_airport_known > 0 THEN 'present'
    ELSE 'zero'
  END;
  v_other_pence := GREATEST(0, COALESCE(v_trip.other_pass_through_charges_pence, 0));

  IF v_base_pence IS NOT NULL AND v_base_pence > 0 THEN
    v_split := public.offer_driver_net_split(
      v_base_pence, v_airport_pence, v_other_pence, v_effective_pct, v_base_pct
    );
    v_airport_pence := (v_split->>'airport_pence')::int;
    v_other_pence := (v_split->>'other_pass_through_pence')::int;
    v_net_pence := (v_split->>'net_pence')::int;
    v_display_net := (v_split->>'display_net_pence')::int;
    IF v_net_pence IS NOT NULL AND v_net_pence > 0 THEN
      v_net_fields := jsonb_build_object(
        'driver_net_fare_pence', v_display_net,
        'driver_earnings_pence', v_display_net,
        'driver_net_preview_pence', v_display_net,
        'driver_journey_net_pence', (v_split->>'display_journey_net_pence')::int,
        'final_trip_fare_pence', v_base_pence,
        'trip_fare_pence', v_base_pence,
        'currency', 'gbp',
        'currency_code', 'gbp',
        'commission_percent', v_effective_pct,
        'effective_commission_percent', v_effective_pct,
        'wave_commission_reduction_percent', v_reduction_pct,
        'base_commission_percent', v_base_pct,
        'platform_commission_pence', GREATEST(0, v_base_pence - v_net_pence)
      );
      NEW.offered_driver_net_pence := v_net_pence;
    END IF;
  END IF;

  -- Airport presentation fields. Always state the airport component explicitly:
  --   present -> amount + chip row,   zero -> authoritative 0 (row hidden),
  --   unknown -> NO amount key (the card must not treat it as zero).
  v_airport_fields := jsonb_build_object('airport_charge_state', v_airport_state);
  IF v_airport_state = 'present' THEN
    v_airport_fields := v_airport_fields || jsonb_build_object(
      'airport_charge_pence', v_airport_pence,
      'route_extra_items', jsonb_build_array(
        jsonb_build_object(
          'type', 'airport',
          'label', 'Airport',
          'amount_pence', v_airport_pence
        )
      )
    );
    IF COALESCE((v_result->>'ok')::boolean, false) IS TRUE
       AND jsonb_typeof(v_result->'preset_options') = 'array' THEN
      v_result := jsonb_set(
        v_result,
        '{preset_options}',
        public.offer_annotate_preset_nets(
          v_result->'preset_options', v_airport_pence, v_other_pence, v_effective_pct
        )
      );
    END IF;
  ELSIF v_airport_state = 'zero' THEN
    v_airport_fields := v_airport_fields || jsonb_build_object('airport_charge_pence', 0);
  END IF;

  IF COALESCE((v_result->>'ok')::boolean, false) IS TRUE
     AND jsonb_typeof(v_result->'preset_options') = 'array'
     AND jsonb_array_length(v_result->'preset_options') >= 3 THEN
    NEW.offer_snapshot := COALESCE(NEW.offer_snapshot,'{}'::jsonb)
      || jsonb_build_object(
        'baseFarePence', v_base_pence,
        'preset_options', v_result->'preset_options',
        'presets_enabled', true
      )
      || v_net_fields
      || v_airport_fields;
    IF NEW.offer_options IS NULL
       OR jsonb_typeof(NEW.offer_options) <> 'array'
       OR COALESCE(jsonb_array_length(NEW.offer_options), 0) < 3 THEN
      NEW.offer_options := v_result->'offer_options';
    END IF;
    RETURN NEW;
  END IF;

  IF v_base_pence IS NOT NULL AND v_base_pence > 0 THEN
    NEW.offer_options := NULL;
    NEW.offer_snapshot := (COALESCE(NEW.offer_snapshot,'{}'::jsonb) - 'preset_options' - 'presetFareOffers')
      || jsonb_build_object(
        'baseFarePence', v_base_pence,
        'preset_options', '[]'::jsonb,
        'presets_enabled', false,
        'preset_disabled_reason', COALESCE(v_result->>'reason', 'unavailable')
      )
      || v_net_fields
      || v_airport_fields;
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Defence: re-derive a PENDING offer when the trip's airport is stamped late
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.restamp_pending_offer_financials_for_trip(p_trip_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips;
  v_offer public.ride_offers;
  v_base integer;
  v_airport_known integer;
  v_airport integer;
  v_other integer;
  v_state text;
  v_split jsonb;
  v_snapshot jsonb;
  v_next jsonb;
  v_net integer;
  v_display_net integer;
  v_written integer := 0;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  v_base := public.trip_negotiation_base_fare_pence(v_trip);
  IF v_base IS NULL OR v_base <= 0 THEN RETURN 0; END IF;

  v_airport_known := public.offer_resolve_airport_pence(v_trip);
  v_airport := COALESCE(v_airport_known, 0);
  v_state := CASE
    WHEN v_airport_known IS NULL THEN 'unknown'
    WHEN v_airport_known > 0 THEN 'present'
    ELSE 'zero'
  END;
  v_other := GREATEST(0, COALESCE(v_trip.other_pass_through_charges_pence, 0));

  FOR v_offer IN
    SELECT *
    FROM public.ride_offers ro
    WHERE ro.trip_id = p_trip_id
      AND ro.status = 'pending'
      AND COALESCE(ro.is_stacked, false) = false
      AND ro.expires_at > now()
    FOR UPDATE
  LOOP
    -- Stored wave rate only. No invented rate.
    IF v_offer.effective_commission_percent IS NULL THEN CONTINUE; END IF;

    v_split := public.offer_driver_net_split(
      v_base, v_airport, v_other,
      v_offer.effective_commission_percent, v_offer.base_commission_percent
    );
    v_net := (v_split->>'net_pence')::int;
    v_display_net := (v_split->>'display_net_pence')::int;
    IF v_net <= 0 THEN CONTINUE; END IF;

    v_snapshot := COALESCE(v_offer.offer_snapshot, '{}'::jsonb);
    v_next := v_snapshot || jsonb_build_object(
      'baseFarePence', v_base,
      'final_trip_fare_pence', v_base,
      'trip_fare_pence', v_base,
      'driver_net_fare_pence', v_display_net,
      'driver_earnings_pence', v_display_net,
      'driver_net_preview_pence', v_display_net,
      'driver_journey_net_pence', (v_split->>'display_journey_net_pence')::int,
      'platform_commission_pence', GREATEST(0, v_base - v_net),
      'airport_charge_state', v_state
    );
    IF v_state = 'present' THEN
      v_next := v_next || jsonb_build_object(
        'airport_charge_pence', (v_split->>'airport_pence')::int,
        'route_extra_items', jsonb_build_array(
          jsonb_build_object(
            'type', 'airport',
            'label', 'Airport',
            'amount_pence', (v_split->>'airport_pence')::int
          )
        )
      );
    ELSIF v_state = 'zero' THEN
      v_next := (v_next - 'route_extra_items') || jsonb_build_object('airport_charge_pence', 0);
    END IF;

    IF v_state = 'present' AND jsonb_typeof(v_next -> 'preset_options') = 'array' THEN
      v_next := jsonb_set(
        v_next,
        '{preset_options}',
        public.offer_annotate_preset_nets(
          v_next -> 'preset_options', (v_split->>'airport_pence')::int,
          (v_split->>'other_pass_through_pence')::int, v_offer.effective_commission_percent
        )
      );
    END IF;

    IF v_next IS NOT DISTINCT FROM v_snapshot
       AND v_offer.offered_driver_net_pence IS NOT DISTINCT FROM v_net THEN
      CONTINUE;
    END IF;

    UPDATE public.ride_offers
       SET offer_snapshot = v_next,
           offered_driver_net_pence = v_net
     WHERE id = v_offer.id;
    v_written := v_written + 1;
  END LOOP;

  RETURN v_written;
END;
$function$;

REVOKE ALL ON FUNCTION public.restamp_pending_offer_financials_for_trip(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restamp_pending_offer_financials_for_trip(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.tr_restamp_pending_offers_on_airport_stamp_fn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM public.restamp_pending_offer_financials_for_trip(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- Presentation defence must never block a trip update.
    RAISE LOG '[tr_restamp_pending_offers_on_airport_stamp] failed trip_id=% err=%', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS tr_restamp_pending_offers_on_airport_stamp ON public.trips;
CREATE TRIGGER tr_restamp_pending_offers_on_airport_stamp
  AFTER UPDATE OF airport_charge_pence ON public.trips
  FOR EACH ROW
  WHEN (COALESCE(OLD.airport_charge_pence, 0) IS DISTINCT FROM COALESCE(NEW.airport_charge_pence, 0))
  EXECUTE FUNCTION public.tr_restamp_pending_offers_on_airport_stamp_fn();

-- ---------------------------------------------------------------------------
-- 5. Push data payload carries the airport component
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ride_offer_build_send_notification_body(p_offer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  ro public.ride_offers%ROWTYPE;
  v_driver RECORD;
  v_trip RECORD;
  v_pickup_summary TEXT;
  v_ccy TEXT;
  v_symbol TEXT;
  v_net_pence INT;
  v_net_disp TEXT;
  v_notify_title TEXT := 'New ride offer available near you!';
  v_notify_body TEXT := 'Tap to view details';
  v_trip_reference TEXT;
  v_semantic_type TEXT;
  v_preset_count INT := 0;
  v_preset_nets TEXT := '';
  v_android_channel TEXT := 'onecab_new_ride_offers_v1';
  v_ios_sound TEXT := 'onecab_new_ride_offer.wav';
  v_sent_at TEXT;
  v_expires_at TEXT;
  v_airport_pence INT;
  v_journey_pence INT;
BEGIN
  SELECT * INTO ro FROM public.ride_offers WHERE id = p_offer_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF ro.status <> 'pending' THEN RETURN NULL; END IF;

  SELECT id, user_id INTO v_driver FROM public.drivers WHERE id = ro.driver_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT
    id,
    pickup_address,
    dropoff_address,
    currency_code,
    trip_number,
    service_area_id,
    driver_net_pence
  INTO v_trip
  FROM public.trips WHERE id = ro.trip_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Data-only pickup summary (not OS alert body).
  v_pickup_summary := CASE
    WHEN v_trip.pickup_address IS NULL OR btrim(v_trip.pickup_address::text) = '' THEN 'Tap to view details'
    ELSE left(btrim(v_trip.pickup_address::text), 160)
  END;

  v_ccy := COALESCE(NULLIF(upper(trim(v_trip.currency_code::text)), ''), 'GBP');
  v_symbol := CASE v_ccy
    WHEN 'GBP' THEN '£'
    WHEN 'EUR' THEN '€'
    WHEN 'USD' THEN '$'
    ELSE v_ccy || ' '
  END;

  -- Net still computed for data payload / card hydrate — never into OS title/body.
  v_net_pence := COALESCE(
    NULLIF((ro.offer_snapshot ->> 'driver_net_preview_pence')::int, 0),
    NULLIF((ro.offer_snapshot ->> 'driver_earnings_pence')::int, 0),
    NULLIF((ro.offer_snapshot ->> 'driverNetPreviewPence')::int, 0),
    NULLIF((ro.offer_snapshot ->> 'driverEarningsPence')::int, 0),
    NULLIF(v_trip.driver_net_pence, 0),
    CASE
      WHEN ro.driver_id IS NOT NULL AND v_trip.service_area_id IS NOT NULL THEN
        public.compute_driver_net_preview_from_gross(
          COALESCE(
            NULLIF((ro.offer_snapshot ->> 'baseFarePence')::int, 0),
            NULLIF((ro.offer_snapshot ->> 'base_fare_pence')::int, 0)
          ),
          ro.driver_id,
          v_trip.service_area_id,
          COALESCE(
            NULLIF((ro.offer_snapshot ->> 'airport_charge_pence')::int, 0),
            NULLIF((ro.offer_snapshot ->> 'airportChargePence')::int, 0),
            0
          )
        )
      ELSE NULL
    END
  );

  -- Airport component. Only the amount the offer net was computed with (snapshot).
  -- Absent / unknown stays NULL (never 0); an authoritative zero is sent as 0.
  v_airport_pence := CASE
    WHEN COALESCE(ro.offer_snapshot ->> 'airport_charge_pence', '') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN round((ro.offer_snapshot ->> 'airport_charge_pence')::numeric)::int
    WHEN COALESCE(ro.offer_snapshot ->> 'airportChargePence', '') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN round((ro.offer_snapshot ->> 'airportChargePence')::numeric)::int
    ELSE NULL
  END;
  v_journey_pence := CASE
    WHEN v_airport_pence IS NULL THEN NULL
    WHEN COALESCE(ro.offer_snapshot ->> 'driver_journey_net_pence', '') ~ '^[0-9]+$'
      THEN (ro.offer_snapshot ->> 'driver_journey_net_pence')::int
    WHEN v_net_pence IS NOT NULL AND v_net_pence > 0
      THEN GREATEST(0, v_net_pence - v_airport_pence)
    ELSE NULL
  END;

  IF v_net_pence IS NOT NULL AND v_net_pence > 0 THEN
    v_net_disp := concat(v_symbol, trim(to_char(round(v_net_pence / 100.0, 2), 'FM999990.00')));
  ELSE
    v_net_disp := '—';
  END IF;

  v_trip_reference :=
    CASE
      WHEN v_trip.trip_number IS NOT NULL AND length(trim(v_trip.trip_number::text)) > 0 THEN trim(v_trip.trip_number::text)
      ELSE substring(v_trip.id::text, 1, 8)
    END;

  v_semantic_type := 'NEW_RIDE_OFFER';

  IF ro.offer_snapshot IS NOT NULL
     AND jsonb_typeof(ro.offer_snapshot -> 'preset_options') = 'array' THEN
    v_preset_count := jsonb_array_length(ro.offer_snapshot -> 'preset_options');
    SELECT string_agg(
      COALESCE(
        NULLIF(trim((elem ->> 'driverNetPence')), ''),
        NULLIF(trim((elem ->> 'driver_net_pence')), '')
      ),
      ','
      ORDER BY ord
    )
    INTO v_preset_nets
    FROM jsonb_array_elements(ro.offer_snapshot -> 'preset_options') WITH ORDINALITY AS t(elem, ord)
    WHERE COALESCE(
      NULLIF(trim((elem ->> 'driverNetPence')), ''),
      NULLIF(trim((elem ->> 'driver_net_pence')), '')
    ) IS NOT NULL;
  END IF;

  v_sent_at := to_char(timezone('utc', now()), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_expires_at := CASE
    WHEN ro.expires_at IS NULL THEN NULL
    ELSE to_char(timezone('utc', ro.expires_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  END;

  RETURN jsonb_build_object(
    'driverId', ro.driver_id::text,
    'type', 'RIDE_OFFER',
    'title', v_notify_title,
    'body', v_notify_body,
    'channel_id', v_android_channel,
    'android_channel_id', v_android_channel,
    'sound', v_ios_sound,
    'data', jsonb_strip_nulls(jsonb_build_object(
      'offer_notification_type', 'new_ride_offer',
      'type', v_semantic_type,
      'notificationType', v_semantic_type,
      'booking_id', ro.trip_id::text,
      'ride_id', ro.trip_id::text,
      'offer_id', ro.id::text,
      'offerId', ro.id::text,
      'trip_id', ro.trip_id::text,
      'tripId', ro.trip_id::text,
      'trip_reference', v_trip_reference,
      'pickup', coalesce(v_trip.pickup_address, ''),
      'dropoff', coalesce(v_trip.dropoff_address, ''),
      'pickup_summary', v_pickup_summary,
      'driver_earnings_pence', CASE WHEN v_net_pence IS NOT NULL AND v_net_pence > 0 THEN v_net_pence::text ELSE NULL END,
      'driver_net_preview_pence', CASE WHEN v_net_pence IS NOT NULL AND v_net_pence > 0 THEN v_net_pence::text ELSE NULL END,
      'airport_charge_pence', CASE WHEN v_airport_pence IS NOT NULL THEN v_airport_pence::text ELSE NULL END,
      'driver_journey_net_pence', CASE WHEN v_journey_pence IS NOT NULL THEN v_journey_pence::text ELSE NULL END,
      'event', 'ride_assigned',
      'expires_at', coalesce(ro.expires_at::text, ''),
      'expiresAt', v_expires_at,
      'sentAt', v_sent_at,
      'notificationVersion', '1',
      'negotiation_status', ro.negotiation_status,
      'negotiation_expires_at', coalesce(ro.negotiation_expires_at::text, ro.expires_at::text, ''),
      'customer_counter_fare',
        CASE
          WHEN ro.customer_counter_fare IS NOT NULL AND ro.customer_counter_fare > 0
            THEN ro.customer_counter_fare::text
          ELSE NULL
        END,
      'preset_options_count', CASE WHEN v_preset_count > 0 THEN v_preset_count::text ELSE NULL END,
      'preset_driver_net_pence', NULLIF(v_preset_nets, ''),
      'sound', v_ios_sound,
      'channel_id', v_android_channel,
      'is_stacked', CASE WHEN ro.is_stacked THEN 'true' ELSE 'false' END
    ))
  );
END;
$function$;

