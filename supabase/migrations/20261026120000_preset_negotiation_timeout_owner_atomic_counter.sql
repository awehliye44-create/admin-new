-- Preset negotiation: expire-offers is the sole timeout owner;
-- customer_counter_ride_offer is the atomic £Z write;
-- resolve_negotiation_rebroadcast_fare is rebuildable from this repo.

-- 1) Work-gate: invoke expire-offers for live negotiation deadlines
--    even when the offer is countered and the trip is negotiating/paused.
CREATE OR REPLACE FUNCTION public.expire_offers_sweep_has_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.ride_offers ro
    WHERE ro.status = 'pending'
      AND ro.expires_at IS NOT NULL
      AND ro.expires_at <= now()
    LIMIT 1
  )
  OR EXISTS (
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
  )
  OR EXISTS (
    SELECT 1
    FROM public.ride_offers ro
    WHERE ro.status IN ('pending', 'countered')
      AND ro.negotiation_status IN (
        'waiting_customer',
        'waiting_driver',
        'waiting_driver_final',
        'declined_customer_awaiting_driver'
      )
      AND (
        (
          ro.negotiation_status = 'waiting_customer'
          AND ro.customer_respond_by IS NOT NULL
          AND ro.customer_respond_by <= now()
          AND ro.responded_at IS NULL
        )
        OR (
          ro.negotiation_status IN ('waiting_driver', 'waiting_driver_final')
          AND ro.driver_respond_by IS NOT NULL
          AND ro.driver_respond_by <= now()
        )
        OR (
          ro.negotiation_status = 'declined_customer_awaiting_driver'
          AND ro.grace_window_expires_at IS NOT NULL
          AND ro.grace_window_expires_at <= now()
        )
        OR (
          ro.negotiation_status = 'waiting_customer'
          AND ro.customer_respond_by IS NULL
          AND ro.updated_at < now() - interval '90 seconds'
        )
      )
    LIMIT 1
  )
  OR EXISTS (
    SELECT 1
    FROM public.trips t
    WHERE t.status = 'negotiating'
      AND t.updated_at < now() - interval '90 seconds'
    LIMIT 1
  );
$function$;

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
  IF NOT public.expire_offers_sweep_has_work() THEN
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

-- SQL cron twin must not compete with expire-offers.
CREATE OR REPLACE FUNCTION public.expire_stale_negotiations()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN jsonb_build_object(
    'processed', 0,
    'ran_at', now(),
    'skipped', true,
    'reason', 'expire_offers_owns_timeouts'
  );
END;
$function$;

-- Keep live negotiation retrievable after the previous response deadline.
CREATE OR REPLACE FUNCTION public.get_driver_pending_ride_offers()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'offer', row_to_json(ro)::jsonb,
      'trip', row_to_json(t)::jsonb
    )
    ORDER BY ro.created_at DESC
  ), '[]'::jsonb)
  FROM public.ride_offers ro
  INNER JOIN public.trips t ON t.id = ro.trip_id
  WHERE ro.driver_id = (SELECT d.id FROM public.drivers d WHERE d.user_id = auth.uid() LIMIT 1)
    AND ro.status IN ('pending', 'countered')
    AND (
      ro.expires_at > now()
      OR ro.negotiation_status IN (
        'waiting_customer',
        'waiting_driver',
        'waiting_driver_final',
        'declined_customer_awaiting_driver'
      )
      OR (
        t.status = 'negotiating'
        AND t.negotiation_owner_driver_id = ro.driver_id
      )
    );
$function$;

-- Golden Rule rebroadcast fare: binding £Z if submitted, else original £X.
CREATE OR REPLACE FUNCTION public.resolve_negotiation_rebroadcast_fare(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_counter_pence integer;
  v_base_pence integer;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  SELECT MAX(ro.customer_counter_fare) INTO v_counter_pence
  FROM public.ride_offers ro
  WHERE ro.trip_id = p_trip_id
    AND ro.customer_counter_fare IS NOT NULL
    AND ro.customer_counter_fare > 0;

  IF COALESCE(v_counter_pence, 0) > 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'fare_pence', v_counter_pence,
      'fare_source', 'customer_counter_offer',
      'counter_binding', true
    );
  END IF;

  v_base_pence := public.trip_negotiation_base_fare_pence(v_trip);
  IF COALESCE(v_base_pence, 0) <= 0 THEN
    v_base_pence := COALESCE(
      NULLIF(v_trip.final_customer_fare_pence, 0),
      NULLIF(v_trip.final_fare_pence, 0),
      NULLIF(v_trip.gross_fare_pence, 0),
      NULLIF(v_trip.base_fare_pence, 0),
      NULLIF(v_trip.estimated_total_pence, 0),
      NULLIF(ROUND(COALESCE(v_trip.estimated_fare, 0) * 100)::integer, 0),
      NULLIF(ROUND(COALESCE(v_trip.fare, 0) * 100)::integer, 0),
      0
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'fare_pence', v_base_pence,
    'fare_source', 'original_fare',
    'counter_binding', false
  );
END;
$function$;

COMMENT ON FUNCTION public.resolve_negotiation_rebroadcast_fare(uuid) IS
  'Golden Rule rebroadcast fare: binding customer counter £Z if submitted, else original £X.';

GRANT EXECUTE ON FUNCTION public.resolve_negotiation_rebroadcast_fare(uuid) TO authenticated, service_role;

-- Atomic Customer £Z: offer + trip hold + committed fare in one transaction.
CREATE OR REPLACE FUNCTION public.customer_counter_ride_offer(
  p_offer_id uuid,
  p_selected_fare_pence integer
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

GRANT EXECUTE ON FUNCTION public.customer_counter_ride_offer(uuid, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_pending_ride_offers() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_negotiation_rebroadcast_fare(uuid) TO authenticated, service_role;

-- Leftover SQL cron twin must never compete with expire-offers.
CREATE OR REPLACE FUNCTION public.expire_stale_negotiations_has_work()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT false;
$function$;
