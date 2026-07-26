-- Driver My Trips: server-side tab filter + single-trip detail by id.
-- Preserves ownership via current_driver_id(); still returns area labels only.

DROP FUNCTION IF EXISTS public.list_driver_own_trip_history(integer, timestamptz);

CREATE OR REPLACE FUNCTION public.list_driver_own_trip_history(
  p_limit integer DEFAULT 50,
  p_before timestamptz DEFAULT NULL,
  p_tab text DEFAULT NULL,
  p_trip_id uuid DEFAULT NULL
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
  v_tab text := lower(nullif(trim(COALESCE(p_tab, '')), ''));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  IF v_driver_id IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  IF v_tab IS NOT NULL AND v_tab NOT IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'invalid_tab' USING ERRCODE = '22023';
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
          COALESCE(
            CASE
              WHEN lower(COALESCE(t.status, '')) IN ('completed', 'no_show')
                THEN COALESCE(t.completed_at, t.cancelled_at, t.updated_at, t.created_at)
              ELSE COALESCE(t.cancelled_at, t.updated_at, t.created_at)
            END,
            t.created_at
          ) AS sort_at,
          false AS is_active
        FROM public.trips t
        LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
        WHERE (
            t.driver_id = v_driver_id
            OR t.confirmed_driver_id = v_driver_id
            OR t.previous_driver_id = v_driver_id
            OR (t.cancelled_driver_ids IS NOT NULL AND t.cancelled_driver_ids @> ARRAY[v_driver_id])
          )
          AND (
            p_trip_id IS NULL
            OR t.id = p_trip_id
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
          AND (
            v_tab IS NULL
            OR (
              v_tab = 'completed'
              AND lower(COALESCE(t.status, '')) IN ('completed', 'no_show')
            )
            OR (
              v_tab = 'cancelled'
              AND lower(COALESCE(t.status, '')) IN (
                'cancelled',
                'customer_cancelled',
                'driver_cancelled',
                'expired',
                'expired_no_driver',
                'missed'
              )
            )
          )
          AND (p_before IS NULL OR COALESCE(
            CASE
              WHEN lower(COALESCE(t.status, '')) IN ('completed', 'no_show')
                THEN COALESCE(t.completed_at, t.cancelled_at, t.updated_at, t.created_at)
              ELSE COALESCE(t.cancelled_at, t.updated_at, t.created_at)
            END,
            t.created_at
          ) < p_before)
        ORDER BY sort_at DESC
        LIMIT CASE WHEN p_trip_id IS NOT NULL THEN 1 ELSE v_limit END
      ) row
    ),
    '[]'::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.list_driver_own_trip_history(integer, timestamptz, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_driver_own_trip_history(integer, timestamptz, text, uuid) TO authenticated;

COMMENT ON FUNCTION public.list_driver_own_trip_history(integer, timestamptz, text, uuid) IS
  'Authenticated Driver trip history — ownership via current_driver_id(); optional p_tab (completed|cancelled) and p_trip_id; no full street addresses.';
