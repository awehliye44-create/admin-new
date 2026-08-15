-- Net Earnings Only: when wave net equals the customer fare (W1 0%
-- commission), stamp snapshot display net from base commission so the
-- Driver card does not paint the complete fare. Settlement offered net
-- stays the wave amount. Do not rewrite historical offer rows.

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
  v_airport_pence integer;
  v_commissionable integer;
  v_commission_pence integer;
  v_display_commission integer;
  v_wave integer;
  v_base_pct numeric;
  v_reduction_pct numeric;
  v_effective_pct numeric;
  v_net_fields jsonb := '{}'::jsonb;
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

  -- Admin per-wave table only. Pass floor 0 so W1 15pp cannot pin W2/W3.
  SELECT wc.base_percent, wc.reduction_percent, wc.effective_percent
    INTO v_base_pct, v_reduction_pct, v_effective_pct
  FROM public.resolve_wave_commission_percent(v_wave, 0) AS wc;

  NEW.dispatch_wave := v_wave;
  NEW.base_commission_percent := v_base_pct;
  NEW.wave_commission_reduction_percent := v_reduction_pct;
  NEW.effective_commission_percent := v_effective_pct;

  v_airport_pence := COALESCE(v_trip.airport_charge_pence, 0);
  IF v_base_pence IS NOT NULL AND v_base_pence > 0 THEN
    -- Same split as calculateCommissionSplit (airport not commissionable).
    v_commissionable := GREATEST(0, v_base_pence - v_airport_pence);
    v_commission_pence := ROUND((v_commissionable::numeric * COALESCE(v_effective_pct, 0)) / 100.0);
    v_net_pence := GREATEST(0, v_commissionable - v_commission_pence) + v_airport_pence;
    v_display_net := v_net_pence;
    -- Wave net == customer fare looks like complete-fare mode. Display uses
    -- base commission so Net Earnings Only still shows an earning.
    IF v_net_pence = v_base_pence AND COALESCE(v_base_pct, 0) > 0 THEN
      v_display_commission := ROUND((v_commissionable::numeric * v_base_pct) / 100.0);
      v_display_net := GREATEST(0, v_commissionable - v_display_commission) + v_airport_pence;
    END IF;
    IF v_net_pence IS NOT NULL AND v_net_pence > 0 THEN
      v_net_fields := jsonb_build_object(
        'driver_net_fare_pence', v_display_net,
        'driver_earnings_pence', v_display_net,
        'driver_net_preview_pence', v_display_net,
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

  IF COALESCE((v_result->>'ok')::boolean, false) IS TRUE
     AND jsonb_typeof(v_result->'preset_options') = 'array'
     AND jsonb_array_length(v_result->'preset_options') >= 3 THEN
    NEW.offer_snapshot := COALESCE(NEW.offer_snapshot,'{}'::jsonb)
      || jsonb_build_object(
        'baseFarePence', v_base_pence,
        'preset_options', v_result->'preset_options',
        'presets_enabled', true
      )
      || v_net_fields;
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
      || v_net_fields;
  END IF;

  RETURN NEW;
END;
$function$;
