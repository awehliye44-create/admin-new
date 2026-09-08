-- Rollback later cash retirement. Restores the original five-argument writer
-- and the pre-retirement ACL. Does not remove any grant from postgres.
-- Does not rewrite historical cash trips.

BEGIN;

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
AS $fn$
DECLARE
  v_ledger_id uuid;
  v_payment_method text;
BEGIN
  -- Verify this is a historical cash trip (payment_method already set to 'cash')
  SELECT payment_method INTO v_payment_method
  FROM trips WHERE id = p_trip_id;

  -- Safety check: only allow for existing cash trips (historical legacy)
  IF v_payment_method IS NULL OR UPPER(v_payment_method) != 'CASH' THEN
    RAISE EXCEPTION 'Cash trip completion is only allowed for historical legacy cash trips.'
      USING ERRCODE = 'check_violation';
  END IF;

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
$fn$;

COMMENT ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) IS NULL;

GRANT EXECUTE ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) TO service_role;

COMMIT;
