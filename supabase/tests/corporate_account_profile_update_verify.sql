-- Post-apply simulation. Wrap with BEGIN/ROLLBACK. Never updates the live account.

DO $verify$
DECLARE
  v_live_id uuid;
  v_live_company text;
  v_live_contact text;
  v_live_phone text;
  v_live_address text;
  v_live_status text;
  v_live_email text;
  v_live_credit numeric;
  v_actor uuid;
  v_owner uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  v_admin uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  v_manager uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
  v_viewer uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4';
  v_other uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5';
  v_result jsonb;
  v_changed jsonb;
  v_meta text;
  v_phone text;
  v_status text;
  v_email text;
  v_credit numeric;
  v_sa uuid;
  v_card boolean;
BEGIN
  IF NOT has_function_privilege('postgres', 'public.update_corporate_account_profile(uuid,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.update_corporate_account_profile(uuid,text,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.update_corporate_account_profile(uuid,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_corporate_account_profile(uuid,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('public', 'public.update_corporate_account_profile(uuid,text,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'function ACL mismatch';
  END IF;

  SELECT id, company_name, contact_name, contact_phone, address, status, contact_email, credit_limit
  INTO v_live_id, v_live_company, v_live_contact, v_live_phone, v_live_address, v_live_status, v_live_email, v_live_credit
  FROM public.corporate_accounts
  WHERE id NOT IN (v_owner, v_admin, v_manager, v_viewer, v_other)
  ORDER BY created_at
  LIMIT 1;

  SELECT user_id INTO v_actor
  FROM public.corporate_user_accounts
  WHERE corporate_account_id = v_live_id
    AND role = 'admin'
  LIMIT 1;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'simulation aborted: no admin membership';
  END IF;

  INSERT INTO public.corporate_accounts (
    id, company_name, contact_name, contact_email, contact_phone, address, status,
    credit_limit, payment_card_enabled, payment_apple_pay_enabled, payment_google_pay_enabled,
    payment_invoice_enabled, payment_wallet_enabled
  ) VALUES
    (v_owner, 'Owner Org', 'Owner Person', 'owner-sim@example.invalid', '07123456789', '1 Owner Street', 'suspended', 100, true, false, false, false, false),
    (v_admin, 'Admin Org', 'Admin Person', 'admin-sim@example.invalid', '07123456789', '2 Admin Street', 'suspended', 100, true, false, false, false, false),
    (v_manager, 'Manager Org', 'Manager Person', 'manager-sim@example.invalid', '07123456789', '3 Manager Street', 'suspended', 100, true, false, false, false, false),
    (v_viewer, 'Viewer Org', 'Viewer Person', 'viewer-sim@example.invalid', '07123456789', '4 Viewer Street', 'suspended', 100, true, false, false, false, false),
    (v_other, 'Other Org', 'Other Person', 'other-sim@example.invalid', '07123456789', '5 Other Street', 'active', 100, true, false, false, false, false);

  INSERT INTO public.corporate_user_accounts (user_id, corporate_account_id, role)
  VALUES
    (v_actor, v_owner, 'owner'),
    (v_actor, v_admin, 'admin'),
    (v_actor, v_manager, 'manager'),
    (v_actor, v_viewer, 'viewer');

  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);

  v_result := public.update_corporate_account_profile(v_owner, 'Owner Org Updated', 'Owner Person Updated', '07123456789', '1 Owner Street');
  IF v_result->>'contact_phone' IS DISTINCT FROM '07123456789' THEN
    RAISE EXCEPTION 'legacy phone was rewritten';
  END IF;

  v_result := public.update_corporate_account_profile(v_admin, 'Admin Org Updated', 'Admin Person Updated', '+447700900123', '2 Admin Road');
  IF v_result->>'company_name' IS DISTINCT FROM 'Admin Org Updated'
     OR v_result->>'contact_phone' IS DISTINCT FROM '+447700900123' THEN
    RAISE EXCEPTION 'admin update failed';
  END IF;

  v_result := public.update_corporate_account_profile(v_manager, 'Manager Org Updated', 'Manager Person Updated', '+447700900124', '3 Manager Road');
  IF v_result->>'company_name' IS DISTINCT FROM 'Manager Org Updated' THEN
    RAISE EXCEPTION 'manager update failed';
  END IF;

  BEGIN
    PERFORM public.update_corporate_account_profile(v_viewer, 'Nope', 'Nope', '+447700900123', 'Nope Street');
    RAISE EXCEPTION 'viewer update was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM public.update_corporate_account_profile(v_other, 'Nope', 'Nope', '+447700900123', 'Nope Street');
    RAISE EXCEPTION 'other-account update was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);

  BEGIN
    PERFORM public.update_corporate_account_profile(v_owner, 'Nope', 'Nope', '+447700900123', 'Nope Street');
    RAISE EXCEPTION 'anonymous update was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_actor, 'role', 'authenticated')::text, true);

  BEGIN
    PERFORM public.update_corporate_account_profile(v_admin, ' ', 'Admin Person', '+447700900123', '2 Admin Road');
    RAISE EXCEPTION 'blank organisation name was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  BEGIN
    PERFORM public.update_corporate_account_profile(v_admin, repeat('A', 201), 'Admin Person', '+447700900123', '2 Admin Road');
    RAISE EXCEPTION 'long organisation name was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  BEGIN
    PERFORM public.update_corporate_account_profile(v_owner, 'Owner Org Updated', 'Owner Person Updated', '07999999999', '1 Owner Street');
    RAISE EXCEPTION 'changed invalid phone was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;

  SELECT contact_phone, status, contact_email, credit_limit, service_area_id, payment_card_enabled
  INTO v_phone, v_status, v_email, v_credit, v_sa, v_card
  FROM public.corporate_accounts
  WHERE id = v_owner;

  IF v_phone IS DISTINCT FROM '07123456789'
     OR v_status IS DISTINCT FROM 'suspended'
     OR v_email IS DISTINCT FROM 'owner-sim@example.invalid'
     OR v_credit IS DISTINCT FROM 100
     OR v_sa IS NOT NULL
     OR v_card IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'protected column changed or legacy phone rewritten';
  END IF;

  SELECT metadata->'changed_fields', metadata::text
  INTO v_changed, v_meta
  FROM public.corporate_audit_log
  WHERE corporate_account_id = v_owner
    AND action = 'corporate_profile_updated'
    AND user_id = v_actor
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_changed IS NULL OR NOT (v_changed ? 'company_name') OR NOT (v_changed ? 'contact_name') THEN
    RAISE EXCEPTION 'audit log missing changed field names';
  END IF;

  IF v_meta ILIKE '%07123456789%'
     OR v_meta ILIKE '%owner-sim%'
     OR v_meta ILIKE '%Owner Org%'
     OR v_meta ILIKE '%password%'
     OR v_meta ILIKE '%token%' THEN
    RAISE EXCEPTION 'audit metadata stored personal values';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.corporate_accounts
    WHERE id = v_live_id
      AND (
        company_name IS DISTINCT FROM v_live_company
        OR contact_name IS DISTINCT FROM v_live_contact
        OR contact_phone IS DISTINCT FROM v_live_phone
        OR address IS DISTINCT FROM v_live_address
        OR status IS DISTINCT FROM v_live_status
        OR contact_email IS DISTINCT FROM v_live_email
        OR credit_limit IS DISTINCT FROM v_live_credit
      )
  ) THEN
    RAISE EXCEPTION 'live corporate account changed during simulation';
  END IF;
END;
$verify$;
