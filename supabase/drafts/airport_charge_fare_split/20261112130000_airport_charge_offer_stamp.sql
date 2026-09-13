-- DRAFT ONLY. Do not copy into supabase/migrations. Do not db push. Do not apply.
-- Airport charge is customer-payable pass-through. Offer stamp must subtract it
-- before commission and add it back after. Rate stays resolve_wave_commission_percent.
--
-- Before: v_airport := trips.airport_charge_pence (0 at stamp time) so
--   commissionable = folded payable, net = payable - round(payable * rate).
-- After: airport from column, else quote JSON; 
--   commissionable = base - airport - other_non_commissionable
--   net = commissionable - commission + airport + other
-- Snapshot also stores airport_charge_pence and route_extra_items.
-- Preset chips stay customer totals; their driver nets exclude airport from commission.

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
  v_other_pence integer;
  v_commissionable integer;
  v_commission_pence integer;
  v_display_commission integer;
  v_wave integer;
  v_base_pct numeric;
  v_reduction_pct numeric;
  v_effective_pct numeric;
  v_net_fields jsonb := '{}'::jsonb;
  v_airport_fields jsonb := '{}'::jsonb;
  v_raw numeric;
  v_annotated jsonb;
  v_item jsonb;
  v_gross integer;
  v_item_commissionable integer;
  v_item_commission integer;
  v_item_net integer;
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

  -- Admin per-wave table only. Pass floor 0 so W1 cannot pin later waves.
  SELECT wc.base_percent, wc.reduction_percent, wc.effective_percent
    INTO v_base_pct, v_reduction_pct, v_effective_pct
  FROM public.resolve_wave_commission_percent(v_wave, 0) AS wc;

  NEW.dispatch_wave := v_wave;
  NEW.base_commission_percent := v_base_pct;
  NEW.wave_commission_reduction_percent := v_reduction_pct;
  NEW.effective_commission_percent := v_effective_pct;

  v_airport_pence := COALESCE(v_trip.airport_charge_pence, 0);
  IF v_airport_pence <= 0 AND v_trip.fare_breakdown IS NOT NULL THEN
    v_raw := NULLIF(v_trip.fare_breakdown->>'airport_charge_pence', '')::numeric;
    IF v_raw IS NULL OR v_raw <= 0 THEN
      v_raw := COALESCE(
        NULLIF(v_trip.fare_breakdown->>'airportCharge', '')::numeric,
        NULLIF(v_trip.fare_breakdown->>'airport_charge', '')::numeric,
        0
      );
      -- Quote JSON stores airportCharge in major units (pounds). Always convert.
      -- Do not treat a value >= 100 as already pence (£100 would become £1).
      IF v_raw > 0 THEN
        v_raw := round(v_raw * 100);
      END IF;
    END IF;
    v_airport_pence := GREATEST(0, round(COALESCE(v_raw, 0)));
  END IF;

  v_other_pence := GREATEST(0, COALESCE(v_trip.other_pass_through_charges_pence, 0));

  IF v_base_pence IS NOT NULL AND v_base_pence > 0 THEN
    v_commissionable := GREATEST(0, v_base_pence - v_airport_pence - v_other_pence);
    v_commission_pence := ROUND((v_commissionable::numeric * COALESCE(v_effective_pct, 0)) / 100.0);
    v_net_pence := GREATEST(0, v_commissionable - v_commission_pence) + v_airport_pence + v_other_pence;
    v_display_net := v_net_pence;
    IF v_net_pence = v_base_pence AND COALESCE(v_base_pct, 0) > 0 THEN
      v_display_commission := ROUND((v_commissionable::numeric * v_base_pct) / 100.0);
      v_display_net := GREATEST(0, v_commissionable - v_display_commission) + v_airport_pence + v_other_pence;
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

  IF v_airport_pence > 0 THEN
    v_airport_fields := jsonb_build_object(
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
      v_annotated := '[]'::jsonb;
      FOR v_item IN SELECT value FROM jsonb_array_elements(v_result->'preset_options')
      LOOP
        v_gross := COALESCE((v_item->>'grossFarePence')::int, 0);
        IF v_gross > 0 THEN
          v_item_commissionable := GREATEST(0, v_gross - v_airport_pence - v_other_pence);
          v_item_commission := ROUND((v_item_commissionable::numeric * COALESCE(v_effective_pct, 0)) / 100.0);
          v_item_net := GREATEST(0, v_item_commissionable - v_item_commission) + v_airport_pence + v_other_pence;
          v_item := v_item || jsonb_build_object(
            'driverNetPence', v_item_net,
            'driver_net_pence', v_item_net
          );
        END IF;
        v_annotated := v_annotated || jsonb_build_array(v_item);
      END LOOP;
      v_result := jsonb_set(v_result, '{preset_options}', v_annotated);
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
