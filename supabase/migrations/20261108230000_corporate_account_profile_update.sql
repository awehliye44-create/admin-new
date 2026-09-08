-- Corporate Settings profile update.
-- Authoritative columns already copied at approval:
--   company_name, contact_name, contact_phone, address
-- Email and password stay on the existing auth workflows.
-- Does not change status, payment flags, financial model, wallet,
-- credit limit, service area, owner linkage, or employee permissions.

CREATE OR REPLACE FUNCTION public.update_corporate_account_profile(
  p_corporate_account_id uuid,
  p_company_name text,
  p_contact_name text,
  p_contact_phone text,
  p_address text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  v_row public.corporate_accounts%ROWTYPE;
  v_company text;
  v_contact text;
  v_phone_raw text;
  v_phone text;
  v_address text;
  v_digits text;
  v_changed text[] := ARRAY[]::text[];
BEGIN
  IF p_corporate_account_id IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- Actor is always the session. Never accept a client-supplied user id.
  -- can_write_corporate allows admin/manager. owner is the same membership
  -- administrator role and is included here; viewer is not.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL
       OR NOT (
         public.can_write_corporate(auth.uid(), p_corporate_account_id)
         OR EXISTS (
           SELECT 1
           FROM public.corporate_user_accounts cua
           WHERE cua.user_id = auth.uid()
             AND cua.corporate_account_id = p_corporate_account_id
             AND cua.role = 'owner'
         )
       ) THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT *
  INTO v_row
  FROM public.corporate_accounts
  WHERE id = p_corporate_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  v_company := btrim(coalesce(p_company_name, ''));
  v_contact := btrim(coalesce(p_contact_name, ''));
  v_phone_raw := btrim(coalesce(p_contact_phone, ''));
  v_address := btrim(coalesce(p_address, ''));

  IF v_company = '' THEN
    RAISE EXCEPTION 'organisation_name_required' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_company) > 200 THEN
    RAISE EXCEPTION 'organisation_name_too_long' USING ERRCODE = '22023';
  END IF;
  IF v_contact = '' THEN
    RAISE EXCEPTION 'responsible_person_required' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_contact) > 120 THEN
    RAISE EXCEPTION 'responsible_person_too_long' USING ERRCODE = '22023';
  END IF;
  IF v_address = '' THEN
    RAISE EXCEPTION 'company_address_required' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_address) > 500 THEN
    RAISE EXCEPTION 'company_address_too_long' USING ERRCODE = '22023';
  END IF;
  IF v_phone_raw = '' THEN
    RAISE EXCEPTION 'phone_required' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_phone_raw) > 32 THEN
    RAISE EXCEPTION 'phone_too_long' USING ERRCODE = '22023';
  END IF;

  -- Same steps as normalizeOnboardingPhone. A previously stored non-E.164
  -- value may be kept only when the submitted phone is unchanged.
  v_digits := regexp_replace(v_phone_raw, '\D', '', 'g');
  IF left(v_phone_raw, 1) = '+' THEN
    v_phone := '+' || v_digits;
  ELSIF left(v_digits, 2) = '00' AND char_length(v_digits) > 2 THEN
    v_phone := '+' || substr(v_digits, 3);
  ELSIF char_length(v_digits) >= 10 THEN
    v_phone := '+' || v_digits;
  ELSE
    v_phone := v_phone_raw;
  END IF;

  IF v_phone !~ '^\+[1-9][0-9]{7,14}$' THEN
    IF v_phone_raw IS DISTINCT FROM btrim(coalesce(v_row.contact_phone, '')) THEN
      RAISE EXCEPTION 'phone_invalid' USING ERRCODE = '22023';
    END IF;
    v_phone := v_phone_raw;
  END IF;

  IF char_length(v_phone) > 32 THEN
    RAISE EXCEPTION 'phone_too_long' USING ERRCODE = '22023';
  END IF;

  IF v_company IS DISTINCT FROM v_row.company_name THEN
    v_changed := array_append(v_changed, 'company_name');
  END IF;
  IF v_contact IS DISTINCT FROM v_row.contact_name THEN
    v_changed := array_append(v_changed, 'contact_name');
  END IF;
  IF v_phone IS DISTINCT FROM v_row.contact_phone THEN
    v_changed := array_append(v_changed, 'contact_phone');
  END IF;
  IF v_address IS DISTINCT FROM coalesce(v_row.address, '') THEN
    v_changed := array_append(v_changed, 'address');
  END IF;

  UPDATE public.corporate_accounts
  SET company_name = v_company,
      contact_name = v_contact,
      contact_phone = v_phone,
      address = v_address,
      updated_at = now()
  WHERE id = p_corporate_account_id;

  IF cardinality(v_changed) > 0 THEN
    INSERT INTO public.corporate_audit_log (
      corporate_account_id,
      user_id,
      action,
      action_type,
      target_type,
      target_id,
      metadata
    ) VALUES (
      p_corporate_account_id,
      auth.uid(),
      'corporate_profile_updated',
      'update',
      'corporate_account',
      p_corporate_account_id::text,
      jsonb_build_object('changed_fields', to_jsonb(v_changed))
    );
  END IF;

  RETURN jsonb_build_object(
    'id', p_corporate_account_id,
    'company_name', v_company,
    'contact_name', v_contact,
    'contact_phone', v_phone,
    'address', v_address
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.update_corporate_account_profile(uuid, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_corporate_account_profile(uuid, text, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_corporate_account_profile(uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_corporate_account_profile(uuid, text, text, text, text) TO service_role;

COMMENT ON FUNCTION public.update_corporate_account_profile(uuid, text, text, text, text) IS
  'Corporate admin/manager profile update. Writes company_name, contact_name, contact_phone, address only. Actor is auth.uid().';
