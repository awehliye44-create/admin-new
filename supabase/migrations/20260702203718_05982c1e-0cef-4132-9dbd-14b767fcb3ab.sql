
-- Remove cash column from service area payment methods
ALTER TABLE public.service_area_payment_methods DROP COLUMN IF EXISTS cash_enabled;

-- Remove cash toggle from corporate accounts
ALTER TABLE public.corporate_accounts DROP COLUMN IF EXISTS payment_cash_enabled;

-- Rebuild the corporate allowed methods function without CASH
CREATE OR REPLACE FUNCTION public.get_corporate_allowed_payment_methods(p_account_id uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  acc public.corporate_accounts%ROWTYPE;
  methods text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO acc FROM public.corporate_accounts WHERE id = p_account_id;
  IF NOT FOUND THEN
    RETURN methods;
  END IF;

  IF acc.payment_card_enabled THEN methods := methods || 'CARD'; END IF;
  IF acc.payment_apple_pay_enabled THEN methods := methods || 'APPLE_PAY'; END IF;
  IF acc.payment_google_pay_enabled THEN methods := methods || 'GOOGLE_PAY'; END IF;
  IF acc.payment_invoice_enabled THEN methods := methods || 'INVOICE'; END IF;
  IF acc.payment_wallet_enabled AND COALESCE(acc.current_balance, 0) > 0 THEN
    methods := methods || 'WALLET';
  END IF;

  RETURN methods;
END;
$$;

-- Global block: no trip can be created with CASH payment method
CREATE OR REPLACE FUNCTION public.block_cash_payment_method()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF UPPER(COALESCE(NEW.payment_method, '')) = 'CASH' THEN
    RAISE EXCEPTION 'Cash payment method is no longer supported. ONECAB is a digital-only platform.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS block_cash_payment_method_trg ON public.trips;
CREATE TRIGGER block_cash_payment_method_trg
  BEFORE INSERT OR UPDATE OF payment_method ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.block_cash_payment_method();
