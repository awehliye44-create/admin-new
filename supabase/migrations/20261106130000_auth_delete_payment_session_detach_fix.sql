-- Fix Auth-delete detach guard: payment_sessions has no amount_pence column.
-- 20261106120000 referenced a non-existent amount column and aborted SET NULL,
-- so Auth user delete still failed.
--
-- Pure customer_id nulling (FK ON DELETE SET NULL) is allowed; any other column
-- change on a DRIVER_COLLECTED session still hits FINANCIAL_MODEL_VIOLATION.

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_payment_session_financial_model()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_model text;
BEGIN
  -- Detach-only cascade from customers/auth delete — preserve history, do not re-gate.
  IF TG_OP = 'UPDATE'
     AND NEW.customer_id IS NULL
     AND OLD.customer_id IS NOT NULL
     AND (to_jsonb(NEW) - 'customer_id') = (to_jsonb(OLD) - 'customer_id')
  THEN
    RETURN NEW;
  END IF;

  v_model := NULL;
  IF NEW.trip_id IS NOT NULL THEN
    SELECT financial_model::text INTO v_model FROM public.trips WHERE id = NEW.trip_id;
  ELSIF NEW.service_area_id IS NOT NULL THEN
    -- Quote-time preauth has no trip_id yet. SA stamp still forbids pipeline 1.
    SELECT financial_model::text INTO v_model FROM public.service_areas WHERE id = NEW.service_area_id;
  END IF;

  IF v_model = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: Payment Session forbidden on DRIVER_COLLECTED_COMMISSION_WALLET'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
     AND (
       COALESCE(NEW.captured_amount_pence, 0) > 0
       OR UPPER(COALESCE(NEW.provider_state, '')) IN ('CAPTURED', 'COMPLETED', 'REFUNDED', 'RELEASED')
     ) THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: platform capture/refund/release forbidden on DRIVER_COLLECTED_COMMISSION_WALLET'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_payment_session_financial_model() IS
  'Reject Payment Session writes on DRIVER_COLLECTED. Allows customer_id SET NULL on Auth/customer delete so payment history is detached, not erased.';

COMMIT;
