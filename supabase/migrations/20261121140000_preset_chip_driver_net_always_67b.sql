-- #67B: Always project authoritative driverNetPence onto preset_options.
-- Previously offer_annotate_preset_nets ran only when airport_charge_state = 'present',
-- so non-airport offers shipped gross-only chips and the Driver app painted customer payable.

CREATE OR REPLACE FUNCTION public.enrich_ride_offer_presets(p_trip_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips;
  v_result jsonb;
  v_base_pence integer;
  v_options jsonb;
  v_preset_options jsonb;
  v_snapshot jsonb;
  v_updated integer := 0;
  v_stacked_locked integer := 0;
  v_reason text;
  v_countdown integer;
  v_airport integer := 0;
  v_other integer := 0;
  v_stacked_lock jsonb := jsonb_build_object(
    'preset_options', '[]'::jsonb,
    'presets_enabled', false,
    'negotiationAllowed', false,
    'negotiation_eligible', false,
    'countdown_auto_select', false,
    'negotiationLocked', true,
    'negotiationDisabled', true
  );
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'trip_not_found');
  END IF;

  v_result := public.compute_ride_offer_preset_options(v_trip);
  v_airport := GREATEST(0, COALESCE(v_trip.airport_charge_pence, 0));
  v_other := GREATEST(
    0,
    COALESCE(
      NULLIF((v_trip.fare_snapshot_json ->> 'other_pass_through_charges_pence')::integer, NULL),
      0
    )
  );

  IF COALESCE((v_result->>'ok')::boolean, false) IS TRUE
     AND jsonb_typeof(v_result->'preset_options') = 'array'
     AND COALESCE(jsonb_array_length(v_result->'preset_options'), 0) = 3 THEN
    v_base_pence := (v_result->>'base_pence')::int;
    v_preset_options := v_result->'preset_options';
    v_options := v_result->'offer_options';
    v_countdown := NULLIF((v_result->>'countdown_seconds')::integer, 0);

    UPDATE public.ride_offers ro
    SET offer_options = v_options,
        offer_snapshot = COALESCE(ro.offer_snapshot,'{}'::jsonb) || jsonb_build_object(
          'baseFarePence', v_base_pence,
          'preset_options', public.offer_annotate_preset_nets(
            v_preset_options,
            v_airport,
            v_other,
            COALESCE(
              ro.effective_commission_percent,
              NULLIF((ro.offer_snapshot ->> 'effective_commission_percent')::numeric, NULL),
              NULLIF((ro.offer_snapshot ->> 'commission_percent')::numeric, NULL),
              0
            )
          ),
          'presets_enabled', true,
          'countdown_auto_select', false,
          'countdown_seconds', v_countdown,
          'presetCountdownSeconds', v_countdown,
          'negotiationAllowed', true,
          'negotiation_eligible', true
        )
    WHERE ro.trip_id = p_trip_id
      AND ro.status = 'pending'
      AND ro.expires_at > now()
      AND COALESCE(ro.is_stacked, false) = false;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
  ELSE
    v_reason := COALESCE(v_result->>'reason', 'unavailable');
    v_base_pence := public.trip_negotiation_base_fare_pence(v_trip);

    IF v_base_pence > 0 THEN
      v_snapshot := jsonb_build_object(
        'baseFarePence', v_base_pence,
        'preset_options', '[]'::jsonb,
        'presets_enabled', false,
        'countdown_auto_select', false,
        'negotiationAllowed', false,
        'negotiation_eligible', false,
        'preset_disabled_reason', v_reason
      );
      UPDATE public.ride_offers ro
      SET offer_snapshot = (COALESCE(ro.offer_snapshot,'{}'::jsonb) - 'preset_options' - 'presetFareOffers') || v_snapshot
      WHERE ro.trip_id = p_trip_id
        AND ro.status = 'pending'
        AND COALESCE(ro.is_stacked, false) = false;
      GET DIAGNOSTICS v_updated = ROW_COUNT;
    END IF;
  END IF;

  UPDATE public.ride_offers ro
  SET offer_options = NULL,
      offer_snapshot = (
        (COALESCE(ro.offer_snapshot, '{}'::jsonb)
          - 'preset_options'
          - 'presetFareOffers'
          - 'countdown_seconds'
          - 'presetCountdownSeconds'
          - 'default_selected_offer_id'
          - 'negotiationExpiresAt')
        || v_stacked_lock
        || jsonb_build_object(
          'fareSource',
          COALESCE(NULLIF(ro.offer_snapshot->>'fareSource', ''), 'stacked_ride')
        )
      )
  WHERE ro.trip_id = p_trip_id
    AND ro.status = 'pending'
    AND COALESCE(ro.is_stacked, false) = true;
  GET DIAGNOSTICS v_stacked_locked = ROW_COUNT;

  IF COALESCE((v_result->>'ok')::boolean, false) IS TRUE THEN
    RETURN jsonb_build_object(
      'ok', true,
      'trip_id', p_trip_id,
      'offers_updated', v_updated,
      'stacked_locked', v_stacked_locked,
      'base_pence', v_base_pence,
      'presets_enabled', true
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', false,
    'reason', COALESCE(v_reason, v_result->>'reason', 'unavailable'),
    'offers_updated', v_updated,
    'stacked_locked', v_stacked_locked,
    'base_pence', v_base_pence,
    'presets_enabled', false
  );
END;
$function$;

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
    v_split := public.offer_driver_net_split_for_trip(
      v_trip, v_base_pence, v_airport_pence, v_other_pence, v_effective_pct, v_base_pct
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
        'platform_commission_pence', CASE WHEN COALESCE((v_split->>'locked_promotion_pence')::int, 0) > 0 THEN (v_split->>'commission_pence')::int ELSE GREATEST(0, v_base_pence - v_net_pence) END
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
  ELSIF v_airport_state = 'zero' THEN
    v_airport_fields := v_airport_fields || jsonb_build_object('airport_charge_pence', 0);
  END IF;

  -- #67B: always annotate chip nets (airport may be 0 / unknown).
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

    v_split := public.offer_driver_net_split_for_trip(
      v_trip, v_base, v_airport, v_other,
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
      'platform_commission_pence', CASE WHEN COALESCE((v_split->>'locked_promotion_pence')::int, 0) > 0 THEN (v_split->>'commission_pence')::int ELSE GREATEST(0, v_base - v_net) END,
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

    -- #67B: always annotate chip nets (airport may be 0 / unknown).
    IF jsonb_typeof(v_next -> 'preset_options') = 'array' THEN
      v_next := jsonb_set(
        v_next,
        '{preset_options}',
        public.offer_annotate_preset_nets(
          v_next -> 'preset_options', COALESCE((v_split->>'airport_pence')::int, 0),
          COALESCE((v_split->>'other_pass_through_pence')::int, 0), v_offer.effective_commission_percent
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
