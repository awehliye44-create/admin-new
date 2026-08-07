-- My Trips Cancelled tab: include missed / lost ride offers for the authenticated driver.
-- Root cause: list_driver_own_trip_history only returned trips.driver_id / confirmed /
-- previous / cancelled_driver_ids. Offers revoked because another driver accepted never
-- attach the losing driver to trips, so "Accepted by another driver" was invisible.
-- Source of truth for those outcomes: public.ride_offers (status + revoked_reason).

CREATE OR REPLACE FUNCTION public.list_driver_own_trip_history(
  p_limit integer DEFAULT 50,
  p_before timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_tab text DEFAULT NULL::text,
  p_trip_id uuid DEFAULT NULL::uuid
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
          deduped.id,
          deduped.public_trip_ref,
          deduped.backend_status,
          deduped.cancellation_reason_code,
          deduped.cancelled_by,
          deduped.cancelled_by_role,
          deduped.financial_outcome,
          deduped.service_area_label,
          deduped.pickup_area_label,
          deduped.dropoff_area_label,
          deduped.total_stops,
          deduped.requested_at,
          deduped.pickup_at,
          deduped.dropoff_at,
          deduped.cancelled_at,
          deduped.closed_at,
          deduped.payable_amount_pence,
          deduped.has_card_payment_record,
          deduped.payment_method,
          deduped.booking_type,
          deduped.vehicle_type,
          deduped.sort_at,
          deduped.is_active
        FROM (
          SELECT DISTINCT ON (combined.id)
            combined.id,
            combined.public_trip_ref,
            combined.backend_status,
            combined.cancellation_reason_code,
            combined.cancelled_by,
            combined.cancelled_by_role,
            combined.financial_outcome,
            combined.service_area_label,
            combined.pickup_area_label,
            combined.dropoff_area_label,
            combined.total_stops,
            combined.requested_at,
            combined.pickup_at,
            combined.dropoff_at,
            combined.cancelled_at,
            combined.closed_at,
            combined.payable_amount_pence,
            combined.has_card_payment_record,
            combined.payment_method,
            combined.booking_type,
            combined.vehicle_type,
            combined.sort_at,
            combined.is_active
          FROM (
            -- A) Terminal trips this driver owned / was cancelled from
            SELECT
              t.id,
              COALESCE(t.trip_number, t.trip_code, left(t.id::text, 8)) AS public_trip_ref,
              t.status AS backend_status,
              COALESCE(t.cancellation_reason, t.cancel_reason, t.cancelled_by_role) AS cancellation_reason_code,
              t.cancelled_by,
              t.cancelled_by_role,
              t.financial_outcome,
              sa.name AS service_area_label,
              sa.name AS pickup_area_label,
              sa.name AS dropoff_area_label,
              COALESCE(t.total_stops, 1) AS total_stops,
              t.created_at AS requested_at,
              t.started_at AS pickup_at,
              t.completed_at AS dropoff_at,
              t.cancelled_at,
              CASE
                WHEN lower(COALESCE(t.status, '')) = 'no_show'
                  THEN COALESCE(t.completed_at, t.cancelled_at, t.updated_at)
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
              false AS is_active,
              1 AS source_pri
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

            UNION ALL

            -- B) Missed / lost offers (never assigned to this driver on trips)
            SELECT
              ro.trip_id AS id,
              COALESCE(t.trip_number, t.trip_code, left(ro.trip_id::text, 8)) AS public_trip_ref,
              CASE
                WHEN lower(ro.status) = 'declined' THEN 'driver_declined'
                WHEN lower(ro.status) = 'expired' THEN 'offer_expired'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'another_offer_accepted'
                  THEN 'cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
                  'passenger_cancelled', 'trip_cancelled', 'trip_terminal_cancel'
                ) THEN 'cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
                  'cancelled_by_admin', 'admin_cancelled'
                ) THEN 'cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'trip_expired_no_driver'
                  THEN 'offer_expired'
                ELSE 'cancelled'
              END AS backend_status,
              CASE
                WHEN lower(ro.status) = 'declined' THEN 'driver_declined'
                WHEN lower(ro.status) = 'expired' THEN 'offer_expired'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'another_offer_accepted'
                  THEN 'accepted_by_another_driver'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'passenger_cancelled'
                  THEN 'passenger_cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
                  'trip_cancelled', 'trip_terminal_cancel'
                ) THEN 'passenger_cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) IN (
                  'cancelled_by_admin', 'admin_cancelled'
                ) THEN 'admin_cancelled'
                WHEN lower(COALESCE(ro.revoked_reason, '')) = 'trip_expired_no_driver'
                  THEN 'offer_expired'
                ELSE COALESCE(nullif(lower(ro.revoked_reason), ''), 'cancelled')
              END AS cancellation_reason_code,
              NULL::text AS cancelled_by,
              NULL::text AS cancelled_by_role,
              NULL::text AS financial_outcome,
              sa.name AS service_area_label,
              sa.name AS pickup_area_label,
              sa.name AS dropoff_area_label,
              COALESCE(t.total_stops, 1) AS total_stops,
              COALESCE(ro.offered_at, ro.created_at) AS requested_at,
              NULL::timestamptz AS pickup_at,
              NULL::timestamptz AS dropoff_at,
              COALESCE(ro.responded_at, ro.updated_at, ro.expires_at, ro.created_at) AS cancelled_at,
              NULL::timestamptz AS closed_at,
              COALESCE(
                ro.driver_offer_fare,
                NULLIF(ro.offer_snapshot->>'driver_net_fare_pence', '')::int,
                NULLIF(ro.offer_snapshot->>'driver_earnings_pence', '')::int,
                NULLIF(ro.offer_snapshot->>'driver_net_preview_pence', '')::int
              ) AS payable_amount_pence,
              false AS has_card_payment_record,
              t.payment_method,
              t.booking_type,
              t.vehicle_type,
              COALESCE(ro.responded_at, ro.updated_at, ro.expires_at, ro.created_at) AS sort_at,
              false AS is_active,
              2 AS source_pri
            FROM public.ride_offers ro
            INNER JOIN public.trips t ON t.id = ro.trip_id
            LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
            WHERE ro.driver_id = v_driver_id
              AND (
                p_trip_id IS NULL
                OR ro.trip_id = p_trip_id
              )
              AND (
                v_tab IS NULL
                OR v_tab = 'cancelled'
              )
              AND lower(COALESCE(ro.status, '')) IN ('declined', 'expired', 'revoked')
              AND (
                lower(ro.status) IN ('declined', 'expired')
                OR lower(COALESCE(ro.revoked_reason, '')) IN (
                  'another_offer_accepted',
                  'passenger_cancelled',
                  'trip_cancelled',
                  'trip_terminal_cancel',
                  'cancelled_by_admin',
                  'admin_cancelled',
                  'trip_expired_no_driver'
                )
              )
              AND NOT (
                t.driver_id = v_driver_id
                OR t.confirmed_driver_id = v_driver_id
                OR t.previous_driver_id = v_driver_id
                OR (t.cancelled_driver_ids IS NOT NULL AND t.cancelled_driver_ids @> ARRAY[v_driver_id])
              )
              AND (p_before IS NULL OR COALESCE(
                ro.responded_at, ro.updated_at, ro.expires_at, ro.created_at
              ) < p_before)
          ) combined
          ORDER BY combined.id, combined.source_pri ASC, combined.sort_at DESC
        ) deduped
        ORDER BY deduped.sort_at DESC
        LIMIT CASE WHEN p_trip_id IS NOT NULL THEN 1 ELSE v_limit END
      ) row
    ),
    '[]'::jsonb
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.list_driver_own_trip_history(integer, timestamptz, text, uuid)
  TO authenticated, service_role;
