-- Allow Auth/customer delete to detach payment_sessions.customer_id (ON DELETE SET NULL)
-- without re-firing the DRIVER_COLLECTED Payment Session create gate.
--
-- Root cause: deleting auth.users CASCADE-deletes customers, then payment_sessions
-- SET NULL customer_id. That UPDATE hit enforce_payment_session_financial_model and
-- raised FINANCIAL_MODEL_VIOLATION for DRIVER_COLLECTED service areas — blocking
-- Admin Auth user delete while leaving the user stuck.
--
-- Payments are NOT deleted by Auth user delete:
--   payment_sessions rows remain (customer_id nulled)
--   provider captures/refunds are unchanged
-- This only unblocks detach-on-delete. Inserting/updating a Payment Session onto a
-- DRIVER_COLLECTED trip/SA remains forbidden.

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
     AND NEW.trip_id IS NOT DISTINCT FROM OLD.trip_id
     AND NEW.service_area_id IS NOT DISTINCT FROM OLD.service_area_id
     AND NEW.captured_amount_pence IS NOT DISTINCT FROM OLD.captured_amount_pence
     AND COALESCE(NEW.provider_state, '') IS NOT DISTINCT FROM COALESCE(OLD.provider_state, '')
     AND COALESCE(NEW.amount_pence, 0) IS NOT DISTINCT FROM COALESCE(OLD.amount_pence, 0)
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
