
-- 1) accept_ride_offer: also populate accepted_preset_offer_fare_pence
CREATE OR REPLACE FUNCTION public.accept_ride_offer(p_offer_id uuid, p_driver_id uuid, p_allow_customer_counter boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_offer public.ride_offers%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_fare_pence integer;
  v_fare_source text;
  v_original_fare_pence integer;
  v_gross_pence integer;
  v_discount_pence integer;
  v_booking_net_pence integer;
  v_final_customer_pence integer;
  v_locked_base_pence integer;
  v_fare_finalize jsonb;
  v_preset_key text;
  v_preset_fare_pence integer;
  v_now timestamptz := now();
BEGIN
  PERFORM p_allow_customer_counter;

  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND', 'message', 'Offer not found');
  END IF;

  IF v_offer.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_MISMATCH', 'message', 'Offer not yours');
  END IF;

  IF v_offer.status = 'accepted' AND v_offer.negotiation_status = 'confirmed' THEN
    SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id;
    IF v_trip.driver_id = p_driver_id OR v_trip.confirmed_driver_id = p_driver_id THEN
      PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);
      RETURN jsonb_build_object(
        'success', true,
        'trip_id', v_offer.trip_id,
        'status', v_trip.status,
        'driver_id', p_driver_id,
        'final_fare_pence', v_trip.final_fare_pence,
        'final_customer_fare_pence', v_trip.final_customer_fare_pence,
        'fare_source', COALESCE(v_trip.fare_snapshot_json->>'fare_source', 'original_fare'),
        'accepted_via', 'accept_ride_offer',
        'idempotent', true
      );
    END IF;
  END IF;

  IF v_offer.status NOT IN ('pending', 'countered') THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_PENDING', 'message', 'Offer already ' || COALESCE(v_offer.status, 'handled'));
  END IF;

  IF v_offer.negotiation_status IS DISTINCT FROM 'waiting_customer'
     AND v_offer.negotiation_status IS DISTINCT FROM 'declined_customer_awaiting_driver'
     AND NOT (COALESCE(v_offer.driver_offer_fare, 0) > 0 AND v_offer.status IN ('pending', 'countered'))
     AND NOT (v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver', 'driver_accepted_counter') AND COALESCE(v_offer.customer_counter_fare, 0) > 0)
     AND NOT (v_offer.negotiation_status IS NULL AND v_offer.status IN ('pending', 'countered')) THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_ACCEPTABLE', 'message', 'Offer is not awaiting acceptance');
  END IF;

  IF v_offer.customer_respond_by IS NOT NULL AND v_offer.customer_respond_by < v_now AND v_offer.negotiation_status = 'waiting_customer' THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Offer has expired');
  END IF;
  IF v_offer.driver_respond_by IS NOT NULL AND v_offer.driver_respond_by < v_now AND v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver') THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Counter-offer response window expired');
  END IF;
  IF v_offer.negotiation_expires_at IS NOT NULL AND v_offer.negotiation_expires_at < v_now AND v_offer.negotiation_status = 'declined_customer_awaiting_driver' THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Standard fare acceptance window expired');
  END IF;
  IF v_offer.expires_at IS NOT NULL AND v_offer.expires_at < v_now THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_EXPIRED', 'message', 'Offer has expired');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND', 'message', 'Trip not found');
  END IF;
  IF v_trip.driver_id IS NOT NULL AND v_trip.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride already taken');
  END IF;
  IF v_trip.confirmed_driver_id IS NOT NULL AND v_trip.confirmed_driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride already taken');
  END IF;
  IF v_trip.status NOT IN ('pending','searching','searching_new_driver','offered','broadcasting','offering','negotiating','accepted','confirmed','driver_assigned') THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'Ride not available for assignment');
  END IF;

  v_original_fare_pence := COALESCE(
    NULLIF(v_trip.gross_fare_pence, 0),
    NULLIF(v_trip.base_fare_pence, 0),
    NULLIF(v_trip.estimated_total_pence, 0),
    NULLIF(ROUND(COALESCE(v_trip.estimated_fare, 0) * 100)::integer, 0),
    NULLIF(v_offer.counter_fare, 0),
    0
  );

  IF COALESCE(v_offer.customer_counter_fare, 0) > 0
     AND v_offer.negotiation_status IN ('waiting_driver_final', 'waiting_driver', 'driver_accepted_counter') THEN
    v_fare_pence := v_offer.customer_counter_fare;
    v_fare_source := 'customer_counter_offer';
  ELSIF COALESCE(v_offer.driver_offer_fare, 0) > 0
     AND v_offer.negotiation_status = 'waiting_customer' THEN
    v_fare_pence := v_offer.driver_offer_fare;
    v_fare_source := 'negotiated_offer';
  ELSIF v_offer.negotiation_status = 'declined_customer_awaiting_driver' THEN
    v_fare_pence := v_original_fare_pence;
    v_fare_source := 'original_fare';
  ELSE
    v_fare_pence := v_original_fare_pence;
    v_fare_source := 'original_fare';
  END IF;

  IF v_fare_pence <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_FARE', 'message', 'Invalid fare');
  END IF;

  v_gross_pence := COALESCE(NULLIF(v_trip.gross_fare_pence, 0), NULLIF(v_original_fare_pence, 0), v_fare_pence);
  v_discount_pence := COALESCE(NULLIF(v_trip.discount_pence, 0), NULLIF(v_trip.offer_discount_pence, 0), 0);
  v_booking_net_pence := COALESCE(NULLIF(v_trip.final_customer_fare_pence, 0), NULLIF(v_trip.final_fare_pence, 0));

  IF v_fare_source IN ('negotiated_offer', 'customer_counter_offer') THEN
    v_final_customer_pence := v_fare_pence;
    v_locked_base_pence := v_fare_pence;
    IF v_gross_pence > v_fare_pence THEN
      v_discount_pence := GREATEST(v_discount_pence, v_gross_pence - v_fare_pence);
    END IF;
  ELSIF v_booking_net_pence IS NOT NULL AND v_booking_net_pence > 0 AND v_gross_pence > v_booking_net_pence THEN
    v_final_customer_pence := v_booking_net_pence;
    v_locked_base_pence := v_gross_pence;
  ELSIF v_discount_pence > 0 AND v_gross_pence > v_discount_pence THEN
    v_final_customer_pence := v_gross_pence - v_discount_pence;
    v_locked_base_pence := v_gross_pence;
  ELSE
    v_final_customer_pence := v_fare_pence;
    v_locked_base_pence := COALESCE(NULLIF(v_gross_pence, 0), v_fare_pence);
  END IF;

  -- Preset selection tracking (SSOT completeness)
  v_preset_key := NULLIF(v_offer.offer_snapshot->>'selectedOfferKey', '');
  IF v_preset_key IS NOT NULL THEN
    v_preset_fare_pence := NULLIF((v_offer.offer_snapshot->'selectedOffer'->>'grossFarePence')::integer, 0);
  END IF;

  v_fare_finalize := public.finalize_negotiated_fare(v_offer.trip_id, p_offer_id, v_final_customer_pence, v_fare_source, p_driver_id);

  IF COALESCE(v_fare_finalize->>'success', 'false') <> 'true' THEN
    RETURN jsonb_build_object('success', false, 'error', 'FARE_FINALIZE_FAILED', 'message', COALESCE(v_fare_finalize->>'error', 'Could not finalize fare'));
  END IF;

  UPDATE public.ride_offers
  SET
    status = 'accepted',
    negotiation_status = 'confirmed',
    driver_offer_fare = CASE WHEN v_fare_source IN ('customer_counter_offer', 'negotiated_offer') THEN v_fare_pence ELSE driver_offer_fare END,
    counter_fare = CASE WHEN v_fare_source IN ('customer_counter_offer', 'negotiated_offer') THEN v_fare_pence ELSE counter_fare END,
    responded_at = v_now,
    customer_respond_by = NULL,
    driver_respond_by = NULL,
    grace_window_expires_at = NULL,
    negotiation_expires_at = NULL,
    expires_at = v_now + interval '7 days',
    updated_at = v_now
  WHERE id = p_offer_id;

  UPDATE public.ride_offers
  SET status = 'revoked', revoked_reason = 'another_offer_accepted', negotiation_status = NULL,
      customer_respond_by = NULL, driver_respond_by = NULL, grace_window_expires_at = NULL,
      negotiation_expires_at = NULL, updated_at = v_now
  WHERE trip_id = v_offer.trip_id AND id <> p_offer_id AND status IN ('pending', 'countered');

  UPDATE public.trips
  SET
    status = 'driver_assigned',
    driver_id = p_driver_id,
    confirmed_driver_id = p_driver_id,
    negotiation_owner_driver_id = NULL,
    negotiation_locked_until = NULL,
    negotiation_status = 'confirmed',
    current_offer_driver_id = NULL,
    current_offer_expires_at = NULL,
    dispatch_status = 'assigned',
    searching_expires_at = NULL,
    assigned_at = COALESCE(assigned_at, v_now),
    accepted_ride_offer_id = p_offer_id,
    cancelled_at = NULL,
    cancelled_by = NULL,
    cancel_reason = NULL,
    cancellation_reason = NULL,
    cancellation_note = NULL,
    accepted_driver_offer_fare_pence = CASE
      WHEN v_fare_source = 'negotiated_offer' THEN v_fare_pence
      ELSE accepted_driver_offer_fare_pence
    END,
    accepted_preset_offer_fare_pence = CASE
      WHEN v_preset_key IS NOT NULL AND v_preset_fare_pence IS NOT NULL THEN v_preset_fare_pence
      WHEN v_preset_key IS NOT NULL AND v_fare_source = 'negotiated_offer' THEN v_fare_pence
      ELSE accepted_preset_offer_fare_pence
    END,
    locked_offer_type = CASE
      WHEN v_fare_source IN ('negotiated_offer', 'customer_counter_offer') THEN v_fare_source
      ELSE locked_offer_type
    END,
    fare_snapshot_json = COALESCE(fare_snapshot_json, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'original_fare_pence', NULLIF(v_original_fare_pence, 0),
        'accepted_via', 'accept_ride_offer',
        'accepted_at', v_now,
        'accepted_preset_key', v_preset_key,
        'accepted_preset_fare_pence', v_preset_fare_pence
      )),
    updated_at = v_now
  WHERE id = v_offer.trip_id;

  UPDATE public.drivers SET current_trip_id = v_offer.trip_id, updated_at = v_now WHERE id = p_driver_id;

  IF v_trip.passenger_id IS NOT NULL THEN
    UPDATE public.customers SET active_trip_id = v_offer.trip_id, updated_at = v_now
    WHERE id = v_trip.passenger_id OR user_id = v_trip.passenger_id;
  END IF;

  PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);

  BEGIN
    PERFORM public.record_booking_delivery(v_offer.trip_id, 'accepted', p_driver_id, p_offer_id, 'postgres',
      jsonb_strip_nulls(jsonb_build_object(
        'fare_source', v_fare_source,
        'final_fare_pence', v_final_customer_pence,
        'final_customer_fare_pence', v_final_customer_pence,
        'accepted_preset_key', v_preset_key,
        'accepted_via', 'accept_ride_offer'
      )));
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[accept_ride_offer] record_booking_delivery failed: %', SQLERRM;
  END;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', v_offer.trip_id,
    'status', 'driver_assigned',
    'driver_id', p_driver_id,
    'final_fare_pence', v_final_customer_pence,
    'final_customer_fare_pence', v_final_customer_pence,
    'gross_fare_pence', (v_fare_finalize->>'gross_fare_pence')::integer,
    'discount_pence', v_discount_pence,
    'commission_pence', (v_fare_finalize->>'commission_pence')::integer,
    'driver_net_pence', (v_fare_finalize->>'driver_net_pence')::integer,
    'fare_source', v_fare_source,
    'accepted_preset_key', v_preset_key,
    'accepted_preset_fare_pence', v_preset_fare_pence,
    'original_fare_pence', v_original_fare_pence,
    'counter_offer_amount_pence', v_offer.customer_counter_fare,
    'accepted_via', 'accept_ride_offer'
  );
