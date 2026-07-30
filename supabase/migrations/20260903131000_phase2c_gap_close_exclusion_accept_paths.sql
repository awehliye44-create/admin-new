-- Phase 2C/2D gap-close: harden remaining accept + offer-creation paths against trip_driver_exclusions.
-- Depends on driver_is_excluded_from_trip from 20260903130000.

CREATE OR REPLACE FUNCTION public.accept_scheduled_ride(p_trip_id uuid, p_driver_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_auth_driver uuid := public.current_driver_id();
  v_driver_id uuid;
  v_trip RECORD;
  v_locked boolean;
  v_sa uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_AUTHENTICATED', 'message', 'Sign in required');
  END IF;

  IF v_auth_driver IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_NOT_FOUND', 'message', 'Driver profile not linked');
  END IF;

  -- Ignore/override arbitrary client driver ids — ownership is auth-linked only.
  v_driver_id := v_auth_driver;
  IF p_driver_id IS NOT NULL AND p_driver_id <> v_auth_driver THEN
    RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN', 'message', 'Cannot accept for another driver');
  END IF;

  v_locked := pg_try_advisory_xact_lock(hashtext(p_trip_id::text));
  IF NOT v_locked THEN
    RETURN jsonb_build_object('success', false, 'error', 'LOCK_CONTENTION', 'message', 'Another driver is accepting this ride');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND', 'message', 'Trip not found');
  END IF;

  IF v_trip.driver_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_ALREADY_TAKEN', 'message', 'This ride has already been taken by another driver');
  END IF;

  IF v_trip.confirmed_driver_id IS NOT NULL AND v_trip.confirmed_driver_id <> v_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_ALREADY_TAKEN', 'message', 'Another driver has already reserved this ride');
  END IF;

  -- Phase 2D: durable exclusion SSOT (plus array compatibility inside helper).
  IF public.driver_is_excluded_from_trip(p_trip_id, v_driver_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'DRIVER_EXCLUDED',
      'message', 'Driver is excluded from this trip'
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.scheduled_offer_attempts
    WHERE trip_id = p_trip_id
      AND driver_id = v_driver_id
      AND status IN ('declined', 'timeout', 'cancelled')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_EXCLUDED', 'message', 'You previously declined or timed out on this ride');
  END IF;

  IF v_trip.scheduled_status NOT IN ('broadcasting', 'scheduled', 'awaiting_confirmation') THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'This job is no longer available');
  END IF;

  -- Service-area eligibility: trip SA must be one of the driver's assigned areas (or same primary).
  SELECT d.service_area_id INTO v_sa FROM public.drivers d WHERE d.id = v_driver_id;
  IF v_trip.service_area_id IS NOT NULL
     AND v_trip.service_area_id IS DISTINCT FROM v_sa
     AND NOT EXISTS (
       SELECT 1 FROM public.driver_service_areas dsa
       WHERE dsa.driver_id = v_driver_id AND dsa.service_area_id = v_trip.service_area_id
     )
  THEN
    RETURN jsonb_build_object('success', false, 'error', 'SERVICE_AREA', 'message', 'This job is outside your service area');
  END IF;

  UPDATE public.trips
  SET
    confirmed_driver_id = v_driver_id,
    status = 'accepted',
    scheduled_status = 'driver_assigned',
    scheduled_accepted_at = now(),
    current_offer_driver_id = NULL,
    current_offer_expires_at = NULL,
    updated_at = now()
  WHERE id = p_trip_id;

  INSERT INTO public.scheduled_offer_attempts
    (trip_id, driver_id, status, responded_at, response_time_seconds)
  VALUES
    (p_trip_id, v_driver_id, 'accepted', now(), 0)
  ON CONFLICT (trip_id, driver_id, broadcast_round)
  DO UPDATE SET status = 'accepted', responded_at = now();

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', p_trip_id,
    'message', 'Scheduled ride reserved successfully'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.accept_stacked_ride(p_offer_id uuid, p_driver_id uuid, p_current_trip_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_offer              public.ride_offers%ROWTYPE;
  v_current_trip       public.trips%ROWTYPE;
  v_now                timestamptz := now();
  v_stacked_enabled    boolean := false;
  v_revoked_ids        uuid[] := '{}';
  v_passenger_user_id  uuid;
  v_rows_updated       integer;
  v_next_position      integer;
BEGIN
  SELECT * INTO v_offer
  FROM public.ride_offers
  WHERE id = p_offer_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found'; END IF;

  IF v_offer.driver_id IS DISTINCT FROM p_driver_id THEN
    RAISE EXCEPTION 'offer_not_for_driver';
  END IF;

  IF v_offer.status <> 'pending' THEN
    RAISE EXCEPTION 'offer_not_pending::%', v_offer.status;
  END IF;

  -- Phase 2D: excluded drivers cannot accept stale stacked offers.
  IF public.driver_is_excluded_from_trip(v_offer.trip_id, p_driver_id) THEN
    RAISE EXCEPTION 'driver_excluded';
  END IF;

  IF v_offer.expires_at IS NOT NULL AND v_offer.expires_at < v_now THEN
    UPDATE public.ride_offers
    SET status = 'expired', updated_at = v_now
    WHERE id = p_offer_id;
    RAISE EXCEPTION 'offer_expired';
  END IF;

  SELECT * INTO v_current_trip
  FROM public.trips
  WHERE id = p_current_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'current_trip_not_found'; END IF;

  IF v_current_trip.driver_id IS DISTINCT FROM p_driver_id
     AND v_current_trip.confirmed_driver_id IS DISTINCT FROM p_driver_id THEN
    RAISE EXCEPTION 'current_trip_not_yours';
  END IF;

  IF v_current_trip.status IN (
    'completed', 'cancelled', 'expired', 'declined',
    'customer_cancelled', 'driver_cancelled', 'no_show'
  ) THEN
    RAISE EXCEPTION 'current_trip_terminal::%', v_current_trip.status;
  END IF;

  SELECT COALESCE(stacked_rides_enabled, false) INTO v_stacked_enabled
  FROM public.global_dispatch_settings
  WHERE singleton = true
  LIMIT 1;

  IF NOT v_stacked_enabled THEN
    RAISE EXCEPTION 'stacked_rides_disabled';
  END IF;

  IF v_current_trip.stacked_trip_id IS NOT NULL THEN
    RAISE EXCEPTION 'already_has_stacked_trip::%', v_current_trip.stacked_trip_id;
  END IF;

  UPDATE public.ride_offers
  SET status = 'accepted', responded_at = v_now, updated_at = v_now
  WHERE id = p_offer_id;

  WITH revoked AS (
    UPDATE public.ride_offers
    SET status = 'revoked', revoked_reason = 'taken', updated_at = v_now
    WHERE trip_id = v_offer.trip_id
      AND id      <> p_offer_id
      AND status   = 'pending'
    RETURNING driver_id
  )
  SELECT array_agg(driver_id) INTO v_revoked_ids FROM revoked;

  SELECT COALESCE(MAX(stack_position), 0) + 1 INTO v_next_position
  FROM public.trips
  WHERE (driver_id = p_driver_id OR confirmed_driver_id = p_driver_id)
    AND status = 'queued';

  UPDATE public.trips
  SET
    driver_id           = p_driver_id,
    confirmed_driver_id = p_driver_id,
    status              = 'queued',
    dispatch_status     = 'stacked_committed',
    stack_position      = v_next_position,
    updated_at          = v_now
  WHERE id = v_offer.trip_id;

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  IF v_rows_updated = 0 THEN
    RAISE EXCEPTION 'queued_trip_assign_failed';
  END IF;

  UPDATE public.trips
  SET stacked_trip_id = v_offer.trip_id, updated_at = v_now
  WHERE id = p_current_trip_id;

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  IF v_rows_updated = 0 THEN RAISE EXCEPTION 'link_failed'; END IF;

  SELECT c.user_id INTO v_passenger_user_id
  FROM public.trips t
  JOIN public.customers c ON c.id = t.passenger_id
  WHERE t.id = v_offer.trip_id
  LIMIT 1;

  RETURN jsonb_build_object(
    'success',            true,
    'trip_id',            v_offer.trip_id,
    'current_trip_id',    p_current_trip_id,
    'revoked_driver_ids', COALESCE(v_revoked_ids, '{}'),
    'passenger_user_id',  v_passenger_user_id,
    'stack_position',     v_next_position
  );
END;
$function$;

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
    IF public.driver_is_excluded_from_trip(p_trip_id, r.driver_id) THEN
      CONTINUE;
    END IF;

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
