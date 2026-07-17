-- Phase 6 gap-close pass 2: surface INSUFFICIENT_COMMISSION_WALLET_BALANCE on reserve failure.

CREATE OR REPLACE FUNCTION public.trg_commission_wallet_on_trip_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_code text;
  v_err text;
BEGIN
  -- Release when assignment cleared (UPDATE only).
  IF TG_OP = 'UPDATE'
     AND OLD.driver_id IS NOT NULL
     AND (NEW.driver_id IS NULL OR NEW.driver_id IS DISTINCT FROM OLD.driver_id) THEN
    v_result := public.release_driver_commission_wallet(
      OLD.driver_id,
      NEW.id,
      CASE
        WHEN NEW.driver_id IS NULL THEN 'assignment_cleared'
        ELSE 'driver_reassigned'
      END
    );
    IF COALESCE(v_result->>'ok', 'false') <> 'true' THEN
      RAISE WARNING 'commission wallet release failed: %', v_result;
    END IF;
  END IF;

  -- Reserve on new assignment (INSERT with driver_id, accept / stacked / reassign UPDATE).
  IF NEW.driver_id IS NOT NULL
     AND (
       TG_OP = 'INSERT'
       OR NEW.driver_id IS DISTINCT FROM OLD.driver_id
     ) THEN
    v_result := public.reserve_driver_commission_wallet(NEW.driver_id, NEW.id);
    IF COALESCE(v_result->>'ok', 'false') <> 'true' THEN
      IF COALESCE(v_result->>'skipped', 'false') = 'true'
         OR COALESCE(v_result->>'code', '') IN ('WALLET_GATE_OFF', 'ZERO_RESERVE') THEN
        RETURN NEW;
      END IF;
      v_code := COALESCE(NULLIF(v_result->>'code', ''), 'COMMISSION_RESERVE_FAILED');
      v_err := COALESCE(v_result->>'error', v_code);
      -- Prefix with code so edge mappers (accept-offer / admin assign) can classify without parsing prose.
      RAISE EXCEPTION '%: %', v_code, v_err
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_commission_wallet_on_trip_assignment() IS
  'Phase 6: reserve/release on trips.driver_id INSERT/UPDATE. Reserve failures raise CODE: message (e.g. INSUFFICIENT_COMMISSION_WALLET_BALANCE).';
