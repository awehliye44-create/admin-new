-- Preset negotiation: both Driver→Customer and Customer→Driver use
-- preset_offer_configs.countdown_seconds for the service area.
-- The display toggle (countdown_enabled) does not change the duration.
-- Edge passes p_customer_respond_seconds; SQL also reads Admin config.
--
-- Production currently has the obsolete 3-arg overload
-- driver_send_preset_offer(uuid, integer, integer[]) with hardcoded 25s.
-- CREATE OR REPLACE of a 4-arg function does not replace that identity.
-- Drop the exact 3-arg signature first so only the unified-countdown RPC remains.

DROP FUNCTION IF EXISTS public.driver_send_preset_offer(uuid, integer, integer[]);

CREATE OR REPLACE FUNCTION public.driver_send_preset_offer(
  p_offer_id uuid,
  p_selected_total_fare_pence integer,
  p_allowed_total_fares_pence integer[],
  p_customer_respond_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_offer public.ride_offers%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_negotiation_expires_at timestamptz;
  v_now timestamptz := now();
  v_secs integer;
  v_cd_secs integer;
BEGIN
  IF p_selected_total_fare_pence IS NULL OR p_selected_total_fare_pence <= 0 THEN
    RAISE EXCEPTION 'invalid_fare';
  END IF;

  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'offer_not_found'; END IF;

  IF v_offer.status NOT IN ('pending','countered') THEN
    RAISE EXCEPTION 'offer_not_pending';
  END IF;

  IF COALESCE(v_offer.is_stacked, false) THEN
    RAISE EXCEPTION 'ineligible_stacked';
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'trip_not_found'; END IF;

  IF COALESCE(v_trip.is_scheduled, false)
     OR v_trip.dispatch_mode = 'scheduled'
     OR v_trip.trip_type = 'scheduled' THEN
    RAISE EXCEPTION 'ineligible_scheduled';
  END IF;

  IF v_trip.corporate_account_id IS NOT NULL
     OR lower(replace(coalesce(v_trip.booking_source, ''), '-', '_')) LIKE 'corporate%' THEN
    RAISE EXCEPTION 'ineligible_corporate';
  END IF;

  IF position('whatsapp' in lower(replace(coalesce(v_trip.booking_source, ''), '-', '_'))) > 0
     OR lower(replace(coalesce(v_trip.booking_source, ''), '-', '_')) IN ('guest', 'guest_web') THEN
    RAISE EXCEPTION 'ineligible_whatsapp';
  END IF;

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

  SELECT poc.countdown_seconds
    INTO v_cd_secs
    FROM public.preset_offer_configs poc
   WHERE poc.service_area_id = v_trip.service_area_id;

  IF p_customer_respond_seconds IS NOT NULL AND p_customer_respond_seconds >= 5 THEN
    v_secs := LEAST(120, GREATEST(5, p_customer_respond_seconds));
  ELSIF COALESCE(v_cd_secs, 0) >= 5 THEN
    v_secs := LEAST(120, GREATEST(5, v_cd_secs));
  ELSE
    v_secs := 30;
  END IF;
  v_negotiation_expires_at := v_now + make_interval(secs => v_secs);

  UPDATE public.ride_offers
  SET driver_offer_fare = p_selected_total_fare_pence,
      offer_options = COALESCE(
        CASE WHEN p_allowed_total_fares_pence IS NULL THEN NULL ELSE to_jsonb(p_allowed_total_fares_pence) END,
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

GRANT EXECUTE ON FUNCTION public.driver_send_preset_offer(uuid, integer, integer[], integer)
  TO authenticated, service_role;

-- Snapshot countdown_seconds is the Admin duration, independent of the display toggle.
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

  IF COALESCE(p_trip.is_scheduled, false)
     OR p_trip.dispatch_mode = 'scheduled'
     OR p_trip.trip_type = 'scheduled' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_scheduled');
  END IF;

  IF p_trip.corporate_account_id IS NOT NULL
     OR lower(replace(coalesce(p_trip.booking_source, ''), '-', '_')) LIKE 'corporate%' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_corporate');
  END IF;

  IF position('whatsapp' in lower(replace(coalesce(p_trip.booking_source, ''), '-', '_'))) > 0
     OR lower(replace(coalesce(p_trip.booking_source, ''), '-', '_')) IN ('guest', 'guest_web') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ineligible_whatsapp');
  END IF;

  IF p_trip.dispatch_mode = 'scan_and_go'
     OR p_trip.pickup_zone_id IS NOT NULL
     OR p_trip.dropoff_zone_id IS NOT NULL THEN
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
    'countdown_seconds', v_config.countdown_seconds,
    'countdown_auto_select', false
  );
END;
$function$;

-- Pre-hold SSOT: while negotiation_owner_driver_id is set, only that driver
-- may be written onto trips.driver_id / confirmed_driver_id. Other-driver
-- accept_ride_offer / stacked accept cannot steal the trip mid-negotiation.
-- Owner assignment (convert hold → assigned) is allowed. Rematch must clear
-- the owner in a prior UPDATE (driver_id still null) before a later driver
-- can be assigned.
CREATE OR REPLACE FUNCTION public.enforce_negotiation_pre_hold_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.driver_id IS NOT NULL
     AND OLD.negotiation_owner_driver_id IS NOT NULL
     AND NEW.driver_id IS DISTINCT FROM OLD.negotiation_owner_driver_id
  THEN
    RAISE EXCEPTION 'NEGOTIATION_HELD'
      USING HINT = 'Trip is pre-held to another driver during negotiation';
  END IF;
  IF NEW.confirmed_driver_id IS NOT NULL
     AND OLD.negotiation_owner_driver_id IS NOT NULL
     AND NEW.confirmed_driver_id IS DISTINCT FROM OLD.negotiation_owner_driver_id
  THEN
    RAISE EXCEPTION 'NEGOTIATION_HELD'
      USING HINT = 'Trip is pre-held to another driver during negotiation';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_negotiation_pre_hold_assignment ON public.trips;
CREATE TRIGGER trg_enforce_negotiation_pre_hold_assignment
BEFORE UPDATE OF driver_id, confirmed_driver_id
ON public.trips
FOR EACH ROW
EXECUTE FUNCTION public.enforce_negotiation_pre_hold_assignment();

COMMENT ON COLUMN public.preset_offer_configs.countdown_seconds IS
  'Preset negotiation response window (seconds) for both Driver and Customer in this service area. Independent of countdown_enabled. Expiry never auto-accepts.';

COMMENT ON COLUMN public.preset_offer_configs.countdown_enabled IS
  'Display toggle for the negotiation countdown. Does not change countdown_seconds.';

-- Stacked offers never receive preset chips (success or fallback enrich).
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
  v_stacked_locked integer := 0;
  v_reason text;
  v_countdown integer;
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
      'negotiationAllowed', true,
      'negotiation_eligible', true
    );

    UPDATE public.ride_offers ro
    SET offer_options = v_options,
        offer_snapshot = COALESCE(ro.offer_snapshot,'{}'::jsonb) || v_snapshot
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

