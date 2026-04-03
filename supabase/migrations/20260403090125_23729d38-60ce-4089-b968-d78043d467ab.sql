
-- Fix: Replace ROW-level trigger with STATEMENT-level trigger
-- that recalculates ALL affected drivers after the statement completes
-- (ensuring all rows are visible in the sum)

-- First, create an improved trigger function that handles statement-level
CREATE OR REPLACE FUNCTION public.trigger_recalculate_wallet_statement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
BEGIN
  -- Recalculate wallet for all drivers that have wallet_ledger entries
  -- This is safe because the statement has fully committed its rows
  FOR r IN
    SELECT DISTINCT driver_id FROM driver_wallet_ledger
    WHERE driver_id IN (
      SELECT driver_id FROM driver_wallet_ledger
      ORDER BY created_at DESC LIMIT 100
    )
  LOOP
    PERFORM recalculate_driver_wallet(r.driver_id);
  END LOOP;
  RETURN NULL;
END;
$function$;

-- Drop old row-level trigger
DROP TRIGGER IF EXISTS wallet_ledger_recalc_trigger ON driver_wallet_ledger;

-- Create a better approach: use a transition-table-aware trigger
-- Actually, simplest fix: use AFTER ROW but fix recalculate to be deferred
-- The real issue is the function runs mid-transaction. Let's use a simpler approach:
-- Replace recalculate_driver_wallet to be called directly and also
-- create a row-level trigger that computes inline without a separate function call

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

  -- Calculate available balance excluding reporting-only types
  SELECT COALESCE(SUM(amount_pence), 0)
  INTO v_available
  FROM driver_wallet_ledger
  WHERE driver_id = v_driver_id
  AND type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING');

  -- Calculate lifetime earnings (only positive balance-affecting entries)
  SELECT COALESCE(SUM(amount_pence), 0)
  INTO v_lifetime
  FROM driver_wallet_ledger
  WHERE driver_id = v_driver_id
  AND amount_pence > 0
  AND type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING');

  -- Upsert wallet record
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

-- Recreate as AFTER ROW trigger (the inline version should now see the new row
-- since AFTER triggers run after the row is visible in the current transaction)
CREATE TRIGGER wallet_ledger_recalc_trigger
AFTER INSERT OR DELETE OR UPDATE ON driver_wallet_ledger
FOR EACH ROW
EXECUTE FUNCTION trigger_recalculate_wallet();

-- Also drop the unused statement-level function
DROP FUNCTION IF EXISTS trigger_recalculate_wallet_statement();
