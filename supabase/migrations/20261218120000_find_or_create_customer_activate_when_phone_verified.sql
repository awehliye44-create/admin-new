-- HISTORY PARITY ONLY. Already applied on linked production.
-- Restored so local migration list matches remote. Do not re-apply via db push.
-- LOCK: Driver (or any verified Auth identity) registering as Customer must
-- activate when Auth phone is already confirmed. Customers have no email gate.
-- find_or_create_customer previously left rider_status=pending_verification with
-- email_verified=false forever (complete-registration / Manual Trip), so Admin
-- showed Pending Verification despite phone-only product rules.
--
-- If this fails, fix the function — never reintroduce sticky pending after phone verify.

CREATE OR REPLACE FUNCTION public.find_or_create_customer(
  p_user_id uuid,
  p_first_name text,
  p_last_name text,
  p_phone text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_customer_id uuid;
  v_existing_user_id uuid;
  v_phone_confirmed_at timestamptz;
  v_email_confirmed_at timestamptz;
  v_phone_ok boolean := false;
  v_status text;
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

  SELECT u.phone_confirmed_at, u.email_confirmed_at
  INTO v_phone_confirmed_at, v_email_confirmed_at
  FROM auth.users u
  WHERE u.id = p_user_id
    AND u.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found';
  END IF;

  -- Phone is the only customer activation gate (no email-verification gate).
  v_phone_ok := v_phone_confirmed_at IS NOT NULL;
  v_status := CASE WHEN v_phone_ok THEN 'active' ELSE 'pending_verification' END;

  SELECT id INTO v_customer_id
  FROM public.customers
  WHERE user_id = p_user_id AND deleted_at IS NULL
  LIMIT 1;

  IF v_customer_id IS NOT NULL THEN
    UPDATE public.customers
    SET first_name = p_first_name,
        last_name = p_last_name,
        deleted_at = NULL,
        email_verified = CASE
          WHEN rider_status IN ('disabled', 'suspended', 'deleted') THEN email_verified
          WHEN v_phone_ok THEN true
          ELSE email_verified
        END,
        email_verified_at = CASE
          WHEN rider_status IN ('disabled', 'suspended', 'deleted') THEN email_verified_at
          WHEN v_phone_ok THEN coalesce(email_verified_at, v_email_confirmed_at, now())
          ELSE email_verified_at
        END,
        phone_verified = CASE
          WHEN rider_status IN ('disabled', 'suspended', 'deleted') THEN phone_verified
          WHEN v_phone_ok THEN true
          ELSE phone_verified
        END,
        phone_verified_at = CASE
          WHEN rider_status IN ('disabled', 'suspended', 'deleted') THEN phone_verified_at
          WHEN v_phone_ok THEN coalesce(phone_verified_at, v_phone_confirmed_at, now())
          ELSE phone_verified_at
        END,
        rider_status = CASE
          WHEN rider_status IN ('disabled', 'suspended', 'deleted') THEN rider_status
          WHEN v_phone_ok THEN 'active'
          WHEN rider_status = 'active'
            AND email_verified = true
            AND phone_verified = true
          THEN 'active'
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

  INSERT INTO public.customers (
    user_id,
    first_name,
    last_name,
    phone,
    rider_status,
    email_verified,
    email_verified_at,
    phone_verified,
    phone_verified_at
  )
  VALUES (
    p_user_id,
    p_first_name,
    p_last_name,
    p_phone,
    v_status,
    v_phone_ok,
    CASE WHEN v_phone_ok THEN coalesce(v_email_confirmed_at, now()) ELSE NULL END,
    v_phone_ok,
    CASE WHEN v_phone_ok THEN v_phone_confirmed_at ELSE NULL END
  )
  ON CONFLICT (user_id) DO UPDATE
  SET first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      deleted_at = NULL,
      email_verified = CASE
        WHEN customers.rider_status IN ('disabled', 'suspended', 'deleted') THEN customers.email_verified
        WHEN EXCLUDED.email_verified THEN true
        ELSE customers.email_verified
      END,
      email_verified_at = CASE
        WHEN customers.rider_status IN ('disabled', 'suspended', 'deleted') THEN customers.email_verified_at
        WHEN EXCLUDED.email_verified THEN coalesce(customers.email_verified_at, EXCLUDED.email_verified_at, now())
        ELSE customers.email_verified_at
      END,
      phone_verified = CASE
        WHEN customers.rider_status IN ('disabled', 'suspended', 'deleted') THEN customers.phone_verified
        WHEN EXCLUDED.phone_verified THEN true
        ELSE customers.phone_verified
      END,
      phone_verified_at = CASE
        WHEN customers.rider_status IN ('disabled', 'suspended', 'deleted') THEN customers.phone_verified_at
        WHEN EXCLUDED.phone_verified THEN coalesce(customers.phone_verified_at, EXCLUDED.phone_verified_at, now())
        ELSE customers.phone_verified_at
      END,
      rider_status = CASE
        WHEN customers.rider_status IN ('disabled', 'suspended', 'deleted') THEN customers.rider_status
        WHEN EXCLUDED.rider_status = 'active' THEN 'active'
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

COMMENT ON FUNCTION public.find_or_create_customer(uuid, text, text, text) IS
  'Idempotent Customer profile create/resume. Activates when Auth phone is confirmed (no email gate).';
