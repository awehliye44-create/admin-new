-- Fix the new records
UPDATE trip_finance SET payment_method = 'CASH' WHERE payment_method = 'cash';

-- Fix the repair function to use uppercase CASH
CREATE OR REPLACE FUNCTION public.ops_repair_missing_commission(p_trip_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_existing RECORD;
  v_fare_pence BIGINT;
  v_commission_rate NUMERIC;
  v_commission_pence BIGINT;
  v_driver_earning BIGINT;
BEGIN
  SELECT id, driver_id, gross_fare_pence, final_fare_pence, fare, payment_method, status, service_area_id
    INTO v_trip FROM trips WHERE id = p_trip_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Trip not found');
  END IF;
  IF v_trip.status != 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Trip is not completed');
  END IF;

  SELECT id INTO v_existing FROM trip_finance WHERE trip_id = p_trip_id;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'message', 'Commission already exists', 'affected_rows', 0);
  END IF;

  v_fare_pence := COALESCE(v_trip.final_fare_pence, v_trip.gross_fare_pence, ROUND(v_trip.fare * 100)::BIGINT);

  SELECT CASE WHEN v_fare_pence > 0 THEN ROUND(ABS(dwl.amount_pence)::NUMERIC / v_fare_pence * 100, 2) ELSE 13 END
    INTO v_commission_rate
    FROM driver_wallet_ledger dwl
    WHERE dwl.related_trip_id = p_trip_id AND dwl.type = 'PLATFORM_COMMISSION'
    LIMIT 1;
  v_commission_rate := COALESCE(v_commission_rate, 13);

  v_commission_pence := ROUND(v_fare_pence * v_commission_rate / 100);
  v_driver_earning := v_fare_pence - v_commission_pence;

  INSERT INTO trip_finance (
    trip_id, driver_id, base_fare_pence, commissionable_subtotal_pence,
    commission_rate_pct, platform_commission_pence,
    driver_net_before_tip_pence, driver_total_earnings_pence,
    final_trip_total_pence, payment_method, currency_code,
    financial_status, is_financially_countable, service_area_id
  ) VALUES (
    p_trip_id, v_trip.driver_id, v_fare_pence, v_fare_pence,
    v_commission_rate, v_commission_pence,
    v_driver_earning, v_driver_earning,
    v_fare_pence, UPPER(COALESCE(v_trip.payment_method, 'CASH')),
    COALESCE((SELECT currency_code FROM service_areas WHERE id = v_trip.service_area_id), 'GBP'),
    'settled', true, v_trip.service_area_id
  );

  RETURN jsonb_build_object('success', true, 'message', 'Commission created', 'affected_rows', 1,
    'trip_id', p_trip_id, 'commission_pence', v_commission_pence, 'rate_pct', v_commission_rate);
END;
$function$;