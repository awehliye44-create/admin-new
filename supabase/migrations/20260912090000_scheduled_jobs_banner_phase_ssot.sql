-- Driver Scheduled Jobs Home banner SSOT.
-- Extends list_driver_own_scheduled_jobs confirmed rows with backend phase fields
-- so the Driver app can show one Home action banner only when the check-in window
-- is open (never on mere acceptance).
--
-- Also adds driver_checked_in_at so check-in can succeed without activating the
-- trip (Start journey remains the activation step).

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS driver_checked_in_at timestamptz;

COMMENT ON COLUMN public.trips.driver_checked_in_at IS
  'Set when the confirmed driver checks in for a scheduled commitment. Does not activate the trip; Start journey sets driver_id / en_route.';

CREATE OR REPLACE FUNCTION public.list_driver_own_scheduled_jobs(p_tab text DEFAULT 'requested'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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

  -- Requested: available marketplace offers (Accept only on Driver UI).
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
