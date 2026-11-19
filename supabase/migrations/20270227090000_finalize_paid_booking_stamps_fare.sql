-- Driver app showed no fare on trips booked through finalize_paid_booking_session:
-- the trips INSERT omitted `fare`, so the column default (0) was stored and
-- trip hydration (`fare: trip.fare ?? display`) sent the driver a 0 fare.
-- Stamp `fare` from the same customer payable SOT as estimated_fare.
DO $mig$
DECLARE
  d text := pg_get_functiondef('public.finalize_paid_booking_session'::regproc);
  col_old text := 'vehicle_type_id, estimated_fare, estimated_total_pence, final_customer_fare_pence,';
  col_new text := 'vehicle_type_id, fare, estimated_fare, estimated_total_pence, final_customer_fare_pence,';
  val_old text := E'NULLIF(v_draft->>\'vehicle_type_id\',\'\')::uuid,\n    v_fare.customer_payable_pence::numeric / 100.0,';
  val_new text := E'NULLIF(v_draft->>\'vehicle_type_id\',\'\')::uuid,\n    v_fare.customer_payable_pence::numeric / 100.0,\n    v_fare.customer_payable_pence::numeric / 100.0,';
BEGIN
  IF position(col_old IN d) = 0 OR position(val_old IN d) = 0 THEN
    RAISE EXCEPTION 'finalize_paid_booking_session layout changed; fare stamp not applied';
  END IF;
  d := replace(replace(d, col_old, col_new), val_old, val_new);
  EXECUTE d;
END
$mig$;

-- Repair only live (not settled/terminal) trips that were created with fare = 0.
UPDATE public.trips
SET fare = final_customer_fare_pence::numeric / 100.0
WHERE COALESCE(fare, 0) = 0
  AND COALESCE(final_customer_fare_pence, 0) > 0
  AND status IN ('searching','scheduled','assigned','accepted','driver_assigned','en_route','driver_en_route','arrived','arrived_at_pickup','in_progress','on_trip');
