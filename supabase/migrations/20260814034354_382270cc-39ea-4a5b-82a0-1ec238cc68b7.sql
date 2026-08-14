-- 1) Snapshot function: also persist monotonic reduction + audit evidence
CREATE OR REPLACE FUNCTION public.snapshot_accepted_wave_commission(p_trip_id uuid, p_offer_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_offer public.ride_offers%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_pct numeric;
  v_airport int;
  v_commissionable int;
  v_commission int;
  v_net int;
BEGIN
  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id;
  IF NOT FOUND OR v_offer.effective_commission_percent IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_pct := LEAST(100, GREATEST(0, v_offer.effective_commission_percent));
  v_airport := COALESCE(v_trip.airport_charge_pence, 0);
  v_commissionable := GREATEST(0, COALESCE(
    NULLIF(v_trip.final_customer_fare_pence, 0),
    NULLIF(v_trip.final_fare_pence, 0),
    NULLIF(v_trip.gross_fare_pence, 0), 0) - v_airport);
  v_commission := ROUND(v_commissionable * v_pct / 100.0)::int;
  v_net := GREATEST(0, v_commissionable - v_commission);

  UPDATE public.trips
  SET accepted_dispatch_wave = v_offer.dispatch_wave,
      accepted_dispatch_round = v_offer.dispatch_round,
      accepted_commission_percent = v_pct,
      max_wave_commission_reduction_percent = GREATEST(
        COALESCE(max_wave_commission_reduction_percent, 0),
        COALESCE(v_offer.wave_commission_reduction_percent, 0)
      ),
      commission_pct = v_pct,
      driver_tier_commission_percent = v_pct,
      snapshotted_commission_rate_bps = ROUND(v_pct * 100)::int,
      commissionable_fare_pence = CASE WHEN v_commissionable > 0 THEN v_commissionable ELSE commissionable_fare_pence END,
      commission_pence = CASE WHEN v_commissionable > 0 THEN v_commission ELSE commission_pence END,
      driver_net_pence = CASE WHEN v_commissionable > 0 THEN v_net ELSE driver_net_pence END,
      driver_net_before_tip_pence = CASE WHEN v_commissionable > 0 THEN v_net ELSE driver_net_before_tip_pence END,
      platform_gross_revenue_pence = CASE WHEN v_commissionable > 0 THEN v_commission ELSE platform_gross_revenue_pence END,
      platform_net_revenue_pence = CASE WHEN v_commissionable > 0 THEN v_commission ELSE platform_net_revenue_pence END,
      onecab_net_pence = CASE WHEN v_commissionable > 0 THEN v_commission ELSE onecab_net_pence END,
      fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
        'accepted_dispatch_wave', v_offer.dispatch_wave,
        'accepted_dispatch_round', v_offer.dispatch_round,
        'accepted_commission_percent', v_pct,
        'accepted_wave_reduction_percent', v_offer.wave_commission_reduction_percent,
        'offered_driver_net_pence', v_offer.offered_driver_net_pence,
        'accepted_commission_pence', CASE WHEN v_commissionable > 0 THEN v_commission ELSE NULL END,
        'accepted_driver_net_pence', CASE WHEN v_commissionable > 0 THEN v_net ELSE NULL END,
        'wave_commission_snapshot_at', now()
      )),
      updated_at = now()
  WHERE id = p_trip_id;
END;
$function$;

