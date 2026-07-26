-- Driver mobile workflow SSOT (authenticated ownership + privacy).
-- Closes gaps for My Trips, Earnings summary wrapper, Scheduled Jobs list/accept,
-- and Towards Destination preference helpers.
-- Admin behaviour preserved; no destructive data rewrites.

-- ---------------------------------------------------------------------------
-- 1) Privacy-safe trip history for the authenticated Driver only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_driver_own_trip_history(
  p_limit integer DEFAULT 50,
  p_before timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  IF v_driver_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(row) ORDER BY row.sort_at DESC)
      FROM (
        SELECT
          t.id,
          COALESCE(t.trip_number, t.trip_code, left(t.id::text, 8)) AS public_trip_ref,
          t.status AS backend_status,
          COALESCE(t.cancellation_reason, t.cancel_reason, t.cancelled_by_role) AS cancellation_reason_code,
          t.cancelled_by,
          t.cancelled_by_role,
          t.financial_outcome,
          sa.name AS service_area_label,
          -- Privacy: never return full street addresses — service area only.
          sa.name AS pickup_area_label,
          sa.name AS dropoff_area_label,
          COALESCE(t.total_stops, 1) AS total_stops,
          t.created_at AS requested_at,
          t.started_at AS pickup_at,
          t.completed_at AS dropoff_at,
          t.cancelled_at,
          t.arrived_at AS closed_at_fallback,
          CASE
            WHEN lower(COALESCE(t.status, '')) = 'no_show' THEN COALESCE(t.completed_at, t.cancelled_at, t.updated_at)
            ELSE t.completed_at
          END AS closed_at,
          COALESCE(
            t.driver_total_earnings_pence,
            t.driver_net_pence,
            t.no_show_charge_pence,
            t.cancellation_fee_pence,
            t.late_cancel_fee_pence
          ) AS payable_amount_pence,
          (t.payment_method IS NOT NULL AND lower(t.payment_method) IN ('card', 'stripe', 'apple_pay', 'google_pay', 'saved_card'))
            OR (t.stripe_payment_intent_id IS NOT NULL) AS has_card_payment_record,
          t.payment_method,
          t.booking_type,
          t.vehicle_type,
          t.created_at AS sort_at,
          false AS is_active
        FROM public.trips t
        LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
        WHERE (
            t.driver_id = v_driver_id
            OR t.confirmed_driver_id = v_driver_id
            OR t.previous_driver_id = v_driver_id
            OR (t.cancelled_driver_ids IS NOT NULL AND t.cancelled_driver_ids @> ARRAY[v_driver_id])
          )
          AND lower(COALESCE(t.status, '')) IN (
            'completed',
            'no_show',
            'cancelled',
            'customer_cancelled',
            'driver_cancelled',
            'expired',
            'expired_no_driver',
            'missed'
          )
          AND (p_before IS NULL OR t.created_at < p_before)
        ORDER BY t.created_at DESC
        LIMIT v_limit
      ) row
    ),
    '[]'::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.list_driver_own_trip_history(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_driver_own_trip_history(integer, timestamptz) TO authenticated;

COMMENT ON FUNCTION public.list_driver_own_trip_history(integer, timestamptz) IS
  'Authenticated Driver trip history — ownership via current_driver_id(); no full pickup/dropoff street addresses.';

-- ---------------------------------------------------------------------------
-- 2) Harden scheduled accept/decline to authenticated Driver only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_scheduled_ride(p_trip_id uuid, p_driver_id uuid DEFAULT NULL)
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

