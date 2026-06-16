-- Phase 1E-A: Align driver_wallets cache formula with ledger SSOT.
-- Matches driver_financial_summary.balance_totals and onecabFinanceLedger REPORTING_ONLY types.

CREATE OR REPLACE FUNCTION public.recalculate_driver_wallet(p_driver_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_available integer;
  v_lifetime integer;
BEGIN
  SELECT COALESCE(SUM(amount_pence), 0)
  INTO v_available
  FROM driver_wallet_ledger
  WHERE driver_id = p_driver_id
    AND type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING', 'COMMISSION_RECOVERED');

  SELECT COALESCE(SUM(amount_pence), 0)
  INTO v_lifetime
  FROM driver_wallet_ledger
  WHERE driver_id = p_driver_id
    AND amount_pence > 0
    AND type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING', 'COMMISSION_RECOVERED');

  INSERT INTO driver_wallets (driver_id, available_pence, pending_pence, lifetime_earned_pence, updated_at)
  VALUES (p_driver_id, v_available, 0, v_lifetime, now())
  ON CONFLICT (driver_id)
  DO UPDATE SET
    available_pence = v_available,
    lifetime_earned_pence = v_lifetime,
    updated_at = now();
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_recalculate_wallet()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_driver_id uuid;
  v_available bigint;
  v_lifetime bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_driver_id := OLD.driver_id;
  ELSE
    v_driver_id := NEW.driver_id;
  END IF;

  SELECT COALESCE(SUM(amount_pence), 0)
  INTO v_available
  FROM driver_wallet_ledger
  WHERE driver_id = v_driver_id
    AND type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING', 'COMMISSION_RECOVERED');

  SELECT COALESCE(SUM(amount_pence), 0)
  INTO v_lifetime
  FROM driver_wallet_ledger
  WHERE driver_id = v_driver_id
    AND amount_pence > 0
    AND type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING', 'COMMISSION_RECOVERED');

  INSERT INTO driver_wallets (driver_id, available_pence, pending_pence, lifetime_earned_pence, updated_at)
  VALUES (v_driver_id, v_available, 0, v_lifetime, now())
  ON CONFLICT (driver_id)
  DO UPDATE SET
    available_pence = v_available,
    lifetime_earned_pence = v_lifetime,
    updated_at = now();

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.recalculate_driver_wallet(uuid) IS
  'Rebuild driver_wallets from ledger SSOT — excludes PLATFORM_COMMISSION, CASH_TRIP_EARNING, COMMISSION_RECOVERED.';

-- Phase 1E-B: one-time cache rebuild for all drivers with ledger activity.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT driver_id FROM driver_wallet_ledger
  LOOP
    PERFORM recalculate_driver_wallet(r.driver_id);
  END LOOP;
END $$;
