-- Dispatch rounds = full W1→W2→W3 cycles; expire-offers Edge reconnect; offer commission columns.

-- 1) Max sequences = max_dispatch_rounds × 3 (or stamped trips.max_broadcast_rounds)
CREATE OR REPLACE FUNCTION public.dispatch_max_broadcast_rounds(
  p_settings jsonb,
  p_trip_max integer DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_cycles integer;
BEGIN
  IF p_trip_max IS NOT NULL AND p_trip_max > 0 THEN
    RETURN p_trip_max;
  END IF;

  v_cycles := GREATEST(
    1,
    COALESCE(
      NULLIF((p_settings->>'max_dispatch_rounds')::integer, 0),
      (
        SELECT GREATEST(1, COALESCE(g.max_dispatch_rounds, 3))
        FROM public.global_dispatch_settings g
        WHERE g.singleton = true
        LIMIT 1
      ),
      3
    )
  );

  RETURN v_cycles * 3;
END;
$function$;

-- 2) commit_dispatch_wave: persist wave economics + bump monotonic floor
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

-- 3) Repoint expire-offers-sweep cron → Edge expire-offers (keeps 10s cadence)
CREATE OR REPLACE FUNCTION public.expire_offers_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.edge_expire_offers_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/expire-offers'
  );
  v_token text := public.cron_edge_auth_token();
BEGIN
  -- Work-gate: only invoke Edge when there is something to expire or advance.
  IF NOT EXISTS (
    SELECT 1
    FROM public.ride_offers ro
    WHERE ro.status = 'pending'
      AND ro.expires_at IS NOT NULL
      AND ro.expires_at <= now()
    LIMIT 1
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.trips t
    WHERE t.status IN ('searching', 'offered', 'searching_new_driver', 'pending')
      AND t.dispatch_status = 'broadcasting'
      AND COALESCE(t.driver_id, t.confirmed_driver_id) IS NULL
      AND t.searching_expires_at IS NOT NULL
      AND t.searching_expires_at > now()
      AND NOT EXISTS (
        SELECT 1 FROM public.ride_offers ro
        WHERE ro.trip_id = t.id AND ro.status IN ('pending', 'countered')
      )
    LIMIT 1
  ) THEN
    RETURN;
  END IF;

  IF v_url IS NULL OR length(trim(v_url)) < 20 THEN
    RAISE LOG '[delivery] expire_offers_sweep aborted reason=bad_url';
    RETURN;
  END IF;

  IF v_token IS NULL OR length(trim(v_token)) < 20 THEN
    RAISE LOG '[delivery] expire_offers_sweep aborted reason=bad_token';
    RETURN;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_token,
        'apikey', v_token
      ),
      body := '{}'::jsonb
    );
    RAISE LOG '[delivery] expire_offers_sweep edge_invoke_enqueued url=%', v_url;
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[delivery] expire_offers_sweep edge_invoke_failed url=% sqlerrm=% sqlstate=%', v_url, SQLERRM, SQLSTATE;
  END;
END;
$function$;

DO $$
BEGIN
  PERFORM cron.unschedule('expire-offers-sweep');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'expire-offers-sweep',
  '10 seconds',
  $$SELECT public.expire_offers_sweep();$$
);

-- Ensure wave commission columns exist (idempotent; already added 20260813)
ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS base_driver_commission_percent numeric NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS wave1_commission_reduction_percent numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wave2_commission_reduction_percent numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wave3_commission_reduction_percent numeric NOT NULL DEFAULT 0;

ALTER TABLE public.ride_offers
  ADD COLUMN IF NOT EXISTS dispatch_wave integer,
  ADD COLUMN IF NOT EXISTS dispatch_round integer,
  ADD COLUMN IF NOT EXISTS base_commission_percent numeric,
  ADD COLUMN IF NOT EXISTS wave_commission_reduction_percent numeric,
  ADD COLUMN IF NOT EXISTS effective_commission_percent numeric,
  ADD COLUMN IF NOT EXISTS offered_driver_net_pence integer;

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS accepted_dispatch_wave integer,
  ADD COLUMN IF NOT EXISTS accepted_dispatch_round integer,
  ADD COLUMN IF NOT EXISTS accepted_commission_percent numeric,
  ADD COLUMN IF NOT EXISTS max_wave_commission_reduction_percent numeric NOT NULL DEFAULT 0;

-- 4) Legacy composite overload: Max Dispatch Rounds = full cycles × 3
CREATE OR REPLACE FUNCTION public.dispatch_max_broadcast_rounds(
  p_settings dispatch_settings,
  p_trip_max_rounds integer DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_cycles integer;
BEGIN
  IF p_trip_max_rounds IS NOT NULL AND p_trip_max_rounds > 0 THEN
    RETURN p_trip_max_rounds;
  END IF;

  SELECT GREATEST(1, COALESCE(g.max_dispatch_rounds, 3))
    INTO v_cycles
  FROM public.global_dispatch_settings g
  WHERE g.singleton = true
  LIMIT 1;

  RETURN GREATEST(1, COALESCE(v_cycles, 3)) * 3;
END;
$function$;
