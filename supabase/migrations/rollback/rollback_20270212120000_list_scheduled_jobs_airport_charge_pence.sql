-- Rollback Phase 2 list airport_charge_pence: restore production list_driver_own_scheduled_jobs body from 20261229120000 (no airport column).
-- Renumbered from 20261224170000 so apply order follows prod head 20261228194500.
-- MK-261103-006: Scheduled Jobs list must expose driver-net preview, never
-- raw customer estimated_fare under a confusing alias that native withholds.
-- compute_driver_net_preview_from_gross uses the viewing driver's tier.

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
            COALESCE(
              NULLIF(t.driver_net_pence, 0),
              public.compute_driver_net_preview_from_gross(
                COALESCE(
                  NULLIF(t.estimated_total_pence, 0),
                  NULLIF(t.final_fare_pence, 0),
                  NULLIF(t.final_customer_fare_pence, 0),
                  NULLIF(t.gross_fare_pence, 0),
                  NULLIF(t.locked_base_fare_pence, 0),
                  round(COALESCE(NULLIF(t.estimated_fare, 0), 0) * 100)::integer
                ),
                v_driver_id,
                t.service_area_id,
                COALESCE(t.airport_charge_pence, 0)
              )
            ) AS driver_net_pence,
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
            false AS is_banner_candidate,
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
          COALESCE(
            NULLIF(t.driver_net_pence, 0),
            public.compute_driver_net_preview_from_gross(
              COALESCE(
                NULLIF(t.estimated_total_pence, 0),
                NULLIF(t.final_fare_pence, 0),
                NULLIF(t.final_customer_fare_pence, 0),
                NULLIF(t.gross_fare_pence, 0),
                NULLIF(t.locked_base_fare_pence, 0),
                round(COALESCE(NULLIF(t.estimated_fare, 0), 0) * 100)::integer
              ),
              v_driver_id,
              t.service_area_id,
              COALESCE(t.airport_charge_pence, 0)
            )
          ) AS driver_net_pence,
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

COMMENT ON FUNCTION public.list_driver_own_scheduled_jobs(text) IS
  'Driver Scheduled Jobs list. Fare column is driver_net_pence (stamped or tier preview) — never customer estimated_fare alone.';

-- Preserve production grants (CREATE OR REPLACE keeps ACLs; re-assert for clarity).
GRANT EXECUTE ON FUNCTION public.list_driver_own_scheduled_jobs(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_driver_own_scheduled_jobs(text) TO service_role;
