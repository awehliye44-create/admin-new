CREATE OR REPLACE FUNCTION public.commit_dispatch_wave(p_trip_id uuid, p_expected_version integer, p_offers jsonb, p_expires_in_seconds integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_now timestamptz := now();
  v_new_version integer;
  v_new_round integer;
  v_inserted_offers jsonb := '[]'::jsonb;
  v_base_pence integer;
  v_preset_result jsonb;
  v_presets_enabled boolean := false;
  v_disabled_reason text := 'unavailable';
  r RECORD;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  IF v_trip.trip_version != p_expected_version THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'VERSION_MISMATCH',
      'current_version', v_trip.trip_version,
      'expected_version', p_expected_version
    );
  END IF;

  IF v_trip.status NOT IN ('pending', 'searching', 'offered', 'searching_new_driver') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INVALID_TRIP_STATE',
      'current_status', v_trip.status
    );
  END IF;

  v_base_pence := public.trip_negotiation_base_fare_pence(v_trip);

  BEGIN
    v_preset_result := public.compute_ride_offer_preset_options(v_trip);
    v_presets_enabled := COALESCE((v_preset_result->>'ok')::boolean, false)
      AND jsonb_typeof(v_preset_result->'preset_options') = 'array'
      AND COALESCE(jsonb_array_length(v_preset_result->'preset_options'), 0) >= 3;
    v_disabled_reason := COALESCE(v_preset_result->>'reason', 'unavailable');
  EXCEPTION WHEN OTHERS THEN
    v_preset_result := jsonb_build_object('ok', false, 'reason', 'preset_compute_failed');
    v_presets_enabled := false;
    v_disabled_reason := 'preset_compute_failed';
    RAISE LOG '[commit_dispatch_wave] preset compute failed trip_id=% err=%', p_trip_id, SQLERRM;
  END;

  v_new_version := v_trip.trip_version + 1;
  v_new_round := COALESCE(v_trip.current_broadcast_round, 0) + 1;

  UPDATE public.trips
  SET
    status = 'offered',
    dispatch_status = 'broadcasting',
    current_broadcast_round = v_new_round,
    trip_version = v_new_version,
    updated_at = v_now
  WHERE id = p_trip_id;

  FOR r IN
    SELECT
      (x->>'driver_id')::uuid AS driver_id,
      coalesce((x->>'is_stacked')::boolean, false) AS is_stacked,
      coalesce((x->>'expires_at')::timestamptz, v_now + (p_expires_in_seconds || ' seconds')::interval) AS expires_at,
      (x->>'distance_meters')::integer AS distance_meters,
      (x->'offer_options')::jsonb AS offer_options,
      (x->'offer_snapshot')::jsonb AS offer_snapshot
    FROM jsonb_array_elements(p_offers) AS x
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.drivers
      WHERE id = r.driver_id
        AND driver_status = 'active'
        AND approval_status = 'approved'
        AND documents_approved = true
        AND (current_trip_id IS NULL OR r.is_stacked = true)
    ) THEN
      DECLARE
        v_offer_id uuid;
        v_insert_offer_options jsonb;
        v_insert_offer_snapshot jsonb;
      BEGIN
        v_insert_offer_options := r.offer_options;
        v_insert_offer_snapshot := COALESCE(r.offer_snapshot, '{}'::jsonb);

        IF v_presets_enabled THEN
          v_insert_offer_options := COALESCE(
            CASE
              WHEN v_insert_offer_options IS NOT NULL
               AND jsonb_typeof(v_insert_offer_options) = 'array'
               AND COALESCE(jsonb_array_length(v_insert_offer_options), 0) >= 3
              THEN v_insert_offer_options
              ELSE v_preset_result->'offer_options'
            END,
            v_preset_result->'offer_options'
          );

          v_insert_offer_snapshot := v_insert_offer_snapshot || jsonb_build_object(
            'baseFarePence', (v_preset_result->>'base_pence')::integer,
            'preset_options', v_preset_result->'preset_options',
            'presets_enabled', true
          );
        ELSIF COALESCE(v_base_pence, 0) > 0 THEN
          v_insert_offer_options := NULL;
          v_insert_offer_snapshot := (v_insert_offer_snapshot - 'preset_options' - 'presetFareOffers') || jsonb_build_object(
            'baseFarePence', v_base_pence,
            'preset_options', '[]'::jsonb,
            'presets_enabled', false,
            'preset_disabled_reason', v_disabled_reason
          );
        END IF;

        INSERT INTO public.ride_offers (
          trip_id,
          driver_id,
          is_stacked,
          expires_at,
          broadcast_round,
          status,
          distance_meters,
          offer_options,
          offer_snapshot,
          created_at,
          updated_at
        ) VALUES (
          p_trip_id,
          r.driver_id,
          r.is_stacked,
          r.expires_at,
          v_new_round,
          'pending',
          r.distance_meters,
          v_insert_offer_options,
          v_insert_offer_snapshot,
          v_now,
          v_now
        )
        RETURNING id INTO v_offer_id;

        INSERT INTO public.dispatch_jobs (
          offer_id,
          driver_id,
          trip_id,
          status,
          run_at,
          payload
        ) VALUES (
          v_offer_id,
          r.driver_id,
          p_trip_id,
          'pending',
          v_now + interval '4 seconds',
          jsonb_build_object('reminder_index', 1, 'platform_type', 'combined')
        );

        v_inserted_offers := v_inserted_offers || jsonb_build_object(
          'offer_id', v_offer_id,
          'driver_id', r.driver_id,
          'baseFarePence', COALESCE((v_insert_offer_snapshot->>'baseFarePence')::integer, null),
          'presets_enabled', COALESCE((v_insert_offer_snapshot->>'presets_enabled')::boolean, false)
        );
      END;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'new_version', v_new_version,
    'new_round', v_new_round,
    'inserted_offers', v_inserted_offers,
    'base_pence', v_base_pence,
    'presets_enabled', v_presets_enabled,
    'preset_reason', CASE WHEN v_presets_enabled THEN null ELSE v_disabled_reason END
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

  v_base_pence := public.trip_negotiation_base_fare_pence(v_trip);
  IF v_base_pence > 0 THEN
    NEW.offer_options := NULL;
    NEW.offer_snapshot := (COALESCE(NEW.offer_snapshot,'{}'::jsonb) - 'preset_options' - 'presetFareOffers')
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

UPDATE public.ride_offers ro
SET offer_options = NULL,
    offer_snapshot = (COALESCE(ro.offer_snapshot,'{}'::jsonb) - 'preset_options' - 'presetFareOffers')
      || jsonb_build_object(
        'baseFarePence', public.trip_negotiation_base_fare_pence(t),
        'preset_options', '[]'::jsonb,
        'presets_enabled', false,
        'preset_disabled_reason', 'backfilled_presets_disabled'
      ),
    updated_at = now()
FROM public.trips t
WHERE t.id = ro.trip_id
  AND ro.status = 'pending'
  AND COALESCE(public.trip_negotiation_base_fare_pence(t), 0) > 0
  AND (
    NOT (COALESCE(ro.offer_snapshot,'{}'::jsonb) ? 'baseFarePence')
    OR ro.offer_snapshot->>'presets_enabled' IS DISTINCT FROM 'false'
  );