-- Atomic £Z must validate the Customer inside the same transaction.
-- Edge uses service role, so pass actor ids; JWT callers use auth.uid().
-- Drop the 2-arg overload so one signature with defaults owns all calls.

DROP FUNCTION IF EXISTS public.customer_counter_ride_offer(uuid, integer);

CREATE OR REPLACE FUNCTION public.customer_counter_ride_offer(
  p_offer_id uuid,
  p_selected_fare_pence integer,
  p_actor_user_id uuid DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_offer public.ride_offers%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_now timestamptz := now();
  v_secs integer;
  v_cd_secs integer;
  v_negotiation_expires_at timestamptz;
  v_driver_fare integer;
  v_opt jsonb;
  v_pence integer;
  v_fare_ok boolean := false;
  v_commit jsonb;
  v_actor uuid;
  v_cust uuid;
BEGIN
  IF p_offer_id IS NULL OR COALESCE(p_selected_fare_pence, 0) <= 0 THEN
    RAISE EXCEPTION 'invalid_fare';
  END IF;

  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'offer_not_found';
  END IF;

  IF COALESCE(v_offer.is_stacked, false) THEN
    RAISE EXCEPTION 'ineligible_stacked';
  END IF;

  IF v_offer.negotiation_status IS DISTINCT FROM 'waiting_customer' THEN
    RAISE EXCEPTION 'not_waiting_customer';
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'trip_not_found';
  END IF;

  v_actor := COALESCE(p_actor_user_id, auth.uid());
  v_cust := p_customer_id;
  IF v_actor IS NULL AND v_cust IS NULL THEN
    RAISE EXCEPTION 'customer_required';
  END IF;
  IF v_trip.passenger_id IS DISTINCT FROM v_actor
     AND (v_cust IS NULL OR v_trip.passenger_id IS DISTINCT FROM v_cust) THEN
    RAISE EXCEPTION 'forbidden_customer';
  END IF;

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

  IF COALESCE(v_trip.negotiation_disabled, false)
     OR COALESCE(v_trip.negotiation_allowed, true) = false THEN
    RAISE EXCEPTION 'negotiation_disabled';
  END IF;

  IF v_trip.negotiation_owner_driver_id IS NOT NULL
     AND v_trip.negotiation_owner_driver_id IS DISTINCT FROM v_offer.driver_id THEN
    RAISE EXCEPTION 'locked_driver_mismatch';
  END IF;

  v_driver_fare := COALESCE(v_offer.driver_offer_fare, 0);
  IF abs(p_selected_fare_pence - v_driver_fare) <= 2 THEN
    RAISE EXCEPTION 'invalid_counter';
  END IF;

  IF jsonb_typeof(COALESCE(v_offer.offer_options, 'null'::jsonb)) = 'array' THEN
    FOR v_opt IN SELECT value FROM jsonb_array_elements(v_offer.offer_options)
    LOOP
      v_pence := COALESCE(
        NULLIF((v_opt#>>'{}')::integer, 0),
        NULLIF((v_opt->>'grossFarePence')::integer, 0),
        NULLIF((v_opt->>'gross_fare_pence')::integer, 0)
      );
      IF v_pence IS NOT NULL
         AND abs(v_pence - p_selected_fare_pence) <= 2
         AND abs(v_pence - v_driver_fare) > 2 THEN
        v_fare_ok := true;
      END IF;
    END LOOP;
  END IF;

  IF NOT v_fare_ok AND v_offer.offer_snapshot IS NOT NULL THEN
    FOR v_opt IN
      SELECT value
      FROM jsonb_array_elements(
        COALESCE(
          v_offer.offer_snapshot->'preset_options',
          v_offer.offer_snapshot->'presetOptions',
          v_offer.offer_snapshot->'remaining_options',
          v_offer.offer_snapshot->'remainingOptions',
          '[]'::jsonb
        )
      )
    LOOP
      v_pence := COALESCE(
        NULLIF((v_opt->>'grossFarePence')::integer, 0),
        NULLIF((v_opt->>'gross_fare_pence')::integer, 0)
      );
      IF v_pence IS NOT NULL
         AND abs(v_pence - p_selected_fare_pence) <= 2
         AND abs(v_pence - v_driver_fare) > 2 THEN
        v_fare_ok := true;
      END IF;
    END LOOP;
  END IF;

  IF NOT v_fare_ok THEN
    RAISE EXCEPTION 'invalid_counter_fare';
  END IF;

  SELECT poc.countdown_seconds
    INTO v_cd_secs
    FROM public.preset_offer_configs poc
   WHERE poc.service_area_id = v_trip.service_area_id;

  IF COALESCE(v_cd_secs, 0) >= 5 THEN
    v_secs := LEAST(120, GREATEST(5, v_cd_secs));
  ELSE
    v_secs := 30;
  END IF;
  v_negotiation_expires_at := v_now + make_interval(secs => v_secs);

  UPDATE public.ride_offers
  SET
    customer_counter_fare = p_selected_fare_pence,
    negotiation_status = 'waiting_driver_final',
    customer_respond_by = NULL,
    driver_respond_by = v_negotiation_expires_at,
    negotiation_expires_at = v_negotiation_expires_at,
    expires_at = v_negotiation_expires_at,
    grace_window_expires_at = v_negotiation_expires_at,
    status = 'countered',
    responded_at = COALESCE(responded_at, v_now),
    updated_at = v_now
  WHERE id = p_offer_id
    AND negotiation_status = 'waiting_customer';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_waiting_customer';
  END IF;

  UPDATE public.trips
  SET
    status = 'negotiating',
    negotiation_owner_driver_id = v_offer.driver_id,
    current_offer_driver_id = v_offer.driver_id,
    current_negotiation_id = p_offer_id,
    negotiation_locked_until = v_negotiation_expires_at,
    dispatch_status = 'paused',
    broadcast_enabled = false,
    updated_at = v_now
  WHERE id = v_trip.id;

  v_commit := public.commit_negotiation_fare(
    v_trip.id,
    p_selected_fare_pence,
    'customer_counter_offer',
    p_offer_id,
    NULL
  );
  IF COALESCE(v_commit->>'success', 'false') <> 'true' THEN
    RAISE EXCEPTION 'FARE_COMMIT_FAILED';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', v_trip.id,
    'offer_id', p_offer_id,
    'customer_counter_fare', p_selected_fare_pence,
    'negotiation_status', 'waiting_driver_final',
    'driver_respond_by', v_negotiation_expires_at,
    'negotiation_expires_at', v_negotiation_expires_at,
    'expires_at', v_negotiation_expires_at,
    'countdown_seconds', v_secs,
    'fare_commit', v_commit
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.customer_counter_ride_offer(uuid, integer, uuid, uuid) TO authenticated, service_role;