CREATE OR REPLACE FUNCTION public.decline_scheduled_ride(p_trip_id uuid, p_driver_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_auth_driver uuid := public.current_driver_id();
  v_driver_id uuid;
  v_trip RECORD;
BEGIN
  IF auth.uid() IS NULL OR v_auth_driver IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_AUTHENTICATED');
  END IF;

  v_driver_id := v_auth_driver;
  IF p_driver_id IS NOT NULL AND p_driver_id <> v_auth_driver THEN
    RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  INSERT INTO public.scheduled_offer_attempts (trip_id, driver_id, status, responded_at)
  VALUES (p_trip_id, v_driver_id, 'declined', now())
  ON CONFLICT (trip_id, driver_id, broadcast_round)
  DO UPDATE SET status = 'declined', responded_at = now();

  IF v_trip.current_offer_driver_id = v_driver_id THEN
    UPDATE public.trips
    SET current_offer_driver_id = NULL,
        current_offer_expires_at = NULL,
        updated_at = now()
    WHERE id = p_trip_id;
  END IF;

  -- If this driver had confirmed, release reservation (backend policy).
  IF v_trip.confirmed_driver_id = v_driver_id AND v_trip.driver_id IS NULL THEN
    UPDATE public.trips
    SET confirmed_driver_id = NULL,
        scheduled_status = 'broadcasting',
        status = COALESCE(status, 'pending'),
        scheduled_accepted_at = NULL,
        updated_at = now()
    WHERE id = p_trip_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', p_trip_id,
    'message', 'Ride declined, will be offered to other drivers'
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3) Scheduled jobs lists (safe columns; ownership / SA scoped)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_driver_own_scheduled_jobs(p_tab text DEFAULT 'requested')
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_tab text := lower(COALESCE(p_tab, 'requested'));
BEGIN
  IF auth.uid() IS NULL OR v_driver_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  IF v_tab = 'confirmed' THEN
    RETURN COALESCE(
      (
        SELECT jsonb_agg(to_jsonb(row) ORDER BY row.scheduled_at ASC)
        FROM (
          SELECT
            t.id,
            t.scheduled_at,
            t.vehicle_type,
            t.trip_type,
            t.job_type,
            t.payment_method,
            t.estimated_duration_minutes,
            COALESCE(t.driver_net_pence, round(COALESCE(t.estimated_fare, t.fare, 0) * 100)::bigint) AS estimated_fare_pence,
            COALESCE(t.currency_code, t.currency, 'GBP') AS currency_code,
            t.pickup_address,
            t.pickup_latitude,
            t.pickup_longitude,
            t.dropoff_address,
            t.dropoff_latitude,
            t.dropoff_longitude,
            t.stops,
            COALESCE(t.total_stops, 1) AS total_stops,
            t.special_instructions,
            t.scheduled_status,
            t.status,
            sa.name AS service_area_label
          FROM public.trips t
          LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
          WHERE t.dispatch_mode = 'scheduled'
            AND t.confirmed_driver_id = v_driver_id
            AND t.driver_id IS NULL
            AND t.scheduled_at > now()
            AND t.scheduled_status = 'driver_assigned'
            AND lower(COALESCE(t.status, '')) NOT IN (
              'completed', 'cancelled', 'customer_cancelled', 'driver_cancelled',
              'no_show', 'expired', 'expired_no_driver'
            )
          ORDER BY t.scheduled_at ASC
          LIMIT 100
        ) row
      ),
      '[]'::jsonb
    );
  END IF;

  -- Requested: available_scheduled_jobs semantics + driver SA filter + exclude own declines
  RETURN COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(row) ORDER BY row.scheduled_at ASC)
      FROM (
        SELECT
          t.id,
          t.scheduled_at,
          t.vehicle_type,
          t.trip_type,
          t.job_type,
          t.payment_method,
          t.estimated_duration_minutes,
          COALESCE(t.driver_net_pence, round(COALESCE(t.estimated_fare, t.fare, 0) * 100)::bigint) AS estimated_fare_pence,
          COALESCE(t.currency_code, t.currency, 'GBP') AS currency_code,
          t.pickup_address,
          t.pickup_latitude,
          t.pickup_longitude,
          t.dropoff_address,
          t.dropoff_latitude,
          t.dropoff_longitude,
          t.stops,
          COALESCE(t.total_stops, 1) AS total_stops,
          t.special_instructions,
          t.scheduled_status,
          t.status,
          sa.name AS service_area_label
        FROM public.trips t
        LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
        WHERE t.dispatch_mode = 'scheduled'
          AND t.scheduled_status = ANY (ARRAY['broadcasting', 'scheduled', 'awaiting_confirmation'])
          AND t.driver_id IS NULL
          AND t.confirmed_driver_id IS NULL
          AND t.scheduled_at > now()
          AND (t.status IS NULL OR t.status <> ALL (ARRAY[
            'completed', 'cancelled', 'customer_cancelled', 'driver_cancelled',
            'no_show', 'expired', 'expired_no_driver'
          ]))
          AND (
            t.service_area_id IS NULL
            OR t.service_area_id IN (
              SELECT d.service_area_id FROM public.drivers d WHERE d.id = v_driver_id AND d.service_area_id IS NOT NULL
              UNION
              SELECT dsa.service_area_id FROM public.driver_service_areas dsa WHERE dsa.driver_id = v_driver_id
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.scheduled_offer_attempts soa
            WHERE soa.trip_id = t.id
              AND soa.driver_id = v_driver_id
              AND soa.status IN ('declined', 'timeout', 'cancelled')
          )
        ORDER BY t.scheduled_at ASC
        LIMIT 100
      ) row
    ),
    '[]'::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.list_driver_own_scheduled_jobs(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_driver_own_scheduled_jobs(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4) Own wallet summary wrapper (cannot query another driver)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_driver_own_wallet_summary(p_service_area_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
BEGIN
  IF auth.uid() IS NULL OR v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  RETURN public.driver_wallet_summary_ssot(v_driver_id, p_service_area_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_driver_own_wallet_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_own_wallet_summary(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5) Towards destination preference (own row only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_driver_own_towards_destination()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_row public.driver_settings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT * INTO v_row FROM public.driver_settings WHERE driver_id = v_driver_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'active', false,
      'saved_destinations', '[]'::jsonb,
      'uses_today', 0
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'active', COALESCE(v_row.towards_destination_active, false),
    'address', v_row.towards_destination_address,
    'lat', v_row.towards_destination_lat,
    'lng', v_row.towards_destination_lng,
    'uses_today', COALESCE(v_row.towards_destination_uses_today, 0),
    'last_reset', v_row.towards_destination_last_reset,
    'saved_destinations', COALESCE(v_row.saved_destinations, '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_driver_own_towards_destination(
  p_address text,
  p_lat double precision,
  p_lng double precision
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
BEGIN
  IF auth.uid() IS NULL OR v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;
  IF p_address IS NULL OR length(trim(p_address)) < 3 OR p_lat IS NULL OR p_lng IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_destination');
  END IF;

  INSERT INTO public.driver_settings (driver_id, towards_destination_active, towards_destination_address,
    towards_destination_lat, towards_destination_lng, towards_destination_uses_today, towards_destination_last_reset)
  VALUES (v_driver_id, true, trim(p_address), p_lat, p_lng, COALESCE(
    (SELECT towards_destination_uses_today FROM public.driver_settings WHERE driver_id = v_driver_id), 0
  ) + 1, now())
  ON CONFLICT (driver_id) DO UPDATE SET
    towards_destination_active = true,
    towards_destination_address = EXCLUDED.towards_destination_address,
    towards_destination_lat = EXCLUDED.towards_destination_lat,
    towards_destination_lng = EXCLUDED.towards_destination_lng,
    towards_destination_uses_today = public.driver_settings.towards_destination_uses_today + 1,
    towards_destination_last_reset = now();

  RETURN jsonb_build_object('ok', true, 'active', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.clear_driver_own_towards_destination()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
BEGIN
  IF auth.uid() IS NULL OR v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  UPDATE public.driver_settings
  SET towards_destination_active = false,
      towards_destination_address = NULL,
      towards_destination_lat = NULL,
      towards_destination_lng = NULL
  WHERE driver_id = v_driver_id;

  RETURN jsonb_build_object('ok', true, 'active', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_driver_own_towards_destination() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_driver_own_towards_destination(text, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_driver_own_towards_destination() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_own_towards_destination() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_driver_own_towards_destination(text, double precision, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_driver_own_towards_destination() TO authenticated;