-- 2) commit_negotiation_fare: prefer accepted wave snapshot over live settings
CREATE OR REPLACE FUNCTION public.commit_negotiation_fare(p_trip_id uuid, p_committed_fare_pence integer, p_fare_source text, p_ride_offer_id uuid DEFAULT NULL::uuid, p_driver_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_offer public.ride_offers%ROWTYPE;
  v_now timestamptz := now();
  v_counter_binding boolean;
  v_original_gross integer;
  v_gross_pence integer;
  v_discount_pence integer;
  v_pct numeric;
  v_pct_capped numeric;
  v_airport_pence integer;
  v_pass_through_pence integer;
  v_commissionable_pence integer;
  v_commission_pence integer;
  v_driver_net_pence integer;
  v_driver_total_pence integer;
  v_final_customer_pence integer;
  v_locked_base_pence integer;
  v_settle boolean;
  v_formula_version text := '1';
BEGIN
  IF p_trip_id IS NULL OR COALESCE(p_committed_fare_pence, 0) <= 0 OR p_fare_source IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_INPUT');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  IF p_ride_offer_id IS NOT NULL THEN
    SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_ride_offer_id;
  END IF;

  v_counter_binding := p_fare_source = 'customer_counter_offer';
  v_settle := p_driver_id IS NOT NULL;

  v_original_gross := COALESCE(
    NULLIF(v_trip.gross_fare_pence, 0),
    NULLIF(v_trip.base_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(ROUND(COALESCE(v_trip.estimated_fare, 0) * 100)::integer, 0),
    NULLIF(v_offer.counter_fare, 0),
    p_committed_fare_pence
  );

  IF v_counter_binding THEN
    v_gross_pence := p_committed_fare_pence;
    v_discount_pence := 0;
    v_final_customer_pence := p_committed_fare_pence;
    v_locked_base_pence := p_committed_fare_pence;
  ELSIF p_fare_source = 'negotiated_offer' THEN
    v_gross_pence := p_committed_fare_pence;
    IF v_original_gross > p_committed_fare_pence THEN
      v_discount_pence := GREATEST(
        COALESCE(NULLIF(v_trip.discount_pence, 0), NULLIF(v_trip.offer_discount_pence, 0), 0),
        v_original_gross - p_committed_fare_pence
      );
    ELSE
      v_discount_pence := COALESCE(NULLIF(v_trip.discount_pence, 0), NULLIF(v_trip.offer_discount_pence, 0), 0);
    END IF;
    v_final_customer_pence := p_committed_fare_pence;
    v_locked_base_pence := p_committed_fare_pence;
  ELSE
    v_gross_pence := COALESCE(NULLIF(v_original_gross, 0), p_committed_fare_pence);
    v_discount_pence := COALESCE(
      NULLIF(v_trip.discount_pence, 0),
      NULLIF(v_trip.offer_discount_pence, 0),
      CASE WHEN v_gross_pence > p_committed_fare_pence THEN v_gross_pence - p_committed_fare_pence ELSE 0 END
    );
    v_final_customer_pence := COALESCE(
      NULLIF(v_trip.final_customer_fare_pence, 0),
      p_committed_fare_pence
    );
    v_locked_base_pence := COALESCE(NULLIF(v_gross_pence, 0), p_committed_fare_pence);
  END IF;

  v_commission_pence := NULL;
  v_driver_net_pence := NULL;
  v_driver_total_pence := NULL;
  v_commissionable_pence := NULL;

  IF v_settle THEN
    -- Dispatch wave commission snapshot is authoritative once the offer was accepted.
    IF v_trip.accepted_commission_percent IS NOT NULL THEN
      v_pct := v_trip.accepted_commission_percent;
      v_pct_capped := LEAST(100, GREATEST(0, v_pct));
    ELSE
      v_pct := public.resolve_driver_tier_commission_percent(p_driver_id, v_trip.service_area_id);
      v_pct_capped := LEAST(15, GREATEST(0, COALESCE(v_pct, 0)));
    END IF;
    v_airport_pence := COALESCE(v_trip.airport_charge_pence, 0);
    v_pass_through_pence := COALESCE(v_trip.other_pass_through_charges_pence, 0);
    v_commissionable_pence := GREATEST(0, p_committed_fare_pence - v_airport_pence - v_pass_through_pence);
    v_commission_pence := ROUND(v_commissionable_pence * v_pct_capped / 100.0);
    v_driver_net_pence := GREATEST(0, v_commissionable_pence - v_commission_pence);
    v_driver_total_pence := v_driver_net_pence + v_airport_pence + v_pass_through_pence;
  END IF;

  UPDATE public.trips
  SET
    base_fare_pence = CASE WHEN v_counter_binding THEN NULLIF(p_committed_fare_pence, 0) ELSE base_fare_pence END,
    gross_fare_pence = CASE WHEN v_settle THEN NULLIF(v_commissionable_pence, 0) ELSE gross_fare_pence END,
    discount_pence = CASE WHEN v_counter_binding THEN 0 ELSE discount_pence END,
    offer_discount_pence = CASE WHEN v_counter_binding THEN 0 ELSE offer_discount_pence END,
    final_fare_pence = NULLIF(p_committed_fare_pence, 0),
    final_customer_fare_pence = NULLIF(v_final_customer_pence, 0),
    locked_base_fare_pence = CASE WHEN v_settle THEN v_locked_base_pence ELSE locked_base_fare_pence END,
    estimated_total_pence = CASE
      WHEN v_counter_binding OR p_fare_source = 'negotiated_offer' THEN NULLIF(p_committed_fare_pence, 0)
      ELSE estimated_total_pence
    END,
    estimated_fare = CASE
      WHEN p_committed_fare_pence > 0 AND (v_counter_binding OR p_fare_source = 'negotiated_offer')
        THEN (p_committed_fare_pence::numeric / 100)
      ELSE estimated_fare
    END,
    fare = CASE WHEN p_committed_fare_pence > 0 THEN (p_committed_fare_pence::numeric / 100) ELSE fare END,
    fare_locked = CASE WHEN v_settle THEN true ELSE fare_locked END,
    fare_locked_at = CASE WHEN v_settle THEN COALESCE(fare_locked_at, v_now) ELSE fare_locked_at END,
    accepted_ride_offer_id = CASE WHEN v_settle AND p_ride_offer_id IS NOT NULL THEN p_ride_offer_id ELSE accepted_ride_offer_id END,
    accepted_driver_offer_fare_pence = CASE
      WHEN v_settle AND p_fare_source = 'negotiated_offer' THEN p_committed_fare_pence
      ELSE accepted_driver_offer_fare_pence
    END,
    accepted_preset_offer_fare_pence = CASE
      WHEN v_settle AND p_fare_source = 'negotiated_offer' THEN p_committed_fare_pence
      ELSE accepted_preset_offer_fare_pence
    END,
    locked_offer_type = CASE
      WHEN v_settle AND p_fare_source IN ('negotiated_offer', 'customer_counter_offer') THEN p_fare_source
      ELSE locked_offer_type
    END,
    commissionable_fare_pence = CASE WHEN v_settle THEN v_commissionable_pence ELSE commissionable_fare_pence END,
    commission_pence = CASE WHEN v_settle THEN v_commission_pence ELSE commission_pence END,
    driver_net_pence = CASE WHEN v_settle THEN v_driver_net_pence ELSE driver_net_pence END,
    driver_net_before_tip_pence = CASE WHEN v_settle THEN v_driver_net_pence ELSE driver_net_before_tip_pence END,
    driver_total_earnings_pence = CASE WHEN v_settle THEN v_driver_total_pence ELSE driver_total_earnings_pence END,
    driver_tier_commission_percent = CASE WHEN v_settle THEN v_pct_capped ELSE driver_tier_commission_percent END,
    commission_pct = CASE WHEN v_settle THEN v_pct_capped ELSE commission_pct END,
    platform_gross_revenue_pence = CASE WHEN v_settle THEN v_commission_pence ELSE platform_gross_revenue_pence END,
    platform_net_revenue_pence = CASE WHEN v_settle THEN v_commission_pence ELSE platform_net_revenue_pence END,
    onecab_net_pence = CASE WHEN v_settle THEN v_commission_pence ELSE onecab_net_pence END,
    settlement_formula_version = CASE WHEN v_settle THEN v_formula_version ELSE settlement_formula_version END,
    fare_breakdown = CASE
      WHEN p_committed_fare_pence > 0 AND fare_breakdown IS NOT NULL
        THEN fare_breakdown || jsonb_build_object('finalFare', (p_committed_fare_pence::numeric / 100))
      ELSE fare_breakdown
    END,
    fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'fare_source', p_fare_source,
        'committed_fare_pence', p_committed_fare_pence,
        'committed_at', v_now,
        'gross_fare_pence', CASE WHEN v_counter_binding OR p_fare_source = 'negotiated_offer' THEN NULLIF(v_gross_pence, 0) ELSE NULL END,
        'discount_pence', CASE WHEN v_counter_binding THEN 0 ELSE NULL END,
        'final_fare_pence', p_committed_fare_pence,
        'final_customer_fare_pence', v_final_customer_pence,
        'canonical_payable_fare_pence', p_committed_fare_pence,
        'final_payable_fare_pence', p_committed_fare_pence,
        'base_payable_fare_pence', CASE WHEN v_counter_binding THEN p_committed_fare_pence ELSE NULL END,
        'counter_offer_amount_pence', CASE WHEN v_counter_binding THEN p_committed_fare_pence ELSE NULL END,
        'negotiated_fare_pence', CASE WHEN p_fare_source = 'negotiated_offer' THEN p_committed_fare_pence ELSE NULL END,
        'rebroadcast_fare_pence', CASE WHEN NOT v_settle THEN p_committed_fare_pence ELSE NULL END,
        'rebroadcast_fare_source', CASE WHEN NOT v_settle THEN p_fare_source ELSE NULL END,
        'rebroadcast_counter_binding', CASE WHEN NOT v_settle THEN v_counter_binding ELSE NULL END,
        'commissionable_fare_pence', CASE WHEN v_settle THEN NULLIF(v_commissionable_pence, 0) ELSE NULL END,
        'commission_pence', CASE WHEN v_settle THEN NULLIF(v_commission_pence, 0) ELSE NULL END,
        'driver_net_pence', CASE WHEN v_settle THEN NULLIF(v_driver_net_pence, 0) ELSE NULL END,
        'driver_total_earnings_pence', CASE WHEN v_settle THEN NULLIF(v_driver_total_pence, 0) ELSE NULL END,
        'platform_gross_revenue_pence', CASE WHEN v_settle THEN NULLIF(v_commission_pence, 0) ELSE NULL END,
        'platform_net_revenue_pence', CASE WHEN v_settle THEN NULLIF(v_commission_pence, 0) ELSE NULL END,
        'commission_source', CASE WHEN v_settle AND v_trip.accepted_commission_percent IS NOT NULL THEN 'accepted_wave_snapshot' WHEN v_settle THEN 'global_base' ELSE NULL END,
        'settlement_formula_version', CASE WHEN v_settle THEN v_formula_version ELSE NULL END,
        'accepted_fare_pence', CASE WHEN v_settle THEN p_committed_fare_pence ELSE NULL END,
        'fare_finalized_at', CASE WHEN v_settle THEN v_now ELSE NULL END
      )),
    updated_at = v_now
  WHERE id = p_trip_id;

  IF p_ride_offer_id IS NOT NULL THEN
    UPDATE public.ride_offers
    SET
      offer_snapshot = COALESCE(offer_snapshot, '{}'::jsonb)
        || jsonb_strip_nulls(jsonb_build_object(
          'final_fare_pence', p_committed_fare_pence,
          'committed_fare_pence', p_committed_fare_pence,
          'fare_source', p_fare_source,
          'committed_at', v_now
        )),
      updated_at = v_now
    WHERE id = p_ride_offer_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', p_trip_id,
    'committed_fare_pence', p_committed_fare_pence,
    'fare_source', p_fare_source,
    'counter_binding', v_counter_binding,
    'settled', v_settle,
    'final_fare_pence', p_committed_fare_pence,
    'final_customer_fare_pence', v_final_customer_pence,
    'gross_fare_pence', v_gross_pence,
    'commissionable_fare_pence', v_commissionable_pence,
    'commission_pence', v_commission_pence,
    'commission_percent', v_pct_capped,
    'driver_net_pence', v_driver_net_pence,
    'driver_total_earnings_pence', v_driver_total_pence,
    'settlement_formula_version', CASE WHEN v_settle THEN v_formula_version ELSE NULL END
  );
