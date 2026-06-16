
ALTER TABLE public.corporate_accounts
  ADD COLUMN IF NOT EXISTS payment_cash_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payment_card_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS payment_apple_pay_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS payment_google_pay_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS payment_invoice_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payment_wallet_enabled boolean NOT NULL DEFAULT true;

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

  IF acc.payment_cash_enabled THEN methods := methods || 'CASH'; END IF;
  IF acc.payment_card_enabled THEN methods := methods || 'CARD'; END IF;
  IF acc.payment_apple_pay_enabled THEN methods := methods || 'APPLE_PAY'; END IF;
  IF acc.payment_google_pay_enabled THEN methods := methods || 'GOOGLE_PAY'; END IF;
  IF acc.payment_invoice_enabled THEN methods := methods || 'INVOICE'; END IF;
  -- Wallet only effective if prepaid balance is positive
  IF acc.payment_wallet_enabled AND COALESCE(acc.current_balance, 0) > 0 THEN
    methods := methods || 'WALLET';
  END IF;

  RETURN methods;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enforce_corporate_payment_methods()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  allowed text[];
  pm text;
BEGIN
  IF NEW.corporate_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  pm := UPPER(COALESCE(NEW.payment_method, ''));
  IF pm = '' THEN
    RETURN NEW; -- payment method not chosen yet; allow
  END IF;

  allowed := public.get_corporate_allowed_payment_methods(NEW.corporate_account_id);

  IF NOT (pm = ANY(allowed)) THEN
    RAISE EXCEPTION 'Payment method % is not enabled for this corporate account. Allowed: %', pm, allowed
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_corporate_payment_methods_trg ON public.trips;
CREATE TRIGGER enforce_corporate_payment_methods_trg
  BEFORE INSERT OR UPDATE OF payment_method, corporate_account_id ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_corporate_payment_methods();
