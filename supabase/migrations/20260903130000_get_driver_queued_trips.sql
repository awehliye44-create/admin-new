-- Phase 4: Authoritative queued stacked-trip list for the assigned driver.
-- Privacy-safe projection; order by stack_position then created_at.
-- Never returns customer live location.

CREATE OR REPLACE FUNCTION public.get_driver_queued_trips()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
  v_can_cancel boolean := true;
BEGIN
  SELECT d.id INTO v_driver_id
  FROM public.drivers d
  WHERE d.user_id = auth.uid()
  LIMIT 1;

  IF v_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_not_found' USING ERRCODE = 'P0001';
  END IF;

  -- Driver cancellation of queued stacked trips is allowed via stop-workflow
  -- cancel_queued_stacked (existing). Expose can_cancel for UI gating.
  v_can_cancel := true;

  RETURN COALESCE(
    (
      SELECT jsonb_agg(row_to_json(q)::jsonb ORDER BY q.queue_position, q.sort_at)
      FROM (
        SELECT
          t.id AS trip_id,
          t.id AS queue_entry_id,
          COALESCE(NULLIF(trim(t.trip_number::text), ''), substring(t.id::text, 1, 8)) AS public_trip_id,
          COALESCE(t.stack_position, 1) AS queue_position,
          t.status AS status,
          COALESCE(
            NULLIF(t.driver_net_pence, 0),
            NULLIF(t.driver_net_before_tip_pence, 0),
            NULLIF(t.accepted_driver_offer_fare_pence, 0)
          ) AS driver_net_pence,
          COALESCE(t.currency_code, t.offer_currency, 'GBP') AS currency_code,
          t.vehicle_type AS service_type,
          t.scheduled_at AS scheduled_pickup_at,
          left(COALESCE(NULLIF(btrim(t.pickup_address::text), ''), 'Pickup'), 160) AS pickup_summary,
          left(COALESCE(NULLIF(btrim(t.dropoff_address::text), ''), 'Drop-off'), 160) AS dropoff_summary,
          (COALESCE(t.total_stops, 0) > 2) AS has_multiple_stops,
          CASE
            WHEN lower(coalesce(t.payment_method, t.payment_type, '')) LIKE '%card%'
              OR lower(coalesce(t.payment_method, '')) = 'stripe'
              THEN 'card'
            WHEN lower(coalesce(t.payment_method, t.payment_type, '')) LIKE '%cash%'
              THEN 'cash'
            ELSE 'unknown'
          END AS payment_method,
          t.created_at AS assigned_at,
          t.created_at AS sort_at,
          v_can_cancel AS can_cancel,
          CASE
            WHEN v_can_cancel THEN 'Queued trip will be released for rematch. Your active trip is unchanged.'
            ELSE NULL
          END AS cancellation_consequence,
          t.pickup_latitude AS pickup_lat,
          t.pickup_longitude AS pickup_lng,
          t.dropoff_latitude AS dropoff_lat,
          t.dropoff_longitude AS dropoff_lng
        FROM public.trips t
        WHERE t.status = 'queued'
          AND (t.driver_id = v_driver_id OR t.confirmed_driver_id = v_driver_id)
        ORDER BY t.stack_position ASC NULLS LAST,
                 t.created_at ASC
      ) q
    ),
    '[]'::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_driver_queued_trips() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_driver_queued_trips() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_queued_trips() TO service_role;

COMMENT ON FUNCTION public.get_driver_queued_trips() IS
  'Privacy-safe ordered queued stacked trips for the authenticated driver. No customer live location.';
