-- Draft verification only. One transaction. Always ROLLBACK.
-- Installs the drafted functions, attaches the real trigger function to a
-- temporary table, and never inserts into public.trips.
-- Does not update corporate_accounts or create payment/invoice/dispatch rows.

BEGIN;

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

  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'CORPORATE_ACCOUNT_NOT_ACTIVE'
      USING ERRCODE = 'check_violation';
  END IF;

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

CREATE TEMP TABLE corporate_booking_guard_probe (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corporate_account_id uuid,
  payment_method text,
  payment_type text,
  original_payment_method text
) ON COMMIT DROP;

CREATE TRIGGER enforce_corporate_account_booking_guard_trg
  BEFORE INSERT ON corporate_booking_guard_probe
  FOR EACH ROW
  WHEN (NEW.corporate_account_id IS NOT NULL)
  EXECUTE FUNCTION public.enforce_corporate_new_booking_guard();

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
  IF acc.payment_wallet_enabled AND COALESCE(acc.current_balance, 0) > 0 THEN
    methods := array_append(methods, 'WALLET');
  END IF;

  RETURN methods;
END;
$$;

DO $$
DECLARE
  v_suspended uuid;
  v_err text;
  v_methods text[];
  v_token text;
  v_accounts_before int;
  v_trips_before int;
  v_invoices_before int;
  v_probe_rows int;
BEGIN
  SELECT count(*)::int INTO v_accounts_before FROM public.corporate_accounts;
  SELECT count(*)::int INTO v_trips_before FROM public.trips WHERE corporate_account_id IS NOT NULL;
  SELECT count(*)::int INTO v_invoices_before FROM public.corporate_invoices;

  SELECT id INTO v_suspended
  FROM public.corporate_accounts
  WHERE status = 'suspended'
  LIMIT 1;

  IF v_suspended IS NULL THEN
    RAISE EXCEPTION 'verify_failed: expected a suspended corporate account';
  END IF;

  BEGIN
    INSERT INTO corporate_booking_guard_probe (
      corporate_account_id, payment_method, payment_type, original_payment_method
    ) VALUES (v_suspended, 'card', 'card', 'card');
    RAISE EXCEPTION 'verify_failed: suspended insert was allowed';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      IF v_err IS DISTINCT FROM 'CORPORATE_ACCOUNT_SUSPENDED' THEN
        RAISE EXCEPTION 'verify_failed: suspended error was %', v_err;
      END IF;
  END;

  SELECT count(*)::int INTO v_probe_rows FROM corporate_booking_guard_probe;
  IF v_probe_rows <> 0 THEN
    RAISE EXCEPTION 'verify_failed: temp probe retained a suspended row';
  END IF;

  BEGIN
    INSERT INTO corporate_booking_guard_probe (
      corporate_account_id, payment_method, payment_type, original_payment_method
    ) VALUES ('00000000-0000-0000-0000-000000000000', 'card', 'card', 'card');
    RAISE EXCEPTION 'verify_failed: missing account insert was allowed';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      IF v_err IS DISTINCT FROM 'CORPORATE_ACCOUNT_NOT_ACTIVE' THEN
        RAISE EXCEPTION 'verify_failed: missing error was %', v_err;
      END IF;
  END;

  BEGIN
    PERFORM public.corporate_new_booking_guard_decision(true, 'inactive', 'card', 'card', 'card');
    RAISE EXCEPTION 'verify_failed: inactive account was allowed';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      IF v_err IS DISTINCT FROM 'CORPORATE_ACCOUNT_NOT_ACTIVE' THEN
        RAISE EXCEPTION 'verify_failed: inactive error was %', v_err;
      END IF;
  END;

  -- No active production account. Do not insert or reactivate one.
  -- Active allow-branch is the decision helper only.
  PERFORM public.corporate_new_booking_guard_decision(true, 'active', 'card', 'card', 'card');
  PERFORM public.corporate_new_booking_guard_decision(true, 'active', 'revolut', 'card', 'card');
  PERFORM public.corporate_new_booking_guard_decision(true, 'active', 'corporate_wallet', 'corporate_wallet', 'corporate_wallet');
  PERFORM public.corporate_new_booking_guard_decision(true, 'active', 'wallet', 'wallet', 'wallet');
  PERFORM public.corporate_new_booking_guard_decision(true, 'active', 'cash', 'cash', 'cash');

  BEGIN
    PERFORM public.corporate_new_booking_guard_decision(true, 'active', NULL, NULL, NULL);
    RAISE EXCEPTION 'verify_failed: empty payment method was allowed';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      IF v_err IS DISTINCT FROM 'CORPORATE_PAYMENT_METHOD_REQUIRED' THEN
        RAISE EXCEPTION 'verify_failed: empty method error was %', v_err;
      END IF;
  END;

  FOREACH v_token IN ARRAY ARRAY['invoice', 'INVOICE', 'corporate_account', 'CORPORATE_ACCOUNT', 'corporate-account', 'monthly_invoice']
  LOOP
    BEGIN
      PERFORM public.corporate_new_booking_guard_decision(true, 'active', v_token, 'card', 'card');
      RAISE EXCEPTION 'verify_failed: invoice method % was allowed', v_token;
    EXCEPTION
      WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
        IF v_err IS DISTINCT FROM 'CORPORATE_INVOICE_PAYMENT_DISABLED' THEN
          RAISE EXCEPTION 'verify_failed: invoice error for % was %', v_token, v_err;
        END IF;
    END;
  END LOOP;

  v_methods := public.get_corporate_allowed_payment_methods(v_suspended);
  IF v_methods @> ARRAY['INVOICE']::text[] THEN
    RAISE EXCEPTION 'verify_failed: helper returned INVOICE: %', v_methods;
  END IF;
  IF NOT (v_methods @> ARRAY['CARD']::text[]) THEN
    RAISE EXCEPTION 'verify_failed: helper dropped CARD: %', v_methods;
  END IF;

  IF (SELECT count(*)::int FROM public.corporate_accounts) IS DISTINCT FROM v_accounts_before
     OR (SELECT count(*)::int FROM public.trips WHERE corporate_account_id IS NOT NULL) IS DISTINCT FROM v_trips_before
     OR (SELECT count(*)::int FROM public.corporate_invoices) IS DISTINCT FROM v_invoices_before THEN
    RAISE EXCEPTION 'verify_failed: production counts changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.trips
    WHERE created_at > now() - interval '2 minutes'
      AND corporate_account_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'verify_failed: a corporate trip was created';
  END IF;
END;
$$;

ROLLBACK;
