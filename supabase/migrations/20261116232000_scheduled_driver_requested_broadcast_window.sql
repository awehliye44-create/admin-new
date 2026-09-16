-- MK-260916-038 RC3: Driver Scheduled Requested + accept must wait for the
-- canonical marketplace window (persisted scheduled_broadcast_at, with a
-- compute_scheduled_dispatch_anchors reconstruction only when the column is NULL).

CREATE OR REPLACE FUNCTION public.scheduled_marketplace_is_open(
  p_dispatch_mode text,
  p_scheduled_status text,
  p_status text,
  p_scheduled_at timestamptz,
  p_scheduled_broadcast_at timestamptz,
  p_created_at timestamptz,
  p_driver_id uuid DEFAULT NULL,
  p_confirmed_driver_id uuid DEFAULT NULL,
  p_now timestamptz DEFAULT now()
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_broadcast timestamptz;
  v_status text := lower(COALESCE(p_status, ''));
  v_sched text := lower(COALESCE(p_scheduled_status, ''));
BEGIN
  IF lower(COALESCE(p_dispatch_mode, '')) <> 'scheduled' THEN
    RETURN false;
  END IF;

  IF p_driver_id IS NOT NULL OR p_confirmed_driver_id IS NOT NULL THEN
    RETURN false;
  END IF;

  IF v_status IN (
    'completed', 'cancelled', 'customer_cancelled', 'driver_cancelled',
    'no_show', 'expired', 'expired_no_driver'
  ) THEN
    RETURN false;
  END IF;

  -- Marketplace must already have been opened by scheduled-dispatch STEP 2.
  IF v_sched NOT IN ('broadcasting', 'awaiting_confirmation') THEN
    RETURN false;
  END IF;

  IF p_scheduled_at IS NULL OR p_scheduled_at <= p_now THEN
    RETURN false;
  END IF;

  v_broadcast := p_scheduled_broadcast_at;
  IF v_broadcast IS NULL THEN
    -- Legacy NULL anchors: reconstruct the SAME policy clock from created_at.
    -- Do not treat polluted broadcasting + NULL as immediately visible.
    SELECT a.scheduled_broadcast_at
      INTO v_broadcast
    FROM public.compute_scheduled_dispatch_anchors(
      p_scheduled_at,
      COALESCE(p_created_at, p_now)
    ) a;
  END IF;

  RETURN v_broadcast IS NOT NULL AND v_broadcast <= p_now;
END;
$function$;

COMMENT ON FUNCTION public.scheduled_marketplace_is_open(
  text, text, text, timestamptz, timestamptz, timestamptz, uuid, uuid, timestamptz
) IS
  'MK-260916-038: Driver Requested/accept gate. Requires STEP 2 broadcasting and scheduled_broadcast_at <= now (reconstructed from global_dispatch_settings when NULL).';

GRANT EXECUTE ON FUNCTION public.scheduled_marketplace_is_open(
  text, text, text, timestamptz, timestamptz, timestamptz, uuid, uuid, timestamptz
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.scheduled_marketplace_is_open(
  text, text, text, timestamptz, timestamptz, timestamptz, uuid, uuid, timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.list_driver_own_scheduled_jobs(p_tab text DEFAULT 'requested'::text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid := public.current_driver_id();
  v_tab text := lower(COALESCE(p_tab, 'requested'));
  v_check_in_lead integer := 90;
  v_check_in_grace integer := 15;
  v_early_arrival integer := 10;
  v_safety integer := 5;
  v_access integer := 0;
  v_start_grace integer := 5;
BEGIN
  IF auth.uid() IS NULL OR v_driver_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT
    COALESCE(g.check_in_min_lead_minutes, 90),
    COALESCE(g.check_in_grace_minutes, 15),
    COALESCE(g.early_arrival_buffer_minutes, 10),
    COALESCE(g.safety_buffer_minutes, 5),
    COALESCE(g.pickup_access_allowance_minutes, 0),
    COALESCE(g.start_journey_grace_minutes, 5)
  INTO
    v_check_in_lead,
    v_check_in_grace,
    v_early_arrival,
    v_safety,
    v_access,
    v_start_grace
  FROM public.global_dispatch_settings g
  WHERE g.singleton = true
  LIMIT 1;

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
            t.financial_model AS financial_model,
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
            sa.name AS service_area_label,
            t.driver_checked_in_at,
            (
              t.scheduled_at
              - make_interval(mins => GREATEST(v_early_arrival + v_safety + v_access, 1))
            ) AS leave_by_at,
            CASE
              WHEN t.driver_checked_in_at IS NULL
                AND now() < (t.scheduled_at - make_interval(mins => v_check_in_lead))
                THEN 'confirmed'
              WHEN t.driver_checked_in_at IS NULL
                THEN 'check_in_required'
              WHEN now() < (
                t.scheduled_at
                - make_interval(mins => GREATEST(v_early_arrival + v_safety + v_access, 1))
              )
                THEN 'checked_in'
              WHEN now() < (
                t.scheduled_at
                - make_interval(mins => GREATEST(v_early_arrival + v_safety + v_access, 1))
                + make_interval(mins => v_start_grace)
              )
                THEN 'start_journey'
              ELSE 'urgent_start_journey'
            END AS banner_phase,
            CASE
              WHEN t.driver_checked_in_at IS NULL
                AND now() < (t.scheduled_at - make_interval(mins => v_check_in_lead))
                THEN false
              ELSE true
            END AS is_banner_candidate,
            CASE
              WHEN t.driver_checked_in_at IS NULL
                AND now() >= (t.scheduled_at - make_interval(mins => v_check_in_lead))
                THEN 'check_in'
              WHEN t.driver_checked_in_at IS NOT NULL
                AND now() >= (
                  t.scheduled_at
                  - make_interval(mins => GREATEST(v_early_arrival + v_safety + v_access, 1))
                )
                THEN 'start_journey'
              ELSE NULL
            END AS primary_action,
            CASE
              WHEN t.driver_checked_in_at IS NULL
                AND now() >= (t.scheduled_at - make_interval(mins => v_check_in_lead))
                THEN 'Check in'
              WHEN t.driver_checked_in_at IS NOT NULL
                AND now() >= (
                  t.scheduled_at
                  - make_interval(mins => GREATEST(v_early_arrival + v_safety + v_access, 1))
                )
                THEN 'Start journey'
              ELSE NULL
            END AS cta_label
          FROM public.trips t
          LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
          WHERE t.dispatch_mode = 'scheduled'
            AND t.confirmed_driver_id = v_driver_id
            AND t.driver_id IS NULL
            AND t.scheduled_status = 'driver_assigned'
            AND t.scheduled_at > (now() - make_interval(mins => GREATEST(v_check_in_grace, 15)))
            AND lower(COALESCE(t.status, '')) NOT IN (
              'completed', 'cancelled', 'customer_cancelled', 'driver_cancelled',
              'no_show', 'expired', 'expired_no_driver', 'en_route_to_pickup', 'in_progress'
            )
          ORDER BY t.scheduled_at ASC
          LIMIT 100
        ) row
      ),
      '[]'::jsonb
    );
  END IF;

  -- Requested: marketplace open (STEP 2) AND broadcast window reached.
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
          t.financial_model AS financial_model,
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
        WHERE public.scheduled_marketplace_is_open(
            t.dispatch_mode,
            t.scheduled_status,
            t.status,
            t.scheduled_at,
            t.scheduled_broadcast_at,
            t.created_at,
            t.driver_id,
            t.confirmed_driver_id,
            now()
          )
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

  IF NOT public.scheduled_marketplace_is_open(
    v_trip.dispatch_mode,
    v_trip.scheduled_status,
    v_trip.status,
    v_trip.scheduled_at,
    v_trip.scheduled_broadcast_at,
    v_trip.created_at,
    v_trip.driver_id,
    v_trip.confirmed_driver_id,
    now()
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE', 'message', 'This job is no longer available');
  END IF;

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