END;
$function$;

-- 2) apply_terminal_trip_cancellation: preserve terminal negotiation audit state
CREATE OR REPLACE FUNCTION public.apply_terminal_trip_cancellation(p_trip_id uuid, p_cancelled_by text DEFAULT 'admin'::text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_now timestamptz := now();
  v_reason text := NULLIF(trim(COALESCE(p_reason, '')), '');
  v_terminal_neg text;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  IF public.is_trip_terminal_cancel_status(v_trip.status) THEN
    RETURN jsonb_build_object('success', true, 'trip_id', p_trip_id, 'already_terminal', true);
  END IF;

  v_terminal_neg := CASE
    WHEN lower(COALESCE(p_cancelled_by, '')) IN ('customer','passenger','rider') THEN 'cancelled_by_customer'
    WHEN lower(COALESCE(p_cancelled_by, '')) = 'driver' THEN 'cancelled_by_driver'
    ELSE 'cancelled_by_admin'
  END;

  UPDATE public.trips
  SET
    status = CASE WHEN lower(COALESCE(p_cancelled_by, '')) IN ('customer','passenger','rider') THEN 'customer_cancelled' ELSE 'cancelled' END,
    cancelled_at = v_now,
    cancelled_by = p_cancelled_by,
    cancel_reason = COALESCE(v_reason, 'cancelled_by_' || COALESCE(p_cancelled_by, 'admin')),
    cancellation_reason = v_reason,
    driver_id = NULL,
    confirmed_driver_id = NULL,
    negotiation_owner_driver_id = NULL,
    current_offer_driver_id = NULL,
    negotiation_locked_until = NULL,
    current_offer_expires_at = NULL,
    searching_expires_at = NULL,
    dispatch_status = 'cancelled',
    negotiation_status = v_terminal_neg,
    special_instructions = CASE
      WHEN v_reason IS NOT NULL AND lower(p_cancelled_by) = 'admin' THEN 'Cancelled by admin: ' || v_reason
      WHEN lower(p_cancelled_by) = 'admin' THEN 'Cancelled by admin'
      ELSE special_instructions
    END,
    updated_at = v_now
  WHERE id = p_trip_id;

  IF v_trip.confirmed_driver_id IS NOT NULL OR v_trip.driver_id IS NOT NULL THEN
    UPDATE public.drivers SET current_trip_id = NULL, updated_at = v_now
    WHERE id IN (v_trip.confirmed_driver_id, v_trip.driver_id) AND current_trip_id = p_trip_id;
  END IF;

  IF v_trip.passenger_id IS NOT NULL THEN
    UPDATE public.customers SET active_trip_id = NULL, updated_at = v_now
    WHERE id = v_trip.passenger_id AND active_trip_id = p_trip_id;
  END IF;

  UPDATE public.ride_offers
  SET status = 'revoked',
      revoked_reason = 'trip_terminal_cancel',
      negotiation_status = v_terminal_neg,
      updated_at = v_now
  WHERE trip_id = p_trip_id AND status IN ('pending', 'countered', 'accepted');

  RETURN jsonb_build_object('success', true, 'trip_id', p_trip_id, 'cancelled_by', p_cancelled_by, 'negotiation_status', v_terminal_neg);
END;
$function$;