-- Defence in depth: stacked queue cannot steal a trip held by another driver.
CREATE OR REPLACE FUNCTION public.accept_stacked_ride(
  p_offer_id uuid,
  p_driver_id uuid,
  p_current_trip_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_offer              public.ride_offers%ROWTYPE;
  v_current_trip       public.trips%ROWTYPE;
  v_stacked_trip       public.trips%ROWTYPE;
  v_now                timestamptz := now();
  v_stacked_enabled    boolean := false;
  v_max_stacked        integer := NULL;
  v_queued_count       integer := 0;
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

  IF public.driver_is_excluded_from_trip(v_offer.trip_id, p_driver_id) THEN
    RAISE EXCEPTION 'driver_excluded';
  END IF;

  IF v_offer.expires_at IS NOT NULL AND v_offer.expires_at < v_now THEN
    UPDATE public.ride_offers
    SET status = 'expired', updated_at = v_now
    WHERE id = p_offer_id;
    RAISE EXCEPTION 'offer_expired';
  END IF;

  SELECT * INTO v_stacked_trip
  FROM public.trips
  WHERE id = v_offer.trip_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'trip_not_found'; END IF;

  IF (
        v_stacked_trip.negotiation_owner_driver_id IS NOT NULL
        AND v_stacked_trip.negotiation_owner_driver_id IS DISTINCT FROM p_driver_id
      )
      OR (
        v_stacked_trip.status = 'negotiating'
        AND v_stacked_trip.negotiation_owner_driver_id IS DISTINCT FROM p_driver_id
      )
  THEN
    RAISE EXCEPTION 'NEGOTIATION_HELD';
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

  SELECT
    COALESCE(stacked_rides_enabled, false),
    max_stacked_rides
  INTO v_stacked_enabled, v_max_stacked
  FROM public.global_dispatch_settings
  WHERE singleton = true
  LIMIT 1;

  IF NOT v_stacked_enabled THEN
    RAISE EXCEPTION 'stacked_rides_disabled';
  END IF;

  IF v_max_stacked IS NULL OR v_max_stacked < 1 THEN
    RAISE EXCEPTION 'stacked_config_invalid::max_stacked_rides';
  END IF;

  SELECT COUNT(*)::integer INTO v_queued_count
  FROM public.trips
  WHERE (driver_id = p_driver_id OR confirmed_driver_id = p_driver_id)
    AND status = 'queued';

  IF v_queued_count >= v_max_stacked THEN
    RAISE EXCEPTION 'max_stack_reached::%/%', v_queued_count, v_max_stacked;
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

  IF v_current_trip.stacked_trip_id IS NULL THEN
    UPDATE public.trips
    SET stacked_trip_id = v_offer.trip_id, updated_at = v_now
    WHERE id = p_current_trip_id;

    GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
    IF v_rows_updated = 0 THEN RAISE EXCEPTION 'link_failed'; END IF;
  END IF;

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
    'stack_position',     v_next_position,
    'queued_count',       v_queued_count + 1,
    'max_stacked_rides',  v_max_stacked
  );
END;
$function$;