END;
$function$;

-- 3) accept_ride_offer: wire the acceptance snapshot into the authoritative accept path
CREATE OR REPLACE FUNCTION public.accept_ride_offer(p_offer_id uuid, p_driver_id uuid, p_allow_customer_counter boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_offer public.ride_offers%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_fare_pence integer;
  v_fare_source text;
  v_original_fare_pence integer;
  v_gross_pence integer;
  v_discount_pence integer;
  v_booking_net_pence integer;
  v_final_customer_pence integer;
  v_locked_base_pence integer;
  v_fare_finalize jsonb;
  v_preset_key text;
  v_preset_fare_pence integer;
  v_accepted public.trips%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  PERFORM p_allow_customer_counter;

  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND', 'message', 'Offer not found');
  END IF;

  IF v_offer.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_MISMATCH', 'message', 'Offer not yours');
  END IF;

  IF v_offer.status = 'accepted' AND v_offer.negotiation_status = 'confirmed' THEN
    SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id;
    IF v_trip.driver_id = p_driver_id OR v_trip.confirmed_driver_id = p_driver_id THEN
      PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);
      RETURN jsonb_build_object(
        'success', true,
        'trip_id', v_offer.trip_id,
        'status', v_trip.status,
        'driver_id', p_driver_id,
        'final_fare_pence', v_trip.final_fare_pence,
        'final_customer_fare_pence', v_trip.final_customer_fare_pence,
        'fare_source', COALESCE(v_trip.fare_snapshot_json->>'fare_source', 'original_fare'),
        'effective_commission_percent', v_trip.accepted_commission_percent,
        'offered_driver_net_pence', COALESCE(v_offer.offered_driver_net_pence, v_trip.driver_net_pence),
        'dispatch_wave', v_trip.accepted_dispatch_wave,
        'dispatch_round', v_trip.accepted_dispatch_round,
        'accepted_via', 'accept_ride_offer',
        'idempotent', true
      );
    END IF;
  END IF;

  IF v_offer.status NOT IN ('pending', 'countered') THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_PENDING', 'message', 'Offer already ' || COALESCE(v_offer.status, 'handled'));
  END IF;

  IF v_offer.negotiation_status IS DISTINCT FROM 'waiting_customer'
     AND v_offer.negotiation_status IS DISTINCT FROM 'declined_customer_awaiting_driver'
     AND NOT (COALESCE(v_offer.driver_offer_fare, 0) > 0 AND v_offer.status IN ('pending', 'countered'))
     AND NOT (v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver', 'driver_accepted_counter') AND COALESCE(v_offer.customer_counter_fare, 0) > 0)
     AND NOT (v_offer.negotiation_status IS NULL AND v_offer.status IN ('pending', 'countered')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_ACCEPTABLE', 'message', 'Offer is not awaiting acceptance');
  END IF;

  IF v_offer.customer_respond_by IS NOT NULL AND v_offer.customer_respond_by < v_now AND v_offer.negotiation_status = 'waiting_customer' THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Offer has expired');
  END IF;
  IF v_offer.driver_respond_by IS NOT NULL AND v_offer.driver_respond_by < v_now AND v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver') THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Counter-offer response window expired');
  END IF;
  IF v_offer.negotiation_expires_at IS NOT NULL AND v_offer.negotiation_expires_at < v_now AND v_offer.negotiation_status = 'declined_customer_awaiting_driver' THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Standard fare acceptance window expired');
  END IF;
  IF v_offer.expires_at IS NOT NULL AND v_offer.expires_at < v_now THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Offer has expired');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND', 'message', 'Trip not found');
  END IF;
  IF v_trip.driver_id IS NOT NULL AND v_trip.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride already taken');
  END IF;
  IF v_trip.confirmed_driver_id IS NOT NULL AND v_trip.confirmed_driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride already taken');
  END IF;
  IF v_trip.status NOT IN ('pending','searching','searching_new_driver','offered','broadcasting','offering','negotiating','accepted','confirmed','driver_assigned') THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride not available for assignment');
  END IF;

  IF public.driver_is_excluded_from_trip(v_offer.trip_id, p_driver_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DRIVER_EXCLUDED',
      'message', 'Driver is excluded from this trip'
    );
  END IF;

  v_original_fare_pence := COALESCE(
    NULLIF(v_trip.gross_fare_pence, 0),
    NULLIF(v_trip.base_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(ROUND(COALESCE(v_trip.estimated_fare, 0) * 100)::integer, 0),
    NULLIF(v_offer.counter_fare, 0),
    0
  );

  IF COALESCE(v_offer.customer_counter_fare, 0) > 0
     AND v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver', 'driver_accepted_counter') THEN
    v_fare_pence := v_offer.customer_counter_fare;
    v_fare_source := 'customer_counter_offer';
  ELSIF COALESCE(v_offer.driver_offer_fare, 0) > 0
     AND v_offer.negotiation_status = 'waiting_customer' THEN
    v_fare_pence := v_offer.driver_offer_fare;
    v_fare_source := 'negotiated_offer';
  ELSIF v_offer.negotiation_status = 'declined_customer_awaiting_driver' THEN
    v_fare_pence := v_original_fare_pence;
    v_fare_source := 'original_fare';
  ELSE
    v_fare_pence := v_original_fare_pence;
    v_fare_source := 'original_fare';
  END IF;

  IF v_fare_pence <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_FARE', 'message', 'Invalid fare');
  END IF;

  v_gross_pence := COALESCE(NULLIF(v_trip.gross_fare_pence, 0), NULLIF(v_original_fare_pence, 0), v_fare_pence);
  v_discount_pence := COALESCE(NULLIF(v_trip.discount_pence, 0), NULLIF(v_trip.offer_discount_pence, 0), 0);
  v_booking_net_pence := COALESCE(NULLIF(v_trip.final_customer_fare_pence, 0), NULLIF(v_trip.final_fare_pence, 0));

  IF v_fare_source IN ('negotiated_offer', 'customer_counter_offer') THEN
    v_final_customer_pence := v_fare_pence;
    v_locked_base_pence := v_fare_pence;
    IF v_gross_pence > v_fare_pence THEN
      v_discount_pence := GREATEST(v_discount_pence, v_gross_pence - v_fare_pence);
    END IF;
  ELSIF v_booking_net_pence IS NOT NULL AND v_booking_net_pence > 0 AND v_gross_pence > v_booking_net_pence THEN
    v_final_customer_pence := v_booking_net_pence;
    v_locked_base_pence := v_gross_pence;
  ELSIF v_discount_pence > 0 AND v_gross_pence > v_discount_pence THEN
    v_final_customer_pence := v_gross_pence - v_discount_pence;
    v_locked_base_pence := v_gross_pence;
  ELSE
    v_final_customer_pence := v_fare_pence;
    v_locked_base_pence := COALESCE(NULLIF(v_gross_pence, 0), v_fare_pence);
  END IF;

  v_preset_key := NULLIF(v_offer.offer_snapshot->>'selectedOfferKey', '');
  IF v_preset_key IS NOT NULL THEN
    v_preset_fare_pence := NULLIF((v_offer.offer_snapshot->'selectedOffer'->>'grossFarePence')::integer, 0);
  END IF;

  v_fare_finalize := public.finalize_negotiated_fare(v_offer.trip_id, p_offer_id, v_final_customer_pence, v_fare_source, p_driver_id);

  IF COALESCE(v_fare_finalize->>'success', 'false') <> 'true' THEN
    RETURN jsonb_build_object('success', false, 'error', 'FARE_FINALIZE_FAILED', 'message', COALESCE(v_fare_finalize->>'error', 'Could not finalize fare'));
  END IF;

  UPDATE public.ride_offers
  SET
    status = 'accepted',
    negotiation_status = 'confirmed',
    driver_offer_fare = CASE WHEN v_fare_source IN ('customer_counter_offer', 'negotiated_offer') THEN v_fare_pence ELSE driver_offer_fare END,
    counter_fare = CASE WHEN v_fare_source IN ('customer_counter_offer', 'negotiated_offer') THEN v_fare_pence ELSE counter_fare END,
    responded_at = v_now,
    customer_respond_by = NULL,
    driver_respond_by = NULL,
    grace_window_expires_at = NULL,
    negotiation_expires_at = NULL,
    expires_at = v_now + interval '7 days',
    updated_at = v_now
  WHERE id = p_offer_id;

  UPDATE public.ride_offers
  SET status = 'revoked', revoked_reason = 'another_offer_accepted', negotiation_status = NULL,
      customer_respond_by = NULL, driver_respond_by = NULL, grace_window_expires_at = NULL,
      negotiation_expires_at = NULL, updated_at = v_now
  WHERE trip_id = v_offer.trip_id AND id <> p_offer_id AND status IN ('pending', 'countered');

  UPDATE public.trips
  SET
    status = 'driver_assigned',
    driver_id = p_driver_id,
    confirmed_driver_id = p_driver_id,
    negotiation_owner_driver_id = NULL,
    negotiation_locked_until = NULL,
    negotiation_status = 'confirmed',
    current_offer_driver_id = NULL,
    current_offer_expires_at = NULL,
    dispatch_status = 'assigned',
    searching_expires_at = NULL,
    assigned_at = COALESCE(assigned_at, v_now),
    accepted_ride_offer_id = p_offer_id,
    cancelled_at = NULL,
    cancelled_by = NULL,
    cancel_reason = NULL,
    cancellation_reason = NULL,
    cancellation_note = NULL,
    accepted_driver_offer_fare_pence = CASE
      WHEN v_fare_source = 'negotiated_offer' THEN v_fare_pence
      ELSE accepted_driver_offer_fare_pence
    END,
    accepted_preset_offer_fare_pence = CASE
      WHEN v_preset_key IS NOT NULL AND v_preset_fare_pence IS NOT NULL THEN v_preset_fare_pence
      WHEN v_preset_key IS NOT NULL AND v_fare_source = 'negotiated_offer' THEN v_fare_pence
      ELSE accepted_preset_offer_fare_pence
    END,
    locked_offer_type = CASE
      WHEN v_fare_source IN ('negotiated_offer', 'customer_counter_offer') THEN v_fare_source
      ELSE locked_offer_type
    END,
    fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'original_fare_pence', NULLIF(v_original_fare_pence, 0),
        'accepted_via', 'accept_ride_offer',
        'accepted_at', v_now,
        'accepted_preset_key', v_preset_key,
        'accepted_preset_fare_pence', v_preset_fare_pence
      )),
    updated_at = v_now
  WHERE id = v_offer.trip_id;

  -- Dispatch wave economics snapshot (authoritative accepted commission for settlement).
  PERFORM public.snapshot_accepted_wave_commission(v_offer.trip_id, p_offer_id);

  UPDATE public.drivers SET current_trip_id = v_offer.trip_id, updated_at = v_now WHERE id = p_driver_id;

  IF v_trip.passenger_id IS NOT NULL THEN
    UPDATE public.customers SET active_trip_id = v_offer.trip_id, updated_at = v_now
    WHERE id = v_trip.passenger_id OR user_id = v_trip.passenger_id;
  END IF;

  PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);

  BEGIN
    PERFORM public.assert_payment_gate(v_offer.trip_id);
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      RAISE EXCEPTION '%', SQLERRM USING ERRCODE = 'P0001';
  END;

  SELECT * INTO v_accepted FROM public.trips WHERE id = v_offer.trip_id;

  BEGIN
    PERFORM public.record_booking_delivery(v_offer.trip_id, 'accepted', p_driver_id, p_offer_id, 'postgres',
      jsonb_strip_nulls(jsonb_build_object(
        'fare_source', v_fare_source,
        'final_fare_pence', v_final_customer_pence,
        'final_customer_fare_pence', v_final_customer_pence,
        'accepted_preset_key', v_preset_key,
        'accepted_commission_percent', v_accepted.accepted_commission_percent,
        'accepted_dispatch_wave', v_accepted.accepted_dispatch_wave,
        'accepted_dispatch_round', v_accepted.accepted_dispatch_round,
        'accepted_via', 'accept_ride_offer'
      )));
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[accept_ride_offer] record_booking_delivery failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', v_offer.trip_id,
    'status', 'driver_assigned',
    'driver_id', p_driver_id,
    'final_fare_pence', v_final_customer_pence,
    'final_customer_fare_pence', v_final_customer_pence,
    'gross_fare_pence', (v_fare_finalize->>'gross_fare_pence')::integer,
    'discount_pence', v_discount_pence,
    'commission_pence', COALESCE(v_accepted.commission_pence, (v_fare_finalize->>'commission_pence')::integer),
    'driver_net_pence', COALESCE(v_accepted.driver_net_pence, (v_fare_finalize->>'driver_net_pence')::integer),
    'offered_driver_net_pence', COALESCE(v_offer.offered_driver_net_pence, v_accepted.driver_net_pence),
    'effective_commission_percent', COALESCE(v_accepted.accepted_commission_percent, v_offer.effective_commission_percent),
    'dispatch_wave', COALESCE(v_accepted.accepted_dispatch_wave, v_offer.dispatch_wave),
    'dispatch_round', COALESCE(v_accepted.accepted_dispatch_round, v_offer.dispatch_round),
    'fare_source', v_fare_source,
    'accepted_preset_key', v_preset_key,
    'accepted_preset_fare_pence', v_preset_fare_pence,
    'original_fare_pence', v_original_fare_pence,
    'counter_offer_amount_pence', v_offer.customer_counter_fare,
    'accepted_via', 'accept_ride_offer'
  );
END;
$function$;