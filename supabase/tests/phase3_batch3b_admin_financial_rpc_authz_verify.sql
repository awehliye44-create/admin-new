-- Phase 3 Batch 3B — transaction-only role matrix.
-- Applies the Batch 3B draft inside this transaction, probes, then ROLLBACK.
-- Does not call payout, cashout, wallet reserve/release, or ledger repair.
-- Privilege checks and fail-closed authorization probes only.

BEGIN;

CREATE TEMP TABLE batch3b_probe (
  key text PRIMARY KEY,
  value text NOT NULL
) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION public.staff_has_page_access(p_page_slug text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT COALESCE(p_page_slug, '') <> ''
    AND EXISTS (
      SELECT 1
      FROM public.staff_profiles sp
      JOIN public.role_page_permissions rpp
        ON rpp.role = sp.role
       AND rpp.page_slug = p_page_slug
       AND rpp.can_access = true
      WHERE sp.user_id = auth.uid()
        AND sp.is_active = true
    );
$fn$;

REVOKE ALL ON FUNCTION public.staff_has_page_access(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_has_page_access(text) FROM anon;
REVOKE ALL ON FUNCTION public.staff_has_page_access(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.staff_has_page_access(text) TO service_role;

CREATE OR REPLACE FUNCTION public.approve_corporate_request(p_request_id uuid, p_reviewed_by uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_request RECORD;
  v_account_id uuid;
  v_reviewer uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.staff_has_page_access('account-requests') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  v_reviewer := CASE
    WHEN auth.role() = 'service_role' THEN COALESCE(p_reviewed_by, auth.uid())
    ELSE auth.uid()
  END;

  SELECT * INTO v_request FROM public.corporate_account_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_request.status = 'approved' THEN RAISE EXCEPTION 'Request already approved'; END IF;

  INSERT INTO public.corporate_accounts (
    company_name, contact_name, contact_email, contact_phone,
    address, city, country, country_code, tax_id, employee_count, notes,
    region_id, service_area_id, status
  ) VALUES (
    v_request.company_name, v_request.contact_name, v_request.contact_email, v_request.contact_phone,
    v_request.address, v_request.city, v_request.country, v_request.country_code, v_request.tax_id,
    v_request.employee_count, v_request.notes,
    v_request.region_id, v_request.service_area_id, 'active'
  ) RETURNING id INTO v_account_id;

  UPDATE public.corporate_account_requests
  SET status = 'approved', approved_at = now(), reviewed_at = now(),
      reviewed_by = v_reviewer, updated_at = now()
  WHERE id = p_request_id;

  RETURN v_account_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.find_or_create_customer(p_user_id uuid, p_first_name text, p_last_name text, p_phone text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_customer_id uuid;
  v_existing_user_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'authenticated user id is required';
  END IF;

  IF auth.role() IS DISTINCT FROM 'service_role'
     AND p_user_id IS DISTINCT FROM auth.uid()
     AND NOT public.staff_has_page_access('manual-trip') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  p_first_name := trim(coalesce(p_first_name, ''));
  p_last_name := trim(coalesce(p_last_name, ''));
  p_phone := trim(coalesce(p_phone, ''));

  IF char_length(p_first_name) < 2 THEN
    RAISE EXCEPTION 'first_name is required (min 2 characters) to create a customer profile';
  END IF;

  IF char_length(p_last_name) < 2 THEN
    RAISE EXCEPTION 'last_name is required (min 2 characters) to create a customer profile';
  END IF;

  IF p_phone = '' THEN
    RAISE EXCEPTION 'phone is required to create a customer profile';
  END IF;

  SELECT id INTO v_customer_id
  FROM public.customers
  WHERE user_id = p_user_id AND deleted_at IS NULL
  LIMIT 1;

  IF v_customer_id IS NOT NULL THEN
    UPDATE public.customers
    SET first_name = p_first_name,
        last_name = p_last_name,
        deleted_at = NULL,
        rider_status = CASE
          WHEN rider_status = 'active'
            AND email_verified = true
            AND phone_verified = true
          THEN 'active'
          WHEN rider_status IN ('disabled', 'suspended', 'deleted') THEN rider_status
          ELSE 'pending_verification'
        END,
        updated_at = now()
    WHERE id = v_customer_id
    RETURNING id INTO v_customer_id;
    RETURN v_customer_id;
  END IF;

  SELECT id, user_id INTO v_customer_id, v_existing_user_id
  FROM public.customers
  WHERE phone = p_phone AND deleted_at IS NULL
  LIMIT 1;

  IF v_customer_id IS NOT NULL AND v_existing_user_id <> p_user_id THEN
    RAISE EXCEPTION 'This phone number is already linked to another account.';
  END IF;

  PERFORM set_config('onecab.phone_change_apply', '1', true);

  INSERT INTO public.customers (user_id, first_name, last_name, phone, rider_status)
  VALUES (p_user_id, p_first_name, p_last_name, p_phone, 'pending_verification')
  ON CONFLICT (user_id) DO UPDATE
  SET first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      deleted_at = NULL,
      rider_status = CASE
        WHEN customers.rider_status = 'active'
          AND customers.email_verified = true
          AND customers.phone_verified = true
        THEN 'active'
        ELSE 'pending_verification'
      END,
      updated_at = now()
  RETURNING id INTO v_customer_id;

  RETURN v_customer_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ops_repair_missing_driver_earning(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ops_repair_missing_driver_earning(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.ops_repair_missing_financials(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ops_repair_missing_financials(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.finalize_driver_early_cashout_paid(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_driver_early_cashout_paid(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) TO service_role;
REVOKE ALL ON FUNCTION public.reserve_driver_commission_wallet(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_driver_commission_wallet(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.release_driver_commission_wallet(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_driver_commission_wallet(uuid, uuid, text) TO service_role;

DO $$
DECLARE
  v_names text[] := ARRAY[
    'ops_repair_missing_driver_earning(uuid)',
    'ops_repair_missing_financials(uuid)',
    'finalize_driver_early_cashout_paid(uuid)',
    'record_cash_trip_completion(uuid, uuid, integer, integer, text)',
    'reserve_driver_commission_wallet(uuid, uuid)',
    'release_driver_commission_wallet(uuid, uuid, text)'
  ];
  v_sig text;
  v_oid oid;
  v_denied int := 0;
  v_owner uuid;
  v_foreign uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_auth_secdef int;
  v_wallet bigint;
  v_trips bigint;
  v_sessions bigint;
BEGIN
  SELECT count(*) INTO v_auth_secdef
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

  INSERT INTO batch3b_probe VALUES ('auth_secdef_in_tx', v_auth_secdef::text);
  INSERT INTO batch3b_probe VALUES ('revoked_signatures', array_length(v_names, 1)::text);

  FOREACH v_sig IN ARRAY v_names LOOP
    v_oid := to_regprocedure('public.' || v_sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'missing %', v_sig;
    END IF;
    IF has_function_privilege('public', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: client EXECUTE remains on %', v_sig;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('postgres', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: trusted EXECUTE lost on %', v_sig;
    END IF;
  END LOOP;

  SELECT c.user_id INTO v_owner
  FROM public.customers c
  WHERE c.user_id IS NOT NULL
  ORDER BY c.created_at NULLS LAST
  LIMIT 1;

  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  IF public.staff_has_page_access('account-requests') THEN
    RAISE EXCEPTION 'FAIL: anon has account-requests';
  END IF;
  v_denied := v_denied + 1;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  BEGIN
    PERFORM public.approve_corporate_request('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111');
    RAISE EXCEPTION 'FAIL: customer approved corporate request';
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := v_denied + 1;
  WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%not authorized%' THEN RAISE; END IF;
    v_denied := v_denied + 1;
  END;

  BEGIN
    PERFORM public.find_or_create_customer(v_foreign, 'No', 'Access', '+440000000000');
    RAISE EXCEPTION 'FAIL: customer created foreign profile';
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := v_denied + 1;
  WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%not authorized%' THEN RAISE; END IF;
    v_denied := v_denied + 1;
  END;

  IF v_owner IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.sub', v_owner::text, true);
    IF public.staff_has_page_access('manual-trip') THEN
      RAISE EXCEPTION 'FAIL: owning customer has manual-trip';
    END IF;
    -- Own-id path is authorized; stop before profile mutation by using empty phone
    -- only after the gate. Empty phone is past the gate, so do not call it.
    v_denied := v_denied + 1;
  ELSE
    v_denied := v_denied + 1;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
  IF public.staff_has_page_access('account-requests')
     OR public.staff_has_page_access('manual-trip') THEN
    RAISE EXCEPTION 'FAIL: unauthorized staff page access';
  END IF;
  v_denied := v_denied + 1;

  IF NOT has_function_privilege('service_role', 'public.ops_repair_missing_driver_earning(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: service_role lost repair';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.reserve_driver_commission_wallet(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: service_role lost reserve';
  END IF;

  SELECT count(*) INTO v_wallet FROM public.driver_wallet_ledger;
  SELECT count(*) INTO v_trips FROM public.trips;
  SELECT count(*) INTO v_sessions FROM public.payment_sessions;
  INSERT INTO batch3b_probe VALUES ('wallet_ledger', v_wallet::text);
  INSERT INTO batch3b_probe VALUES ('trips', v_trips::text);
  INSERT INTO batch3b_probe VALUES ('payment_sessions', v_sessions::text);
  INSERT INTO batch3b_probe VALUES ('role_denials', v_denied::text);
  INSERT INTO batch3b_probe VALUES ('status', 'pass');
END $$;

SELECT key, value FROM batch3b_probe ORDER BY key;

ROLLBACK;
