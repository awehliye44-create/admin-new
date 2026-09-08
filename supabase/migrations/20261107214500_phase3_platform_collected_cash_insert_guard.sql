-- ============================================================
-- Draft only. NOT APPLIED.
--
-- Reject new or newly introduced operational trips where
-- financial_model = PLATFORM_COLLECTED and payment_method = cash.
--
-- financial_model is null on the incoming INSERT and is stamped by
-- trg_00_stamp_trip_financial_model_on_insert. This guard is trg_01
-- so it runs after that stamp. A CHECK constraint is not used: it
-- would also reject unrelated updates of a historical terminal row.
--
-- DRIVER_COLLECTED_COMMISSION_WALLET + cash is not rejected here.
-- Historical rows are not rewritten. service_role is denied unless
-- the same transaction sets the documented migration override.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.reject_platform_collected_operational_cash()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  v_override text := current_setting('onecab.platform_collected_cash_override', true);
  v_old_terminal boolean;
BEGIN
  -- Explicit migration override only. No Edge, Corporate, Admin, or
  -- service_role application path may set this. Default deny.
  IF v_override = 'phase3_migration_only' THEN
    RETURN NEW;
  END IF;

  IF upper(coalesce(NEW.financial_model::text, '')) <> 'PLATFORM_COLLECTED'
     OR lower(coalesce(NEW.payment_method, '')) <> 'cash' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_old_terminal := lower(coalesce(OLD.status, '')) IN (
      'completed', 'cancelled', 'canceled', 'expired', 'no_show'
    );
    IF upper(coalesce(OLD.financial_model::text, '')) = 'PLATFORM_COLLECTED'
       AND lower(coalesce(OLD.payment_method, '')) = 'cash'
       AND v_old_terminal THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: PLATFORM_COLLECTED cash is no longer supported. ONECAB is digital-only.'
    USING ERRCODE = 'check_violation';
END;
$fn$;

COMMENT ON FUNCTION public.reject_platform_collected_operational_cash() IS
  'After financial_model stamp. Rejects PLATFORM_COLLECTED + cash. Allows DRIVER_COLLECTED cash. Allows unrelated updates of historical terminal rows already on that combination. Override only via onecab.platform_collected_cash_override=phase3_migration_only.';

REVOKE ALL ON FUNCTION public.reject_platform_collected_operational_cash() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_platform_collected_operational_cash() FROM anon;
REVOKE ALL ON FUNCTION public.reject_platform_collected_operational_cash() FROM authenticated;
REVOKE ALL ON FUNCTION public.reject_platform_collected_operational_cash() FROM service_role;

DROP TRIGGER IF EXISTS trg_01_reject_platform_collected_operational_cash ON public.trips;
CREATE TRIGGER trg_01_reject_platform_collected_operational_cash
  BEFORE INSERT ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_platform_collected_operational_cash();

DROP TRIGGER IF EXISTS trg_reject_platform_collected_operational_cash_upd ON public.trips;
CREATE TRIGGER trg_reject_platform_collected_operational_cash_upd
  BEFORE UPDATE ON public.trips
  FOR EACH ROW
  WHEN (
    upper(coalesce(NEW.financial_model::text, '')) = 'PLATFORM_COLLECTED'
    AND lower(coalesce(NEW.payment_method, '')) = 'cash'
  )
  EXECUTE FUNCTION public.reject_platform_collected_operational_cash();

COMMIT;
