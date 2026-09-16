-- Migration 20260916224500: block unpaid PLATFORM fare-increase apply at DB layer
-- + tighten customer INSERT on trip_change_requests (MK-260916-030).
-- Rollback: rollback/rollback_20260916224500_trip_change_payment_apply_guard.sql
BEGIN;

-- 1) BEFORE INSERT/UPDATE: cannot move to approved/applied with unpaid positive increase.
CREATE OR REPLACE FUNCTION public.enforce_trip_change_payment_before_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_committed int := 0;
  v_new int := 0;
  v_increase int := 0;
  v_model text;
BEGIN
  IF NEW.status IS DISTINCT FROM 'approved'
     AND NEW.status IS DISTINCT FROM 'applied' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = NEW.trip_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  v_model := upper(trim(COALESCE(v_trip.financial_model, '')));
  IF v_model IS DISTINCT FROM 'PLATFORM_COLLECTED' THEN
    RETURN NEW;
  END IF;

  v_committed := GREATEST(
    0,
    COALESCE(v_trip.final_customer_fare_pence, 0),
    COALESCE(v_trip.estimated_total_pence, 0),
    COALESCE(v_trip.locked_base_fare_pence, 0)
  );
  v_new := GREATEST(0, COALESCE(NEW.new_fare_pence, 0));
  v_increase := GREATEST(
    COALESCE(NEW.fare_delta_pence, 0),
    CASE WHEN v_new > 0 THEN GREATEST(0, v_new - v_committed) ELSE 0 END
  );

  IF v_increase > 0
     AND lower(COALESCE(NEW.payment_status, '')) IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'CUSTOMER_PAYMENT_INCREMENT_UNRESOLVED'
      USING ERRCODE = 'P0001',
            DETAIL = 'cannot apply fare-increasing modification without confirmed payment';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_trip_change_payment_before_apply ON public.trip_change_requests;
CREATE TRIGGER trg_trip_change_payment_before_apply
  BEFORE INSERT OR UPDATE OF status, payment_status, fare_delta_pence, new_fare_pence
  ON public.trip_change_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_trip_change_payment_before_apply();

REVOKE ALL ON FUNCTION public.enforce_trip_change_payment_before_apply() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_trip_change_payment_before_apply() TO service_role;

-- 2) Customer INSERT cannot self-confirm payment or jump to applied.
DROP POLICY IF EXISTS "Customers can create modification requests" ON public.trip_change_requests;
CREATE POLICY "Customers can create modification requests" ON public.trip_change_requests
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.trips t
    WHERE t.id = trip_change_requests.trip_id
      AND t.passenger_id IN (SELECT id FROM public.customers WHERE user_id = auth.uid())
      AND t.status = ANY (ARRAY[
        'accepted',
        'en_route_to_pickup',
        'arrived',
        'in_progress'
      ])
  )
  AND COALESCE(requested_by, 'customer') = 'customer'
  AND status IN (
    'payment_required',
    'payment_pending',
    'pending_driver_approval',
    'approved'
  )
  AND status IS DISTINCT FROM 'applied'
  AND status IS DISTINCT FROM 'payment_confirmed'
  AND lower(COALESCE(payment_status, 'not_required')) IN (
    'required',
    'not_required',
    'pending'
  )
  AND lower(COALESCE(payment_status, '')) IS DISTINCT FROM 'confirmed'
  AND (
    COALESCE(fare_delta_pence, 0) <= 0
    OR (
      status IN ('payment_required', 'payment_pending')
      AND lower(COALESCE(payment_status, '')) IN ('required', 'pending')
    )
  )
);

COMMIT;
