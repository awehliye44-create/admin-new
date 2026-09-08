-- Emergency rollback for 20261108200000.
-- Drops only this batch's trigger and functions, then restores the exact
-- pre-change get_corporate_allowed_payment_methods body and ACL.
-- Does not update corporate_accounts, trips, or invoice tables.

BEGIN;

DROP TRIGGER IF EXISTS enforce_corporate_account_booking_guard_trg ON public.trips;
DROP FUNCTION IF EXISTS public.enforce_corporate_new_booking_guard();
DROP FUNCTION IF EXISTS public.corporate_new_booking_guard_decision(boolean, text, text, text, text);

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

COMMENT ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) IS NULL;

REVOKE ALL ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) TO service_role;

COMMIT;
