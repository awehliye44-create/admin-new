-- Ride-offer insert must stamp offered_driver_net_pence as driver net.
-- MK-260815-007: every wave stored offered_driver_net_pence = customer fare (495)
-- while offer_snapshot.driver_net_fare_pence was the net (421). Driver card
-- prefers offered_driver_net_pence → showed the complete fare, ignoring
-- Admin Auto-Dispatch Rules → Driver Fare Display (Net Earnings Only).

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
  v_commission_pct numeric;
  v_airport_pence integer;
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

  v_airport_pence := COALESCE(v_trip.airport_charge_pence, 0);
  IF v_base_pence IS NOT NULL AND v_base_pence > 0 AND NEW.driver_id IS NOT NULL THEN
    v_net_pence := public.compute_driver_net_preview_from_gross(
      v_base_pence,
      NEW.driver_id,
      v_trip.service_area_id,
      v_airport_pence
    );
    v_commission_pct := public.resolve_driver_tier_commission_percent(
      NEW.driver_id,
      v_trip.service_area_id
    );
    IF v_net_pence IS NOT NULL AND v_net_pence > 0 THEN
      v_net_fields := jsonb_build_object(
        'driver_net_fare_pence', v_net_pence,
        'driver_earnings_pence', v_net_pence,
        'driver_net_preview_pence', v_net_pence,
        'final_trip_fare_pence', v_base_pence,
        'trip_fare_pence', v_base_pence,
        'currency', 'gbp',
        'currency_code', 'gbp'
      );
      IF v_commission_pct IS NOT NULL THEN
        v_net_fields := v_net_fields || jsonb_build_object(
          'commission_percent', v_commission_pct,
          'platform_commission_pence', GREATEST(0, v_base_pence - v_net_pence)
        );
      END IF;
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
