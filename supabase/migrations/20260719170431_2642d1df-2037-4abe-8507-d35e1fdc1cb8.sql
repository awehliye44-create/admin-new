-- Stamp baseFarePence even when presets are disabled so the driver offer card renders
CREATE OR REPLACE FUNCTION public.tr_stamp_offer_presets_fn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips;
  v_result jsonb;
  v_base_pence integer;
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
    RETURN NEW;
  END;

  -- Happy path: presets enabled with >= 3 options
  IF COALESCE((v_result->>'ok')::boolean, false) IS TRUE
     AND jsonb_array_length(v_result->'preset_options') >= 3 THEN
    NEW.offer_snapshot := COALESCE(NEW.offer_snapshot,'{}'::jsonb)
      || jsonb_build_object(
        'baseFarePence', (v_result->>'base_pence')::int,
        'preset_options', v_result->'preset_options',
        'presets_enabled', true
      );
    IF NEW.offer_options IS NULL
       OR jsonb_typeof(NEW.offer_options) <> 'array'
       OR COALESCE(jsonb_array_length(NEW.offer_options), 0) < 3 THEN
      NEW.offer_options := v_result->'offer_options';
    END IF;
    RETURN NEW;
  END IF;

  -- Fallback: presets disabled / unavailable — still stamp base fare so card can render
  v_base_pence := public.trip_negotiation_base_fare_pence(v_trip);
  IF v_base_pence > 0 THEN
    NEW.offer_snapshot := COALESCE(NEW.offer_snapshot,'{}'::jsonb)
      || jsonb_build_object(
        'baseFarePence', v_base_pence,
        'preset_options', '[]'::jsonb,
        'presets_enabled', false,
        'preset_disabled_reason', COALESCE(v_result->>'reason', 'unavailable')
      );
  END IF;

  RETURN NEW;
END;
$function$;

-- Same fallback for enrich_ride_offer_presets (used by dispatch after insert)
CREATE OR REPLACE FUNCTION public.enrich_ride_offer_presets(p_trip_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips;
  v_result jsonb;
  v_base_pence integer;
  v_options jsonb;
  v_preset_options jsonb;
  v_snapshot jsonb;
  v_updated integer := 0;
  v_reason text;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'trip_not_found');
  END IF;

  v_result := public.compute_ride_offer_preset_options(v_trip);

  IF COALESCE((v_result->>'ok')::boolean, false) IS TRUE THEN
    v_base_pence := (v_result->>'base_pence')::int;
    v_preset_options := v_result->'preset_options';
    v_options := v_result->'offer_options';
    v_snapshot := jsonb_build_object(
      'baseFarePence', v_base_pence,
      'preset_options', v_preset_options,
      'presets_enabled', true
    );

    UPDATE public.ride_offers ro
    SET offer_options = v_options,
        offer_snapshot = COALESCE(ro.offer_snapshot,'{}'::jsonb) || v_snapshot
    WHERE ro.trip_id = p_trip_id
      AND ro.status = 'pending'
      AND ro.expires_at > now();

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN jsonb_build_object('ok', true, 'trip_id', p_trip_id, 'offers_updated', v_updated,
                              'base_pence', v_base_pence, 'presets_enabled', true);
  END IF;

  -- Presets unavailable — stamp base-fare-only snapshot so card renders
  v_reason := COALESCE(v_result->>'reason', 'unavailable');
  v_base_pence := public.trip_negotiation_base_fare_pence(v_trip);

  IF v_base_pence > 0 THEN
    v_snapshot := jsonb_build_object(
      'baseFarePence', v_base_pence,
      'preset_options', '[]'::jsonb,
      'presets_enabled', false,
      'preset_disabled_reason', v_reason
    );
    UPDATE public.ride_offers ro
    SET offer_snapshot = (COALESCE(ro.offer_snapshot,'{}'::jsonb) - 'preset_options' - 'presetFareOffers') || v_snapshot
    WHERE ro.trip_id = p_trip_id AND ro.status = 'pending';
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('ok', false, 'reason', v_reason, 'offers_updated', v_updated,
                            'base_pence', v_base_pence, 'presets_enabled', false);
END;
$function$;

-- Backfill any existing pending offers so their cards render immediately
UPDATE public.ride_offers ro
SET offer_snapshot = COALESCE(ro.offer_snapshot,'{}'::jsonb)
  || jsonb_build_object(
    'baseFarePence', public.trip_negotiation_base_fare_pence(t),
    'preset_options', '[]'::jsonb,
    'presets_enabled', false,
    'preset_disabled_reason', 'no_preset_config'
  )
FROM public.trips t
WHERE ro.trip_id = t.id
  AND ro.status = 'pending'
  AND ro.expires_at > now()
  AND public.trip_negotiation_base_fare_pence(t) > 0
  AND NOT (COALESCE(ro.offer_snapshot,'{}'::jsonb) ? 'baseFarePence');