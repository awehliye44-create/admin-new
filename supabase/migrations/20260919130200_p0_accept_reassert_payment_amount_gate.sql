-- P0 #1 gap close: re-assert payment amount gate after accept/fare lock.
-- Negotiation can raise final_customer_fare_pence above authorised hold after
-- Edge assertPaymentGate ran on pre-accept amounts.

DO $patch$
DECLARE
  v_def text;
  v_marker text :=
    E'  PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);\n\n  BEGIN\n    PERFORM public.record_booking_delivery(v_offer.trip_id, ''accepted'', p_driver_id, p_offer_id, ''postgres'',';
  v_inject text :=
$inj$
  PERFORM public.ensure_trip_stops_for_assignment(v_offer.trip_id);

  -- P0 #1: re-assert authorised hold covers locked customer payable after fare finalize.
  BEGIN
    PERFORM public.assert_payment_gate(v_offer.trip_id);
  EXCEPTION
    WHEN SQLSTATE 'P0001' THEN
      RAISE EXCEPTION '%', SQLERRM USING ERRCODE = 'P0001';
  END;

  BEGIN
    PERFORM public.record_booking_delivery(v_offer.trip_id, 'accepted', p_driver_id, p_offer_id, 'postgres',
$inj$;
BEGIN
  SELECT pg_get_functiondef('public.accept_ride_offer(uuid,uuid,boolean)'::regprocedure)
    INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'accept_ride_offer(uuid,uuid,boolean) missing';
  END IF;
  IF position('P0 #1: re-assert authorised hold' in v_def) > 0 THEN
    RAISE NOTICE 'accept_ride_offer already re-asserts payment gate';
    RETURN;
  END IF;
  IF position(v_marker in v_def) = 0 THEN
    RAISE EXCEPTION 'accept_ride_offer patch marker not found — abort';
  END IF;
  v_def := replace(v_def, v_marker, v_inject);
  EXECUTE v_def;
END;
$patch$;
