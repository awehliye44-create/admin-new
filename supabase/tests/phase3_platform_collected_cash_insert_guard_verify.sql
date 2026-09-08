-- Draft verification. Do not run until the invariant is approved.
-- Creates the guard inside this transaction, checks source and current
-- counts, then ROLLBACK. Does not insert or update trips.

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

DO $$
DECLARE
  v_pc_cash int;
  v_dc_cash int;
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'reject_platform_collected_operational_cash';

  IF v_src IS NULL
     OR position('FINANCIAL_MODEL_VIOLATION' in v_src) = 0
     OR position('phase3_migration_only' in v_src) = 0
     OR position('DRIVER_COLLECTED' in v_src) > 0 THEN
    RAISE EXCEPTION 'guard body is not the platform-cash-only reject';
  END IF;

  SELECT count(*) INTO v_pc_cash
  FROM public.trips
  WHERE financial_model = 'PLATFORM_COLLECTED'
    AND lower(coalesce(payment_method, '')) = 'cash';
  SELECT count(*) INTO v_dc_cash
  FROM public.trips
  WHERE financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
    AND lower(coalesce(payment_method, '')) = 'cash';

  IF v_pc_cash <> 0 THEN
    RAISE EXCEPTION 'expected zero PLATFORM_COLLECTED cash trips, found %', v_pc_cash;
  END IF;
  IF v_dc_cash <> 38 THEN
    RAISE EXCEPTION 'historical driver-collected cash count changed: %', v_dc_cash;
  END IF;
END $$;

SELECT 'pass' AS status, 0 AS warning_reduction;
ROLLBACK;
