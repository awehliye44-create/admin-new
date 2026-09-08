-- Draft: Corporate suspension booking guard + digital-only invoice denial.
-- INSERT only. Does not update corporate_accounts, trips, or invoice tables.
-- Does not depend on get_corporate_allowed_payment_methods.

CREATE OR REPLACE FUNCTION public.corporate_new_booking_guard_decision(
  p_account_found boolean,
  p_status text,
  p_payment_method text,
  p_payment_type text,
  p_original_payment_method text
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_token text;
  v_raw text;
BEGIN
  IF NOT COALESCE(p_account_found, false) THEN
    RAISE EXCEPTION 'CORPORATE_ACCOUNT_NOT_ACTIVE'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_status = 'suspended' THEN
    RAISE EXCEPTION 'CORPORATE_ACCOUNT_SUSPENDED'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Exact active token only. inactive / pending / empty fail closed.
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'CORPORATE_ACCOUNT_NOT_ACTIVE'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Corporate card/wallet inserts always stamp payment_method before the row
  -- exists. A blank method is not a required step, and AFTER INSERT dispatch
  -- offers corporate pending/searching rows without reading payment_method.
  IF btrim(coalesce(p_payment_method, '')) = '' THEN
    RAISE EXCEPTION 'CORPORATE_PAYMENT_METHOD_REQUIRED'
      USING ERRCODE = 'check_violation';
  END IF;

  FOREACH v_raw IN ARRAY ARRAY[
    p_payment_method,
    p_payment_type,
    p_original_payment_method
  ]
  LOOP
    v_token := replace(lower(btrim(coalesce(v_raw, ''))), '-', '_');
    IF v_token IN (
      'invoice',
      'corporate_account',
      'monthly_invoice',
      'account_invoice',
      'billed_invoice',
      'corporate_invoice'
    ) THEN
      RAISE EXCEPTION 'CORPORATE_INVOICE_PAYMENT_DISABLED'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.corporate_new_booking_guard_decision(boolean, text, text, text, text) IS
  'Corporate new-booking decision. Status active is the only allow. Suspended is CORPORATE_ACCOUNT_SUSPENDED. Invoice spellings are CORPORATE_INVOICE_PAYMENT_DISABLED. Does not consult payment toggles or financial_model.';

ALTER FUNCTION public.corporate_new_booking_guard_decision(boolean, text, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.corporate_new_booking_guard_decision(boolean, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.corporate_new_booking_guard_decision(boolean, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.corporate_new_booking_guard_decision(boolean, text, text, text, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.corporate_new_booking_guard_decision(boolean, text, text, text, text) FROM service_role;

CREATE OR REPLACE FUNCTION public.enforce_corporate_new_booking_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_found boolean := false;
BEGIN
  IF NEW.corporate_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT ca.status
    INTO v_status
  FROM public.corporate_accounts ca
  WHERE ca.id = NEW.corporate_account_id;

  v_found := FOUND;

  PERFORM public.corporate_new_booking_guard_decision(
    v_found,
    v_status,
    NEW.payment_method,
    NEW.payment_type,
    NEW.original_payment_method
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_corporate_new_booking_guard() IS
  'BEFORE INSERT only. Name sorts before enforce_corporate_payment_methods_trg and before trg_00_stamp_trip_financial_model_on_insert. BEFORE INSERT cannot reach AFTER INSERT dispatch. Does not use get_corporate_allowed_payment_methods.';

ALTER FUNCTION public.enforce_corporate_new_booking_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_corporate_new_booking_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.enforce_corporate_new_booking_guard() FROM anon;
REVOKE ALL ON FUNCTION public.enforce_corporate_new_booking_guard() FROM authenticated;
REVOKE ALL ON FUNCTION public.enforce_corporate_new_booking_guard() FROM service_role;

-- Alphabetically before enforce_corporate_payment_methods_trg (account < payment)
-- and before trg_00_stamp_trip_financial_model_on_insert / trg_01 cash guard.
-- BEFORE INSERT rejection aborts before tr_trips_dispatch_after_insert.
DROP TRIGGER IF EXISTS enforce_corporate_account_booking_guard_trg ON public.trips;
CREATE TRIGGER enforce_corporate_account_booking_guard_trg
  BEFORE INSERT ON public.trips
  FOR EACH ROW
  WHEN (NEW.corporate_account_id IS NOT NULL)
  EXECUTE FUNCTION public.enforce_corporate_new_booking_guard();

-- Repair scalar array concatenation. Never return INVOICE. Status stays on the trigger.
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

  IF acc.payment_card_enabled THEN
    methods := array_append(methods, 'CARD');
  END IF;
  IF acc.payment_apple_pay_enabled THEN
    methods := array_append(methods, 'APPLE_PAY');
  END IF;
  IF acc.payment_google_pay_enabled THEN
    methods := array_append(methods, 'GOOGLE_PAY');
  END IF;
  -- Invoice billing is not a Corporate booking method, even if a stale toggle is true.
  IF acc.payment_wallet_enabled AND COALESCE(acc.current_balance, 0) > 0 THEN
    methods := array_append(methods, 'WALLET');
  END IF;

  RETURN methods;
END;
$$;

COMMENT ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) IS
  'Digital methods only: CARD, APPLE_PAY, GOOGLE_PAY, WALLET when funded. Never INVOICE. Does not enforce account status.';

REVOKE ALL ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_corporate_allowed_payment_methods(uuid) TO service_role;
