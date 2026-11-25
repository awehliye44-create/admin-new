-- Rollback #92L tip-eligibility fields on customer_get_my_trip.
-- Restores the column set from 20270227180000_booking_ownership_role_isolation.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.customer_get_my_trip(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_customer_id uuid;
  v_row jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_trip_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.id INTO v_customer_id
  FROM public.customers c
  WHERE c.user_id = auth.uid()
  LIMIT 1;

  IF v_customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT to_jsonb(t) INTO v_row
  FROM (
    SELECT
      tr.id,
      tr.trip_code,
      tr.status,
      tr.pickup_address,
      tr.dropoff_address,
      tr.pickup_latitude,
      tr.pickup_longitude,
      tr.dropoff_latitude,
      tr.dropoff_longitude,
      tr.stops,
      tr.scheduled_at,
      tr.is_scheduled,
      tr.dispatch_mode,
      tr.scheduled_status,
      tr.scheduled_broadcast_at,
      tr.scheduled_convert_at,
      tr.created_at,
      tr.completed_at,
      tr.cancelled_at,
      tr.cancelled_by,
      tr.cancel_reason,
      tr.financial_outcome,
      tr.arrival_cancellation_applied,
      tr.cancellation_fee_pence,
      tr.no_show_charge_pence,
      tr.fare,
      tr.final_fare_pence,
      tr.final_customer_fare_pence,
      tr.capture_amount_pence,
      tr.outstanding_balance_pence,
      tr.payment_status,
      tr.payment_hold_status,
      tr.tip_pence,
      tr.tip_amount_pence,
      tr.tip_window_expires_at,
      tr.tip_window_closed_at,
      tr.refund_amount_pence,
      tr.estimated_fare,
      tr.estimated_total_pence,
      tr.payment_method,
      tr.vehicle_type_id,
      tr.confirmed_driver_id,
      tr.started_at,
      tr.arrived_at,
      tr.invoice_email_sent_at,
      tr.invoice_email_status,
      tr.special_instructions,
      tr.driver_id,
      tr.passenger_id
    FROM public.trips tr
    WHERE tr.id = p_trip_id
      AND tr.passenger_id = v_customer_id
    LIMIT 1
  ) t;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.customer_get_my_trip(uuid) IS
  '#57 Customer trip detail — passenger_id ownership only (SECURITY DEFINER).';

REVOKE ALL ON FUNCTION public.customer_get_my_trip(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_get_my_trip(uuid) TO authenticated, service_role;

COMMIT;
