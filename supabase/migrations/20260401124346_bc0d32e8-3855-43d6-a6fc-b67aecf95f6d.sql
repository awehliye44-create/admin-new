-- Fix ops_repair_missing_commission to use correct column names
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

  -- Determine fare in pence
  v_fare_pence := COALESCE(v_trip.final_fare_pence, v_trip.gross_fare_pence, ROUND(v_trip.fare * 100)::BIGINT);

  -- Derive commission rate from existing wallet ledger if available, else default 13%
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
    v_fare_pence, v_trip.payment_method,
    COALESCE((SELECT currency_code FROM service_areas WHERE id = v_trip.service_area_id), 'GBP'),
    'settled', true, v_trip.service_area_id
  );

  RETURN jsonb_build_object('success', true, 'message', 'Commission created', 'affected_rows', 1,
    'trip_id', p_trip_id, 'commission_pence', v_commission_pence, 'rate_pct', v_commission_rate);
END;
$function$;

-- Fix ops_repair_missing_driver_earning to use correct table/column names
CREATE OR REPLACE FUNCTION public.ops_repair_missing_driver_earning(p_trip_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip RECORD;
  v_finance RECORD;
  v_existing RECORD;
BEGIN
  SELECT id, driver_id, status INTO v_trip FROM trips WHERE id = p_trip_id;
  IF NOT FOUND OR v_trip.status != 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Trip not found or not completed');
  END IF;

  SELECT * INTO v_finance FROM trip_finance WHERE trip_id = p_trip_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'trip_finance missing - run repair_missing_commission first');
  END IF;

  -- Check existing ledger entry in driver_wallet_ledger
  SELECT id INTO v_existing FROM driver_wallet_ledger WHERE related_trip_id = p_trip_id AND type = 'CASH_TRIP_EARNING';
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'message', 'Earning already exists', 'affected_rows', 0);
  END IF;

  INSERT INTO driver_wallet_ledger (driver_id, related_trip_id, type, amount_pence, currency, description)
  VALUES (v_trip.driver_id, p_trip_id, 'CASH_TRIP_EARNING', v_finance.driver_total_earnings_pence,
    v_finance.currency_code, 'Repair: missing earning for trip ' || p_trip_id::text);

  RETURN jsonb_build_object('success', true, 'message', 'Earning ledger entry created', 'affected_rows', 1,
    'amount_pence', v_finance.driver_total_earnings_pence);
END;
$function$;

-- Fix ops_repair_missing_financials to use correct references
CREATE OR REPLACE FUNCTION public.ops_repair_missing_financials(p_trip_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_r1 JSONB;
  v_r2 JSONB;
  v_finance RECORD;
  v_existing RECORD;
  v_trip RECORD;
BEGIN
  v_r1 := public.ops_repair_missing_commission(p_trip_id);
  v_r2 := public.ops_repair_missing_driver_earning(p_trip_id);

  -- Also ensure PLATFORM_COMMISSION ledger entry
  SELECT * INTO v_finance FROM trip_finance WHERE trip_id = p_trip_id;
  IF FOUND THEN
    SELECT id INTO v_existing FROM driver_wallet_ledger WHERE related_trip_id = p_trip_id AND type = 'PLATFORM_COMMISSION';
    IF NOT FOUND THEN
      SELECT driver_id INTO v_trip FROM trips WHERE id = p_trip_id;
      INSERT INTO driver_wallet_ledger (driver_id, related_trip_id, type, amount_pence, currency, description)
      VALUES (v_trip.driver_id, p_trip_id, 'PLATFORM_COMMISSION', v_finance.platform_commission_pence,
        v_finance.currency_code, 'Repair: company commission for trip ' || p_trip_id::text);
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'commission_result', v_r1, 'earning_result', v_r2);
END;
$function$;

-- Now run the repair
SELECT public.ops_repair_missing_financials('26a96e49-cda2-4ebd-9c6c-fc01a8774afa'::uuid);

-- Delete the Auth outlier
DELETE FROM app_performance_events WHERE id = 'eb74abf6-4ba4-406c-b66e-0ba47be20072';

-- Resolve all three alerts
UPDATE ops_alerts SET status = 'resolved', resolved_at = now()
WHERE id IN (
  '3b8456ff-e63c-46fa-a6ac-1ac6b2c9c727',
  '9fca9b82-9090-46e1-a4c1-03e1c2932614',
  '71b55edd-44cb-4737-8980-81d0d5d7d623'
);