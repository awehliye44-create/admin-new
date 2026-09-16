-- Rollback 20260916224500
BEGIN;

DROP TRIGGER IF EXISTS trg_trip_change_payment_before_apply ON public.trip_change_requests;
DROP FUNCTION IF EXISTS public.enforce_trip_change_payment_before_apply();

DROP POLICY IF EXISTS "Customers can create modification requests" ON public.trip_change_requests;
CREATE POLICY "Customers can create modification requests" ON public.trip_change_requests
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.trips t
    WHERE t.id = trip_change_requests.trip_id
      AND t.passenger_id IN (SELECT id FROM public.customers WHERE user_id = auth.uid())
      AND t.status = ANY (ARRAY['accepted','en_route_to_pickup','arrived','in_progress'])
  )
);

COMMIT;
