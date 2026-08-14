-- Preset Fare Offers: 3-slot SSOT, fixed-pence adjustment, schedule TZ, no auto-accept.
-- Does not delete existing preset_offers rows.

CREATE OR REPLACE FUNCTION public.compute_preset_offer_fare_pence(
  p_base_pence integer,
  p_fixed_amount_pence integer,
  p_multiplier numeric,
  p_price_mode text
) RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_mode text := lower(btrim(COALESCE(p_price_mode, '')));
BEGIN
  IF p_base_pence IS NULL OR p_base_pence <= 0 THEN
    RETURN NULL;
  END IF;

  IF v_mode IN ('fixed', 'fixed_amount') THEN
    IF p_fixed_amount_pence IS NULL THEN
      RETURN NULL;
    END IF;
    RETURN p_base_pence + p_fixed_amount_pence;
  END IF;

  IF v_mode IN ('multiplier', 'percentage', 'percent') THEN
    IF p_multiplier IS NULL THEN
      RETURN NULL;
    END IF;
    RETURN round(p_base_pence::numeric * p_multiplier)::integer;
  END IF;

  IF p_fixed_amount_pence IS NOT NULL THEN
    RETURN p_base_pence + p_fixed_amount_pence;
  END IF;

  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.compute_ride_offer_preset_options(p_trip trips)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_config record;
  v_base_pence integer;
  v_price_mode text;
  v_offer record;
  v_pence integer;
  v_options integer[] := ARRAY[]::integer[];
  v_seen integer[] := ARRAY[]::integer[];
  v_preset_options jsonb := '[]'::jsonb;
  v_configured numeric;
  v_tz text;
  v_local timestamp;
  v_dow integer;
  v_hhmm text;
  v_slot integer := 0;
