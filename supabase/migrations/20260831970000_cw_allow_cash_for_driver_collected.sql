-- P0: Payment validation from Service Area financial_model only.
-- PLATFORM_COLLECTED → keep digital-only (block cash).
-- DRIVER_COLLECTED_COMMISSION_WALLET + commission_wallet_enabled
--   → allow payment_method = cash (customer pays driver upfront).
-- Cast enums to text before COALESCE with '' (empty string is not a valid enum).

CREATE OR REPLACE FUNCTION public.block_cash_payment_method()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_financial_model text;
  v_cw_enabled boolean;
BEGIN
  IF UPPER(COALESCE(NEW.payment_method, '')) <> 'CASH' THEN
    RETURN NEW;
  END IF;

  -- Trip snapshot already marks CW driver-collected workflow.
  IF UPPER(COALESCE(NEW.financial_model::text, '')) = 'DRIVER_COLLECTED_COMMISSION_WALLET'
     AND COALESCE(NEW.commission_wallet_enabled, false) IS TRUE THEN
    RETURN NEW;
  END IF;

  -- Canonical Service Area financial_model (insert paths that set SA before snapshot).
  IF NEW.service_area_id IS NOT NULL THEN
    SELECT sa.financial_model::text, sa.commission_wallet_enabled
      INTO v_financial_model, v_cw_enabled
    FROM public.service_areas sa
    WHERE sa.id = NEW.service_area_id;

    IF UPPER(COALESCE(v_financial_model, '')) = 'DRIVER_COLLECTED_COMMISSION_WALLET'
       AND COALESCE(v_cw_enabled, false) IS TRUE THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'Cash payment method is no longer supported. ONECAB is a digital-only platform.'
    USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION public.block_cash_payment_method() IS
  'Blocks cash on PLATFORM_COLLECTED trips; allows cash when SA/trip is DRIVER_COLLECTED_COMMISSION_WALLET.';
