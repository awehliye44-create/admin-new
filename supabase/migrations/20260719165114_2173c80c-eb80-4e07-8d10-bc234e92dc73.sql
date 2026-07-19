
-- 1) Convert column type from int4[] to jsonb
ALTER TABLE public.ride_offers
  ALTER COLUMN offer_options TYPE jsonb
  USING CASE WHEN offer_options IS NULL THEN NULL ELSE to_jsonb(offer_options) END;

-- 2) Update driver_send_preset_offer to write jsonb
CREATE OR REPLACE FUNCTION public.driver_send_preset_offer(
  p_offer_id uuid,
  p_driver_offer_fare_pence integer,
  p_offer_options integer[] DEFAULT NULL::integer[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_offer public.ride_offers%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_negotiation_expires_at timestamptz;
  v_now timestamptz := now();
BEGIN
  IF p_driver_offer_fare_pence IS NULL OR p_driver_offer_fare_pence <= 0 THEN
    RAISE EXCEPTION 'invalid_fare';
  END IF;

  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found'; END IF;

  IF v_offer.status NOT IN ('pending','countered') THEN
    RAISE EXCEPTION 'offer_not_pending';
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'trip_not_found'; END IF;

  IF COALESCE(v_trip.negotiation_disabled,false)
     OR COALESCE(v_trip.negotiation_allowed,true) = false THEN
    RAISE EXCEPTION 'negotiation_disabled';
  END IF;

  IF v_trip.driver_id IS NOT NULL AND v_trip.status IN (
    'confirmed','accepted','driver_assigned','en_route','en_route_to_pickup',
    'driver_en_route','arrived','arrived_pickup','in_progress'
  ) THEN
    RAISE EXCEPTION 'trip_already_assigned';
  END IF;

  v_negotiation_expires_at := v_now + interval '25 seconds';

  UPDATE public.ride_offers
  SET driver_offer_fare = p_driver_offer_fare_pence,
      offer_options = COALESCE(
        CASE WHEN p_offer_options IS NULL THEN NULL ELSE to_jsonb(p_offer_options) END,
        offer_options
      ),
      negotiation_status = 'waiting_customer',
      customer_respond_by = v_negotiation_expires_at,
      driver_respond_by = NULL,
      customer_counter_fare = NULL,
      status = 'countered',
      delivery_phase = 'negotiation',
      negotiation_expires_at = v_negotiation_expires_at,
      expires_at = v_negotiation_expires_at,
      updated_at = v_now
  WHERE id = p_offer_id;

  UPDATE public.trips
  SET status = 'negotiating',
      negotiation_owner_driver_id = v_offer.driver_id,
      current_offer_driver_id = v_offer.driver_id,
      current_negotiation_id = p_offer_id,
      negotiation_locked_until = v_negotiation_expires_at,
      dispatch_status = 'paused',
      broadcast_enabled = false,
      updated_at = v_now
  WHERE id = v_offer.trip_id;

  UPDATE public.ride_offers
  SET status = 'revoked',
      revoked_reason = 'negotiation_locked',
      negotiation_status = NULL,
      updated_at = v_now
  WHERE trip_id = v_offer.trip_id
    AND id <> p_offer_id
    AND status = 'pending'
    AND negotiation_status IS NULL
    AND COALESCE(driver_offer_fare,0) = 0;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', v_offer.trip_id,
    'offer_id', p_offer_id,
    'status', 'negotiating',
    'customer_respond_by', v_negotiation_expires_at,
    'negotiation_expires_at', v_negotiation_expires_at
  );
END;
$function$;

-- 3) Update enrich_ride_offer_presets to write jsonb
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
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'trip_not_found');
  END IF;

  v_result := public.compute_ride_offer_preset_options(v_trip);

  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE THEN
    IF v_result->>'reason' = 'negotiation_disabled' THEN
      UPDATE public.ride_offers ro
      SET offer_options = NULL,
          offer_snapshot = COALESCE(ro.offer_snapshot,'{}'::jsonb) - 'preset_options' - 'presetFareOffers'
      WHERE ro.trip_id = p_trip_id AND ro.status = 'pending';
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      RETURN jsonb_build_object('ok', false, 'reason', 'negotiation_disabled', 'offers_cleared', v_updated);
    END IF;
    RETURN v_result;
  END IF;

  v_base_pence := (v_result->>'base_pence')::int;
  v_preset_options := v_result->'preset_options';
  v_options := v_result->'offer_options';

  v_snapshot := jsonb_build_object(
    'baseFarePence', v_base_pence,
    'preset_options', v_preset_options
  );

  UPDATE public.ride_offers ro
  SET offer_options = v_options,
      offer_snapshot = COALESCE(ro.offer_snapshot,'{}'::jsonb) || v_snapshot
  WHERE ro.trip_id = p_trip_id
    AND ro.status = 'pending'
    AND ro.expires_at > now()
    AND (
      ro.offer_options IS NULL
      OR jsonb_typeof(ro.offer_options) <> 'array'
      OR COALESCE(jsonb_array_length(ro.offer_options), 0) < 3
      OR NOT (COALESCE(ro.offer_snapshot,'{}'::jsonb) ? 'preset_options')
      OR COALESCE((ro.offer_snapshot->>'baseFarePence')::int, 0) IS DISTINCT FROM v_base_pence
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok', true,
    'trip_id', p_trip_id,
    'offer_options', v_options,
    'preset_options', v_preset_options,
    'offers_updated', v_updated,
    'base_pence', v_base_pence
  );
END;
$function$;

-- 4) Update tr_stamp_offer_presets_fn trigger to write jsonb
CREATE OR REPLACE FUNCTION public.tr_stamp_offer_presets_fn()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips;
  v_result jsonb;
BEGIN
  IF NEW.status IS DISTINCT FROM 'pending' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.is_stacked, false) THEN RETURN NEW; END IF;

  IF jsonb_typeof(COALESCE(NEW.offer_snapshot,'{}'::jsonb) -> 'preset_options') = 'array'
     AND jsonb_array_length(COALESCE(NEW.offer_snapshot,'{}'::jsonb) -> 'preset_options') >= 3 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = NEW.trip_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  BEGIN
    v_result := public.compute_ride_offer_preset_options(v_trip);
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[tr_stamp_offer_presets] compute failed trip_id=% offer_id=% err=%',
      NEW.trip_id, NEW.id, SQLERRM;
    RETURN NEW;
  END;

  IF COALESCE((v_result->>'ok')::boolean, false) IS NOT TRUE THEN RETURN NEW; END IF;
  IF jsonb_array_length(v_result->'preset_options') < 3 THEN RETURN NEW; END IF;

  NEW.offer_snapshot := COALESCE(NEW.offer_snapshot,'{}'::jsonb)
    || jsonb_build_object(
      'baseFarePence', (v_result->>'base_pence')::int,
      'preset_options', v_result->'preset_options'
    );

  IF NEW.offer_options IS NULL
     OR jsonb_typeof(NEW.offer_options) <> 'array'
     OR COALESCE(jsonb_array_length(NEW.offer_options), 0) < 3 THEN
    NEW.offer_options := v_result->'offer_options';
  END IF;

  RETURN NEW;
END;
$function$;
