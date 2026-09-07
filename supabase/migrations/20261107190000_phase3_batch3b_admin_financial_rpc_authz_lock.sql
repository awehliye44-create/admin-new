-- ============================================================
-- Phase 3 Batch 3B: remaining critical admin/financial RPC authz
-- NOT APPLIED until explicitly approved.
--
-- Retained authenticated (body gate, fail closed):
--   approve_corporate_request(uuid, uuid)
--     page: account-requests (role_page_permissions)
--     reviewed_by stamped from auth.uid(), not the caller argument
--   find_or_create_customer(uuid, text, text, text)
--     own auth.uid() OR page: manual-trip
--     Customer complete-registration is a proven authenticated caller.
--
-- Edge / trigger / unused money RPCs: revoke PUBLIC, anon, authenticated.
-- Preserve service_role and postgres owner. No drops. No body changes
-- on those money functions (nested SECURITY DEFINER / triggers call them
-- as postgres; a JWT body gate would break trigger context).
--
-- Companion revoke: ops_repair_missing_financials(uuid) calls
-- ops_repair_missing_driver_earning as SECURITY DEFINER. Leaving it
-- authenticated would bypass the child revoke.
-- ============================================================

BEGIN;

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

COMMENT ON FUNCTION public.staff_has_page_access(text) IS
  'Batch3B: active staff_profiles + role_page_permissions.can_access for the exact page slug. Fail closed. Not a finance-role allowlist.';

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

  -- Authenticated staff cannot stamp another reviewer.
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

  -- Own identity, Manual Trip staff, or service_role. Never a foreign user id.
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

-- Money / legacy cash: service_role + postgres owner only
REVOKE ALL ON FUNCTION public.ops_repair_missing_driver_earning(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_repair_missing_driver_earning(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ops_repair_missing_driver_earning(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ops_repair_missing_driver_earning(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.ops_repair_missing_financials(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ops_repair_missing_financials(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.ops_repair_missing_financials(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ops_repair_missing_financials(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.finalize_driver_early_cashout_paid(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_driver_early_cashout_paid(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_driver_early_cashout_paid(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_driver_early_cashout_paid(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) TO service_role;

REVOKE ALL ON FUNCTION public.reserve_driver_commission_wallet(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_driver_commission_wallet(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.reserve_driver_commission_wallet(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_driver_commission_wallet(uuid, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.release_driver_commission_wallet(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_driver_commission_wallet(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.release_driver_commission_wallet(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_driver_commission_wallet(uuid, uuid, text) TO service_role;

COMMIT;
