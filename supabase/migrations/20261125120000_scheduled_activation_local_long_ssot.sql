-- Scheduled activation SSOT: Local vs Long + fixed T-minute activation.
-- Adds Admin Activation tab columns. Simplifies list_driver_own_scheduled_jobs
-- (no check-in / leave-by / Start journey CTA from Commitment Policy).
-- Does NOT rewrite historical scheduled_at / confirmed_driver_id.
-- Does NOT drop legacy commitment columns (may still exist on rows); runtime
-- no longer uses them for activation.

ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS long_trip_threshold_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS local_activation_minutes_before_pickup integer NOT NULL DEFAULT 11,
  ADD COLUMN IF NOT EXISTS long_activation_minutes_before_pickup integer NOT NULL DEFAULT 30;

COMMENT ON COLUMN public.global_dispatch_settings.long_trip_threshold_minutes IS
  'Estimated trip duration (minutes) at/above this → LONG scheduled activation.';
COMMENT ON COLUMN public.global_dispatch_settings.local_activation_minutes_before_pickup IS
  'Minutes before pickup to activate LOCAL scheduled trips (default 11).';
COMMENT ON COLUMN public.global_dispatch_settings.long_activation_minutes_before_pickup IS
  'Minutes before pickup to activate LONG scheduled trips (default 30).';

-- Ensure singleton row has activation defaults (idempotent).
UPDATE public.global_dispatch_settings
SET
  long_trip_threshold_minutes = COALESCE(long_trip_threshold_minutes, 30),
  local_activation_minutes_before_pickup = COALESCE(local_activation_minutes_before_pickup, 11),
  long_activation_minutes_before_pickup = COALESCE(long_activation_minutes_before_pickup, 30),
  urgent_dispatch_trigger_minutes_before_pickup = COALESCE(urgent_dispatch_trigger_minutes_before_pickup, 9),
  min_advance_time_minutes = COALESCE(min_advance_time_minutes, 20)
WHERE singleton = true;

-- Safe backfill for future held/scheduled trips: keep convert_at as T−urgent when
-- missing; never clear confirmed_driver_id; never rewrite commitment for preconfirmed.
UPDATE public.trips t
SET
  scheduled_convert_at = COALESCE(
    t.scheduled_convert_at,
    t.scheduled_at - make_interval(
      mins => GREATEST(
        COALESCE(
          (SELECT g.urgent_dispatch_trigger_minutes_before_pickup
           FROM public.global_dispatch_settings g
           WHERE g.singleton = true
           LIMIT 1),
          9
        ),
        1
      )
    )
  )
WHERE t.dispatch_mode = 'scheduled'
  AND t.scheduled_at IS NOT NULL
  AND t.scheduled_at > now()
  AND t.scheduled_convert_at IS NULL
  AND lower(COALESCE(t.status, '')) NOT IN (
    'completed', 'cancelled', 'customer_cancelled', 'driver_cancelled',
    'no_show', 'expired', 'expired_no_driver', 'en_route_to_pickup', 'in_progress'
  );

CREATE OR REPLACE FUNCTION public.list_driver_own_scheduled_jobs(p_tab text DEFAULT 'requested'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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
            NULL::timestamptz AS leave_by_at,
            CASE
              WHEN t.scheduled_status = 'awaiting_activation_accept' THEN 'awaiting_activation'
              ELSE 'confirmed'
            END AS banner_phase,
            true AS is_banner_candidate,
            NULL::text AS primary_action,
            NULL::text AS cta_label
          FROM public.trips t
          LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
          WHERE t.dispatch_mode = 'scheduled'
            AND t.confirmed_driver_id = v_driver_id
            AND t.driver_id IS NULL
            AND t.scheduled_status IN ('driver_assigned', 'awaiting_activation_accept', 'scheduled_committed', 'scheduled')
            AND t.scheduled_at > (now() - make_interval(mins => 15))
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

  -- Requested: marketplace open AND Admin has released broadcast (not admin_held).
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
          AND COALESCE(t.scheduled_status, '') IS DISTINCT FROM 'admin_held'
          AND t.scheduled_broadcast_at IS NOT NULL
          AND t.scheduled_broadcast_at <= now()
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
