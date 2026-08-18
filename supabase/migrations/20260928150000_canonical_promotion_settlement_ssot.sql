-- Canonical promotion settlement SSOT (Step 2A.1).
-- global_offer: commissionable = pre-promotion original + full-price modifications;
-- promotion reduces ONECAB commission only (never driver_net).
-- Fail closed when promoted trip lacks pre-promotion evidence.
-- Negotiated fare supersedes prior global_offer for settlement (audit metadata retained).

CREATE OR REPLACE FUNCTION public.resolve_trip_locked_promotion_pence(p_trip public.trips)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF COALESCE(p_trip.discount_source, '') = 'global_offer' THEN
    RETURN GREATEST(0, COALESCE(p_trip.offer_discount_pence, 0));
  END IF;
  RETURN 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.trip_promotion_superseded_by_negotiation(p_trip public.trips)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF COALESCE(p_trip.locked_offer_type, '') = 'negotiated_offer' THEN
    RETURN true;
  END IF;
  IF COALESCE(p_trip.fare_snapshot_json->>'promotion_application_status', '') = 'SUPERSEDED_BY_NEGOTIATION' THEN
    RETURN true;
  END IF;
  IF COALESCE(p_trip.fare_snapshot_json->>'fare_source', '') IN ('negotiated', 'negotiated_offer') THEN
    RETURN true;
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_trip_pre_promotion_ride_fare_pence(p_trip public.trips)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN COALESCE(
    NULLIF((p_trip.fare_snapshot_json->>'original_fare_pence')::integer, 0),
    NULLIF((p_trip.fare_snapshot_json->>'gross_fare_pence')::integer, 0),
    NULLIF(p_trip.locked_base_fare_pence, 0),
    0
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_trip_negotiated_commissionable_fare_pence(
  p_trip public.trips,
  p_negotiated_ride_fare_pence integer DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_negotiated integer;
  v_mod integer;
BEGIN
  v_negotiated := COALESCE(
    NULLIF(p_negotiated_ride_fare_pence, 0),
    NULLIF((p_trip.fare_snapshot_json->>'negotiated_commissionable_fare_pence')::integer, 0),
    NULLIF(p_trip.accepted_driver_offer_fare_pence, 0),
    NULLIF((p_trip.fare_snapshot_json->>'negotiated_fare_pence')::integer, 0),
    NULLIF(p_trip.final_fare_pence, 0),
    0
  );
  v_mod := GREATEST(0, COALESCE(p_trip.customer_modification_charge_pence, 0));
  RETURN GREATEST(0, v_negotiated + v_mod);
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_trip_commissionable_fare_pence(
  p_trip public.trips,
  p_committed_fare_pence integer,
  p_airport_pence integer DEFAULT 0,
  p_pass_through_pence integer DEFAULT 0
)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_promo integer;
  v_pre_ride integer;
  v_mod integer;
BEGIN
  IF public.trip_promotion_superseded_by_negotiation(p_trip) THEN
    RETURN public.resolve_trip_negotiated_commissionable_fare_pence(p_trip, NULL);
  END IF;

  v_promo := public.resolve_trip_locked_promotion_pence(p_trip);
  IF v_promo > 0 THEN
    v_pre_ride := public.resolve_trip_pre_promotion_ride_fare_pence(p_trip);
    IF v_pre_ride <= 0 THEN
      RAISE EXCEPTION 'PRE_PROMOTION_FARE_EVIDENCE_MISSING' USING ERRCODE = 'P0001';
    END IF;
    v_mod := GREATEST(0, COALESCE(p_trip.customer_modification_charge_pence, 0));
    RETURN GREATEST(0, v_pre_ride + v_mod);
  END IF;

  RETURN GREATEST(0, COALESCE(p_committed_fare_pence, 0) - GREATEST(0, p_airport_pence) - GREATEST(0, p_pass_through_pence));
END;
$$;

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
  v_total int;
  v_offered_net int;
  v_applied_promotion int;
  v_commission_after_promotion int;
  v_previous_locked_promotion int;
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

  IF public.trip_promotion_superseded_by_negotiation(v_trip) THEN
    v_previous_locked_promotion := public.resolve_trip_locked_promotion_pence(v_trip);
    v_applied_promotion := 0;
    v_commissionable := public.resolve_trip_negotiated_commissionable_fare_pence(v_trip, NULL);
  ELSE
    v_applied_promotion := public.resolve_trip_locked_promotion_pence(v_trip);
    v_commissionable := public.resolve_trip_commissionable_fare_pence(
      v_trip,
      COALESCE(
        NULLIF(v_trip.final_customer_fare_pence, 0),
        NULLIF(v_trip.final_fare_pence, 0),
        NULLIF(v_trip.gross_fare_pence, 0),
        0
      ),
      v_airport,
      0
    );
  END IF;

  v_commission := ROUND(v_commissionable * v_pct / 100.0)::int;
  v_commission_after_promotion := v_commission - v_applied_promotion;
  v_net := GREATEST(0, v_commissionable - v_commission);
  v_total := v_net + v_airport;
  v_offered_net := COALESCE(v_offer.offered_driver_net_pence, v_net);

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
      driver_total_earnings_pence = CASE WHEN v_commissionable > 0 THEN v_total ELSE driver_total_earnings_pence END,
      platform_gross_revenue_pence = CASE WHEN v_commissionable > 0 THEN v_commission ELSE platform_gross_revenue_pence END,
      platform_net_revenue_pence = CASE WHEN v_commissionable > 0 THEN v_commission_after_promotion ELSE platform_net_revenue_pence END,
      onecab_net_pence = CASE WHEN v_commissionable > 0 THEN v_commission_after_promotion ELSE onecab_net_pence END,
      settlement_formula_version = '2',
      fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb) || jsonb_build_object(
        'accepted_dispatch_wave', v_offer.dispatch_wave,
        'accepted_dispatch_round', v_offer.dispatch_round,
        'accepted_commission_percent', v_pct,
        'accepted_wave_reduction_percent', v_offer.wave_commission_reduction_percent,
        'offered_driver_net_pence', v_offered_net,
        'accepted_commission_pence', v_commission,
        'accepted_driver_net_pence', v_net,
        'commissionable_fare_pence', v_commissionable,
        'commission_pence', v_commission,
        'locked_promotion_pence', v_applied_promotion,
        'applied_customer_promotion_pence', v_applied_promotion,
        'commission_after_promotion_pence', v_commission_after_promotion,
        'previous_locked_promotion_pence', CASE WHEN public.trip_promotion_superseded_by_negotiation(v_trip) THEN v_previous_locked_promotion ELSE NULL END,
        'promotion_application_status', CASE WHEN public.trip_promotion_superseded_by_negotiation(v_trip) THEN 'SUPERSEDED_BY_NEGOTIATION' ELSE NULL END,
        'driver_net_pence', v_net,
        'driver_total_earnings_pence', v_total,
        'platform_gross_revenue_pence', v_commission,
        'platform_net_revenue_pence', v_commission_after_promotion,
        'onecab_net_pence', v_commission_after_promotion,
        'commission_source', 'accepted_wave_snapshot',
        'settlement_formula_version', '2',
        'wave_commission_snapshot_at', now()
      ),
      updated_at = now()
  WHERE id = p_trip_id;
END;
$function$;

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
  v_commission_source text;
  v_use_wave boolean := false;
  v_applied_promotion_pence integer := 0;
  v_commission_after_promotion_pence integer := 0;
  v_previous_locked_promotion_pence integer := 0;
  v_snapshot_fare_source text;
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
  v_snapshot_fare_source := CASE WHEN p_fare_source = 'negotiated_offer' AND v_settle THEN 'negotiated' ELSE p_fare_source END;

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
  v_commission_source := NULL;

  IF v_settle THEN
    IF v_offer.effective_commission_percent IS NOT NULL THEN
      v_pct := v_offer.effective_commission_percent;
      v_use_wave := true;
    ELSIF v_trip.accepted_commission_percent IS NOT NULL THEN
      v_pct := v_trip.accepted_commission_percent;
      v_use_wave := true;
    ELSE
      v_pct := public.resolve_driver_tier_commission_percent(p_driver_id, v_trip.service_area_id);
    END IF;

    IF v_use_wave THEN
      v_pct_capped := LEAST(100, GREATEST(0, COALESCE(v_pct, 0)));
      v_commission_source := 'accepted_wave_snapshot';
      v_formula_version := '2';
      v_airport_pence := COALESCE(v_trip.airport_charge_pence, 0);
      v_pass_through_pence := 0;
    ELSE
      v_pct_capped := LEAST(15, GREATEST(0, COALESCE(v_pct, 0)));
      v_commission_source := 'global_base';
      v_formula_version := '1';
      v_airport_pence := COALESCE(v_trip.airport_charge_pence, 0);
      v_pass_through_pence := COALESCE(v_trip.other_pass_through_charges_pence, 0);
    END IF;

    IF p_fare_source = 'negotiated_offer' THEN
      v_previous_locked_promotion_pence := public.resolve_trip_locked_promotion_pence(v_trip);
      v_applied_promotion_pence := 0;
      v_commissionable_pence := public.resolve_trip_negotiated_commissionable_fare_pence(v_trip, p_committed_fare_pence);
      v_commission_pence := ROUND(v_commissionable_pence * v_pct_capped / 100.0)::int;
      v_commission_after_promotion_pence := v_commission_pence;
      v_driver_net_pence := GREATEST(0, v_commissionable_pence - v_commission_pence);
      v_driver_total_pence := v_driver_net_pence + v_airport_pence + v_pass_through_pence;
    ELSIF v_counter_binding THEN
      v_applied_promotion_pence := 0;
      v_commissionable_pence := GREATEST(0, p_committed_fare_pence - v_airport_pence - v_pass_through_pence);
      v_commission_pence := ROUND(v_commissionable_pence * v_pct_capped / 100.0)::int;
      v_commission_after_promotion_pence := v_commission_pence;
      v_driver_net_pence := GREATEST(0, v_commissionable_pence - v_commission_pence);
      v_driver_total_pence := v_driver_net_pence + v_airport_pence + v_pass_through_pence;
    ELSE
      v_applied_promotion_pence := public.resolve_trip_locked_promotion_pence(v_trip);
      v_commissionable_pence := public.resolve_trip_commissionable_fare_pence(
        v_trip,
        p_committed_fare_pence,
        v_airport_pence,
        v_pass_through_pence
      );
      v_commission_pence := ROUND(v_commissionable_pence * v_pct_capped / 100.0)::int;
      v_commission_after_promotion_pence := v_commission_pence - v_applied_promotion_pence;
      v_driver_net_pence := GREATEST(0, v_commissionable_pence - v_commission_pence);
      v_driver_total_pence := v_driver_net_pence + v_airport_pence + v_pass_through_pence;
    END IF;
  END IF;

  UPDATE public.trips
  SET
    base_fare_pence = CASE WHEN v_counter_binding THEN NULLIF(p_committed_fare_pence, 0) ELSE base_fare_pence END,
    gross_fare_pence = CASE WHEN v_settle THEN NULLIF(v_gross_pence, 0) ELSE gross_fare_pence END,
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
    platform_net_revenue_pence = CASE WHEN v_settle THEN v_commission_after_promotion_pence ELSE platform_net_revenue_pence END,
    onecab_net_pence = CASE WHEN v_settle THEN v_commission_after_promotion_pence ELSE onecab_net_pence END,
    settlement_formula_version = CASE WHEN v_settle THEN v_formula_version ELSE settlement_formula_version END,
    fare_breakdown = CASE
      WHEN p_committed_fare_pence > 0 AND fare_breakdown IS NOT NULL
        THEN fare_breakdown || jsonb_build_object('finalFare', (p_committed_fare_pence::numeric / 100))
      ELSE fare_breakdown
    END,
    fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'fare_source', v_snapshot_fare_source,
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
        'negotiated_commissionable_fare_pence', CASE WHEN p_fare_source = 'negotiated_offer' AND v_settle THEN p_committed_fare_pence ELSE NULL END,
        'previous_locked_promotion_pence', CASE WHEN p_fare_source = 'negotiated_offer' AND v_settle THEN v_previous_locked_promotion_pence ELSE NULL END,
        'promotion_application_status', CASE WHEN p_fare_source = 'negotiated_offer' AND v_settle THEN 'SUPERSEDED_BY_NEGOTIATION' ELSE NULL END,
        'rebroadcast_fare_pence', CASE WHEN NOT v_settle THEN p_committed_fare_pence ELSE NULL END,
        'rebroadcast_fare_source', CASE WHEN NOT v_settle THEN p_fare_source ELSE NULL END,
        'rebroadcast_counter_binding', CASE WHEN NOT v_settle THEN v_counter_binding ELSE NULL END,
        'commissionable_fare_pence', CASE WHEN v_settle THEN v_commissionable_pence ELSE NULL END,
        'commission_pence', CASE WHEN v_settle THEN v_commission_pence ELSE NULL END,
        'locked_promotion_pence', CASE WHEN v_settle THEN v_applied_promotion_pence ELSE NULL END,
        'applied_customer_promotion_pence', CASE WHEN v_settle THEN v_applied_promotion_pence ELSE NULL END,
        'commission_after_promotion_pence', CASE WHEN v_settle THEN v_commission_after_promotion_pence ELSE NULL END,
        'driver_net_pence', CASE WHEN v_settle THEN v_driver_net_pence ELSE NULL END,
        'driver_total_earnings_pence', CASE WHEN v_settle THEN v_driver_total_pence ELSE NULL END,
        'platform_gross_revenue_pence', CASE WHEN v_settle THEN v_commission_pence ELSE NULL END,
        'platform_net_revenue_pence', CASE WHEN v_settle THEN v_commission_after_promotion_pence ELSE NULL END,
        'onecab_net_pence', CASE WHEN v_settle THEN v_commission_after_promotion_pence ELSE NULL END,
        'commission_source', CASE WHEN v_settle THEN v_commission_source ELSE NULL END,
        'settlement_formula_version', CASE WHEN v_settle THEN v_formula_version ELSE NULL END,
        'accepted_fare_pence', CASE WHEN v_settle THEN p_committed_fare_pence ELSE NULL END,
        'offered_driver_net_pence', CASE WHEN v_settle THEN COALESCE(v_offer.offered_driver_net_pence, v_driver_net_pence) ELSE NULL END,
        'accepted_commission_percent', CASE WHEN v_settle AND v_use_wave THEN v_pct_capped ELSE NULL END,
        'accepted_commission_pence', CASE WHEN v_settle AND v_use_wave THEN v_commission_pence ELSE NULL END,
        'accepted_driver_net_pence', CASE WHEN v_settle AND v_use_wave THEN v_driver_net_pence ELSE NULL END,
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
    'fare_source', v_snapshot_fare_source,
    'counter_binding', v_counter_binding,
    'settled', v_settle,
    'final_fare_pence', p_committed_fare_pence,
    'final_customer_fare_pence', v_final_customer_pence,
    'gross_fare_pence', v_gross_pence,
    'commissionable_fare_pence', v_commissionable_pence,
    'commission_pence', v_commission_pence,
    'applied_customer_promotion_pence', v_applied_promotion_pence,
    'previous_locked_promotion_pence', CASE WHEN p_fare_source = 'negotiated_offer' AND v_settle THEN v_previous_locked_promotion_pence ELSE NULL END,
    'promotion_application_status', CASE WHEN p_fare_source = 'negotiated_offer' AND v_settle THEN 'SUPERSEDED_BY_NEGOTIATION' ELSE NULL END,
    'commission_after_promotion_pence', v_commission_after_promotion_pence,
    'commission_percent', v_pct_capped,
    'driver_net_pence', v_driver_net_pence,
    'driver_total_earnings_pence', v_driver_total_pence,
    'commission_source', v_commission_source,
    'settlement_formula_version', CASE WHEN v_settle THEN v_formula_version ELSE NULL END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.snapshot_driver_tier_commission_on_trip(p_trip_id uuid, p_driver_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_pct numeric;
  v_pct_capped numeric;
  v_base_pence integer;
  v_gross_pence integer;
  v_airport_pence integer;
  v_pass_through_pence integer;
  v_commissionable_pence integer;
  v_commission_pence integer;
  v_driver_net_pence integer;
  v_applied_promotion integer;
  v_commission_after_promotion integer;
BEGIN
  IF p_trip_id IS NULL OR p_driver_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  v_pct := public.resolve_driver_tier_commission_percent(p_driver_id, v_trip.service_area_id);
  v_pct_capped := LEAST(15, GREATEST(0, COALESCE(v_pct, 0)));

  v_base_pence := COALESCE(
    NULLIF(v_trip.final_fare_pence, 0),
    NULLIF(v_trip.final_customer_fare_pence, 0),
    NULLIF(v_trip.locked_base_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(ROUND(COALESCE(v_trip.fare, 0) * 100)::integer, 0),
    0
  );

  v_gross_pence := COALESCE(
    NULLIF(v_trip.gross_fare_pence, 0),
    NULLIF(v_base_pence, 0),
    0
  );

  v_airport_pence := COALESCE(v_trip.airport_charge_pence, 0);
  v_pass_through_pence := COALESCE(v_trip.other_pass_through_charges_pence, 0);
  v_applied_promotion := CASE
    WHEN public.trip_promotion_superseded_by_negotiation(v_trip) THEN 0
    ELSE public.resolve_trip_locked_promotion_pence(v_trip)
  END;
  v_commissionable_pence := public.resolve_trip_commissionable_fare_pence(
    v_trip,
    v_base_pence,
    v_airport_pence,
    v_pass_through_pence
  );
  v_commission_pence := ROUND(v_commissionable_pence * v_pct_capped / 100.0)::int;
  v_commission_after_promotion := v_commission_pence - v_applied_promotion;
  v_driver_net_pence := GREATEST(0, v_commissionable_pence - v_commission_pence);

  UPDATE public.trips
  SET
    driver_tier_commission_percent = v_pct_capped,
    commission_pct = v_pct_capped,
    commissionable_fare_pence = v_commissionable_pence,
    commission_pence = v_commission_pence,
    driver_net_pence = v_driver_net_pence,
    platform_gross_revenue_pence = v_commission_pence,
    platform_net_revenue_pence = v_commission_after_promotion,
    onecab_net_pence = v_commission_after_promotion,
    fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'driver_tier_commission_percent', v_pct_capped,
        'commissionable_fare_pence', NULLIF(v_commissionable_pence, 0),
        'commission_pence', NULLIF(v_commission_pence, 0),
        'applied_customer_promotion_pence', NULLIF(v_applied_promotion, 0),
        'commission_after_promotion_pence', v_commission_after_promotion,
        'driver_net_pence', NULLIF(v_driver_net_pence, 0),
        'commission_recalculated_at', now()
      )),
    updated_at = now()
  WHERE id = p_trip_id;

  RETURN v_pct_capped;
END;
$$;

DROP FUNCTION IF EXISTS public.resolve_trip_pre_promotion_ride_fare_pence(public.trips, integer);
DROP FUNCTION IF EXISTS public.resolve_trip_commissionable_fare_pence(public.trips, integer, integer, integer, integer);

GRANT EXECUTE ON FUNCTION public.resolve_trip_locked_promotion_pence(public.trips) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trip_promotion_superseded_by_negotiation(public.trips) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_trip_pre_promotion_ride_fare_pence(public.trips) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_trip_negotiated_commissionable_fare_pence(public.trips, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_trip_commissionable_fare_pence(public.trips, integer, integer, integer) TO authenticated, service_role;