BEGIN
  IF p_trip.driver_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'driver_assigned');
  END IF;

  IF COALESCE(p_trip.negotiation_disabled, false)
     OR p_trip.negotiation_status = 'failed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'negotiation_disabled');
  END IF;

  -- Audited scheduled-trip SSOT (do not add scheduled_at as a second identifier).
  IF COALESCE(p_trip.is_scheduled, false)
     OR p_trip.dispatch_mode = 'scheduled'
     OR p_trip.trip_type = 'scheduled' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_scheduled');
  END IF;

  IF p_trip.dispatch_mode = 'scan_and_go'
     OR p_trip.pickup_zone_id IS NOT NULL
     OR p_trip.dropoff_zone_id IS NOT NULL
     OR p_trip.corporate_account_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_trip_type');
  END IF;

  IF p_trip.service_area_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_service_area');
  END IF;

  v_base_pence := public.trip_negotiation_base_fare_pence(p_trip);

  IF v_base_pence <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'missing_base_fare', 'base_pence', v_base_pence);
  END IF;

  SELECT *
  INTO v_config
  FROM public.preset_offer_configs
  WHERE service_area_id = p_trip.service_area_id
    AND is_enabled = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_preset_config');
  END IF;

  IF COALESCE(v_config.schedule_enabled, false) THEN
    SELECT COALESCE(NULLIF(btrim(r.timezone), ''), NULLIF(btrim(sa.timezone), ''), 'UTC')
    INTO v_tz
    FROM public.service_areas sa
    LEFT JOIN public.regions r ON r.id = sa.region_id
    WHERE sa.id = p_trip.service_area_id;

    v_tz := COALESCE(v_tz, 'UTC');
    v_local := timezone(v_tz, now());
    v_dow := EXTRACT(ISODOW FROM v_local)::integer;
    v_hhmm := to_char(v_local, 'HH24:MI');

    IF v_config.schedule_days IS NULL
       OR NOT (v_dow = ANY (v_config.schedule_days)) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'outside_schedule', 'base_pence', v_base_pence);
    END IF;

    IF v_hhmm < COALESCE(v_config.schedule_start_time, '00:00')
       OR v_hhmm >= COALESCE(v_config.schedule_end_time, '23:59') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'outside_schedule', 'base_pence', v_base_pence);
    END IF;
  END IF;

  v_price_mode := COALESCE(v_config.price_mode, 'multiplier');

  FOR v_offer IN
    SELECT po.*
    FROM public.preset_offers po
    WHERE po.config_id = v_config.id
    ORDER BY po.display_order NULLS LAST, po.created_at
    LIMIT 3
  LOOP
    v_slot := v_slot + 1;
    IF v_offer.is_active IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'ok', false,
        'reason', 'insufficient_slots',
        'count', v_slot - 1,
        'base_pence', v_base_pence
      );
    END IF;
    v_pence := public.compute_preset_offer_fare_pence(
      v_base_pence,
      v_offer.fixed_amount_pence,
      v_offer.multiplier,
      v_price_mode
    );

    IF v_pence IS NULL OR v_pence <= 0 OR v_pence = ANY (v_seen) THEN
      RETURN jsonb_build_object(
        'ok', false,
        'reason', 'insufficient_slots',
        'count', v_slot - 1,
        'base_pence', v_base_pence
      );
    END IF;

    v_seen := array_append(v_seen, v_pence);
    v_options := array_append(v_options, v_pence);

    IF v_offer.fixed_amount_pence IS NOT NULL THEN
      v_configured := v_offer.fixed_amount_pence::numeric / 100.0;
    ELSIF v_offer.multiplier IS NOT NULL THEN
      v_configured := v_offer.multiplier;
    ELSE
      v_configured := NULL;
    END IF;

    v_preset_options := v_preset_options || jsonb_build_array(
      jsonb_build_object(
        'key', COALESCE(NULLIF(trim(v_offer.offer_key), ''), 'offer_' || v_slot::text),
        'label', v_offer.label,
        'grossFare', round(v_pence::numeric / 100.0, 2),
        'grossFarePence', v_pence,
        'configuredAmount', v_configured,
        'color', v_offer.color,
        'order', v_slot - 1,
        'enabled', true
      )
    );
  END LOOP;

  IF COALESCE(array_length(v_options, 1), 0) <> 3 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'insufficient_slots',
      'count', COALESCE(array_length(v_options, 1), 0),
      'base_pence', v_base_pence
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'base_pence', v_base_pence,
    'preset_options', v_preset_options,
    'offer_options', to_jsonb(v_options),
    'countdown_seconds', CASE
      WHEN COALESCE(v_config.countdown_enabled, false) THEN v_config.countdown_seconds
      ELSE NULL
    END,
    'countdown_auto_select', false
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.commit_dispatch_wave(
  p_trip_id uuid,
  p_expected_version integer,
  p_offers jsonb,
  p_expires_in_seconds integer DEFAULT 20
)
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
  v_max_reduction numeric := 0;
  v_countdown integer;
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
      AND COALESCE(jsonb_array_length(v_preset_result->'preset_options'), 0) = 3;
    v_disabled_reason := COALESCE(v_preset_result->>'reason', 'unavailable');
  EXCEPTION WHEN OTHERS THEN
    v_preset_result := jsonb_build_object('ok', false, 'reason', 'preset_compute_failed');
    v_presets_enabled := false;
    v_disabled_reason := 'preset_compute_failed';
    RAISE LOG '[commit_dispatch_wave] preset compute failed trip_id=% err=%', p_trip_id, SQLERRM;
  END;

  v_countdown := NULLIF((v_preset_result->>'countdown_seconds')::integer, 0);

  v_new_version := v_trip.trip_version + 1;
  v_new_round := COALESCE(v_trip.current_broadcast_round, 0) + 1;
  v_max_reduction := COALESCE(v_trip.max_wave_commission_reduction_percent, 0);

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
      (x->'offer_snapshot')::jsonb AS offer_snapshot,
      NULLIF((x->>'dispatch_wave')::integer, 0) AS dispatch_wave,
      NULLIF((x->>'dispatch_round')::integer, 0) AS dispatch_round,
      NULLIF((x->>'base_commission_percent')::numeric, NULL) AS base_commission_percent,
      NULLIF((x->>'wave_commission_reduction_percent')::numeric, NULL) AS wave_commission_reduction_percent,
      NULLIF((x->>'effective_commission_percent')::numeric, NULL) AS effective_commission_percent,
      NULLIF((x->>'offered_driver_net_pence')::integer, NULL) AS offered_driver_net_pence
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
        v_wave integer;
        v_dround integer;
      BEGIN
        v_insert_offer_options := r.offer_options;
        v_insert_offer_snapshot := COALESCE(r.offer_snapshot, '{}'::jsonb);
        v_wave := COALESCE(
          r.dispatch_wave,
          (((v_new_round - 1) % 3) + 1)
        );
        v_dround := COALESCE(
          r.dispatch_round,
          (FLOOR((v_new_round - 1)::numeric / 3) + 1)::integer
        );

        IF r.wave_commission_reduction_percent IS NOT NULL THEN
          v_max_reduction := GREATEST(v_max_reduction, r.wave_commission_reduction_percent);
        END IF;

        IF r.is_stacked THEN
          v_insert_offer_options := NULL;
          v_insert_offer_snapshot := (v_insert_offer_snapshot - 'preset_options' - 'presetFareOffers') || jsonb_build_object(
            'preset_options', '[]'::jsonb,
            'presets_enabled', false,
            'countdown_auto_select', false,
            'negotiationAllowed', false,
            'negotiationDisabled', true,
            'negotiationLocked', true
          );
        ELSIF v_presets_enabled THEN
          v_insert_offer_options := COALESCE(
            CASE
              WHEN v_insert_offer_options IS NOT NULL
               AND jsonb_typeof(v_insert_offer_options) = 'array'
               AND COALESCE(jsonb_array_length(v_insert_offer_options), 0) = 3
              THEN v_insert_offer_options
              ELSE v_preset_result->'offer_options'
            END,
            v_preset_result->'offer_options'
          );

          v_insert_offer_snapshot := v_insert_offer_snapshot || jsonb_build_object(
            'baseFarePence', (v_preset_result->>'base_pence')::integer,
            'preset_options', v_preset_result->'preset_options',
            'presets_enabled', true,
            'countdown_auto_select', false,
            'countdown_seconds', v_countdown,
            'presetCountdownSeconds', v_countdown,
            'negotiationAllowed', true
          );
        ELSIF COALESCE(v_base_pence, 0) > 0 THEN
          v_insert_offer_options := NULL;
          v_insert_offer_snapshot := (v_insert_offer_snapshot - 'preset_options' - 'presetFareOffers') || jsonb_build_object(
            'baseFarePence', v_base_pence,
            'preset_options', '[]'::jsonb,
            'presets_enabled', false,
            'countdown_auto_select', false,
            'preset_disabled_reason', v_disabled_reason
          );
        END IF;

        INSERT INTO public.ride_offers (
          trip_id,
          driver_id,
          is_stacked,
          expires_at,
          broadcast_round,
          dispatch_wave,
          dispatch_round,
          base_commission_percent,
          wave_commission_reduction_percent,
          effective_commission_percent,
          offered_driver_net_pence,
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
          v_wave,
          v_dround,
          r.base_commission_percent,
          r.wave_commission_reduction_percent,
          r.effective_commission_percent,
          r.offered_driver_net_pence,
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
          'presets_enabled', COALESCE((v_insert_offer_snapshot->>'presets_enabled')::boolean, false),
          'effective_commission_percent', r.effective_commission_percent,
          'offered_driver_net_pence', r.offered_driver_net_pence
        );
      END;
    END IF;
  END LOOP;

  UPDATE public.trips
  SET
    max_wave_commission_reduction_percent = GREATEST(
      COALESCE(max_wave_commission_reduction_percent, 0),
      v_max_reduction
    ),
    updated_at = v_now
  WHERE id = p_trip_id;

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
  v_countdown integer;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'trip_not_found');
  END IF;

  v_result := public.compute_ride_offer_preset_options(v_trip);

  IF COALESCE((v_result->>'ok')::boolean, false) IS TRUE
     AND jsonb_typeof(v_result->'preset_options') = 'array'
     AND COALESCE(jsonb_array_length(v_result->'preset_options'), 0) = 3 THEN
    v_base_pence := (v_result->>'base_pence')::int;
    v_preset_options := v_result->'preset_options';
    v_options := v_result->'offer_options';
    v_countdown := NULLIF((v_result->>'countdown_seconds')::integer, 0);
    v_snapshot := jsonb_build_object(
      'baseFarePence', v_base_pence,
      'preset_options', v_preset_options,
      'presets_enabled', true,
      'countdown_auto_select', false,
      'countdown_seconds', v_countdown,
      'presetCountdownSeconds', v_countdown,
      'negotiationAllowed', true
    );

    UPDATE public.ride_offers ro
    SET offer_options = v_options,
        offer_snapshot = COALESCE(ro.offer_snapshot,'{}'::jsonb) || v_snapshot
    WHERE ro.trip_id = p_trip_id
      AND ro.status = 'pending'
      AND ro.expires_at > now()
      AND COALESCE(ro.is_stacked, false) = false;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN jsonb_build_object('ok', true, 'trip_id', p_trip_id, 'offers_updated', v_updated,
                              'base_pence', v_base_pence, 'presets_enabled', true);
  END IF;

  v_reason := COALESCE(v_result->>'reason', 'unavailable');
  v_base_pence := public.trip_negotiation_base_fare_pence(v_trip);

  IF v_base_pence > 0 THEN
    v_snapshot := jsonb_build_object(
      'baseFarePence', v_base_pence,
      'preset_options', '[]'::jsonb,
      'presets_enabled', false,
      'countdown_auto_select', false,
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
