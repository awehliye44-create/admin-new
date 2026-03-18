
-- Drop old functions with GBP default parameter, then recreate without defaults
DROP FUNCTION IF EXISTS public.record_cash_trip_completion(uuid, uuid, integer, integer, text);
DROP FUNCTION IF EXISTS public.record_digital_trip_payment(uuid, uuid, integer, integer, text, text);

-- Recreate record_cash_trip_completion: currency_code is mandatory, no GBP default
CREATE OR REPLACE FUNCTION public.record_cash_trip_completion(
  p_trip_id uuid,
  p_driver_id uuid,
  p_gross_fare_pence integer,
  p_commission_pence integer,
  p_currency_code text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ledger_id uuid;
BEGIN
  IF p_currency_code IS NULL OR p_currency_code = '' THEN
    RAISE EXCEPTION 'REGION_CURRENCY_UNRESOLVABLE: currency_code is required for cash trip completion. Resolve from Region.';
  END IF;

  UPDATE trips SET
    gross_fare_pence = p_gross_fare_pence,
    commission_pence = p_commission_pence,
    driver_net_pence = p_gross_fare_pence - p_commission_pence,
    payment_status = 'collected_cash'
  WHERE id = p_trip_id;

  INSERT INTO driver_ledger (
    driver_id, trip_id, entry_type, amount_pence, currency_code, description
  ) VALUES (
    p_driver_id, p_trip_id, 'CASH_COMMISSION_DEBT', -p_commission_pence, p_currency_code,
    'Commission owed from cash trip'
  )
  RETURNING id INTO v_ledger_id;

  RETURN v_ledger_id;
END;
$function$;

-- Recreate record_digital_trip_payment: currency_code is mandatory, no GBP default
CREATE OR REPLACE FUNCTION public.record_digital_trip_payment(
  p_trip_id uuid,
  p_driver_id uuid,
  p_gross_fare_pence integer,
  p_commission_pence integer,
  p_stripe_payment_intent_id text,
  p_currency_code text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_net_pence integer;
  v_ledger_id uuid;
BEGIN
  IF p_currency_code IS NULL OR p_currency_code = '' THEN
    RAISE EXCEPTION 'REGION_CURRENCY_UNRESOLVABLE: currency_code is required for digital trip payment. Resolve from Region.';
  END IF;

  v_driver_net_pence := p_gross_fare_pence - p_commission_pence;

  UPDATE trips SET
    gross_fare_pence = p_gross_fare_pence,
    commission_pence = p_commission_pence,
    driver_net_pence = v_driver_net_pence,
    payment_status = 'captured',
    stripe_payment_intent_id = p_stripe_payment_intent_id
  WHERE id = p_trip_id;

  INSERT INTO driver_ledger (
    driver_id, trip_id, entry_type, amount_pence, currency_code, description, reference_id
  ) VALUES (
    p_driver_id, p_trip_id, 'TRIP_EARNING_NET', v_driver_net_pence, p_currency_code,
    'Net earnings from digital payment trip', p_stripe_payment_intent_id
  )
  RETURNING id INTO v_ledger_id;

  RETURN v_ledger_id;
END;
$function$;
