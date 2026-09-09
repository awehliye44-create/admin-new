-- Phase A7C1 body simulation. Applies the draft bodies, probes, then ROLLBACK.
-- Uses sentinel fixture accounts only. Does not print real user or account ids.

BEGIN;

RESET ROLE;

CREATE TEMP TABLE a7c1_before AS
SELECT
  p.proname,
  md5(p.prosrc) AS body_md5,
  p.proacl::text AS acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'has_corporate_access',
    'can_write_corporate',
    'has_role',
    'update_corporate_account_profile',
    'corporate_new_booking_guard_decision',
    'enforce_corporate_new_booking_guard'
  );

CREATE TEMP TABLE a7c1_counts AS
SELECT
  (SELECT count(*) FROM public.corporate_user_accounts) AS corp_memberships,
  (SELECT count(*) FROM public.corporate_user_accounts WHERE role = 'admin') AS role_admin,
  (SELECT count(*) FROM public.corporate_user_accounts WHERE role = 'manager') AS role_manager,
  (SELECT count(*) FROM public.corporate_user_accounts WHERE role = 'owner') AS role_owner,
  (SELECT count(*) FROM public.corporate_user_accounts WHERE role = 'viewer') AS role_viewer,
  (SELECT count(*) FROM public.corporate_accounts) AS corporate_accounts,
  (SELECT count(*) FROM public.corporate_locations) AS corporate_locations,
  (SELECT count(*) FROM public.corporate_users) AS corporate_users,
  (SELECT count(*) FROM public.corporate_policies) AS corporate_policies,
  (SELECT count(*) FROM public.corporate_audit_log) AS corporate_audit,
  (SELECT count(*) FROM public.staff_profiles) AS staff_profiles,
  (SELECT count(*) FROM public.customers) AS customers,
  (SELECT count(*) FROM public.drivers) AS drivers,
  (SELECT count(*) FROM public.trips) AS trips,
  (SELECT count(*) FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*) FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger) AS wallet_sum,
  (SELECT count(*) FROM auth.users) AS auth_users,
  (SELECT company_name FROM public.corporate_accounts ORDER BY created_at LIMIT 1) AS live_company;

DO $ctx$
BEGIN
  IF auth.uid() IS NOT NULL OR auth.role() IS NOT NULL OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'postgres/no-JWT context mismatch';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000c1', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000000c1', 'role', 'authenticated')::text, true);
  IF auth.uid() IS DISTINCT FROM '00000000-0000-4000-8000-0000000000c1'::uuid
     OR auth.role() IS DISTINCT FROM 'authenticated'
     OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'authenticated JWT is not independent of current_user';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  IF auth.uid() IS NOT NULL
     OR auth.role() IS DISTINCT FROM 'service_role'
     OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'service_role JWT context mismatch inside definer owner session';
  END IF;
END;
$ctx$;

CREATE TEMP TABLE a7c1_fix (
  self_id uuid,
  foreign_id uuid,
  admin_acct uuid,
  manager_acct uuid,
  viewer_acct uuid,
  owner_acct uuid,
  other_acct uuid,
  shared_acct uuid,
  loc_id uuid,
  emp_id uuid
) ON COMMIT DROP;
GRANT SELECT, INSERT, UPDATE, DELETE ON a7c1_fix TO authenticated, anon, service_role;

DO $simulate$
DECLARE
  v_self uuid;
  v_foreign uuid;
  v_admin_acct uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccc01';
  v_manager_acct uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccc02';
  v_viewer_acct uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccc03';
  v_owner_acct uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccc04';
  v_other_acct uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccc05';
  v_shared_acct uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccc06';
  v_before_self_access boolean;
  v_before_self_write boolean;
  v_before_foreign_access boolean;
  v_before_foreign_write boolean;
  v_after_self_access boolean;
  v_after_self_write boolean;
  v_after_foreign_access boolean;
  v_after_foreign_write boolean;
  v_visible integer;
  v_loc_id uuid;
  v_emp_id uuid;
  v_result jsonb;
  v_access_policies integer;
  v_write_policies integer;
  v_auth_secdef integer;
BEGIN
  SELECT count(*) INTO v_access_policies
  FROM pg_policy pol
  WHERE coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ~* 'has_corporate_access\s*\('
     OR coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~* 'has_corporate_access\s*\(';
  SELECT count(*) INTO v_write_policies
  FROM pg_policy pol
  WHERE coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ~* 'can_write_corporate\s*\('
     OR coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~* 'can_write_corporate\s*\(';
  IF v_access_policies <> 11 OR v_write_policies <> 7 THEN
    RAISE EXCEPTION 'policy caller count drifted: access %, write %', v_access_policies, v_write_policies;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policy pol
    WHERE (
      coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ~* '(has_corporate_access|can_write_corporate)\s*\('
      OR coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~* '(has_corporate_access|can_write_corporate)\s*\('
    )
    AND coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') !~* '(has_corporate_access|can_write_corporate)\s*\(\s*auth\.uid\s*\(\s*\)'
    AND coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') !~* '(has_corporate_access|can_write_corporate)\s*\(\s*auth\.uid\s*\(\s*\)'
  ) THEN
    RAISE EXCEPTION 'policy passes a user id other than auth.uid()';
  END IF;

  SELECT user_id INTO v_self
  FROM public.corporate_user_accounts
  WHERE role = 'admin'
  ORDER BY created_at
  LIMIT 1;
  SELECT u.id INTO v_foreign
  FROM auth.users u
  WHERE u.id <> v_self
    AND NOT public.has_role(u.id, 'admin'::public.app_role)
  ORDER BY u.created_at
  LIMIT 1;
  IF v_self IS NULL OR v_foreign IS NULL THEN
    RAISE EXCEPTION 'simulation aborted: fixture actors unavailable';
  END IF;

  INSERT INTO public.corporate_accounts (
    id, company_name, contact_name, contact_email, contact_phone, address, status
  ) VALUES
    (v_admin_acct, 'A7C1 Admin Org', 'Admin Person', 'a7c1-admin@example.invalid', '07123456789', '1 Admin Street', 'active'),
    (v_manager_acct, 'A7C1 Manager Org', 'Manager Person', 'a7c1-manager@example.invalid', '07123456789', '2 Manager Street', 'active'),
    (v_viewer_acct, 'A7C1 Viewer Org', 'Viewer Person', 'a7c1-viewer@example.invalid', '07123456789', '3 Viewer Street', 'active'),
    (v_owner_acct, 'A7C1 Owner Org', 'Owner Person', 'a7c1-owner@example.invalid', '07123456789', '4 Owner Street', 'suspended'),
    (v_other_acct, 'A7C1 Other Org', 'Other Person', 'a7c1-other@example.invalid', '07123456789', '5 Other Street', 'active'),
    (v_shared_acct, 'A7C1 Shared Org', 'Shared Person', 'a7c1-shared@example.invalid', '07123456789', '6 Shared Street', 'active');

  INSERT INTO public.corporate_user_accounts (user_id, corporate_account_id, role)
  VALUES
    (v_self, v_admin_acct, 'admin'),
    (v_self, v_manager_acct, 'manager'),
    (v_self, v_viewer_acct, 'viewer'),
    (v_self, v_owner_acct, 'owner'),
    (v_foreign, v_other_acct, 'admin'),
    (v_foreign, v_shared_acct, 'admin');

  INSERT INTO public.corporate_locations (corporate_account_id, name, address)
  VALUES (v_admin_acct, 'A7C1 Existing Location', '1 Admin Street')
  RETURNING id INTO v_loc_id;

  INSERT INTO public.corporate_users (corporate_account_id, email, first_name, last_name)
  VALUES (v_admin_acct, 'a7c1-employee@example.invalid', 'A7C1', 'Employee')
  RETURNING id INTO v_emp_id;

  INSERT INTO public.corporate_users (corporate_account_id, email, first_name, last_name)
  VALUES (v_viewer_acct, 'a7c1-viewer-employee@example.invalid', 'A7C1', 'ViewerEmployee');

  PERFORM set_config('request.jwt.claim.sub', v_self::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_self, 'role', 'authenticated')::text, true);

  v_before_self_access := public.has_corporate_access(v_self, v_admin_acct);
  v_before_self_write := public.can_write_corporate(v_self, v_admin_acct);
  v_before_foreign_access := public.has_corporate_access(v_foreign, v_shared_acct);
  v_before_foreign_write := public.can_write_corporate(v_foreign, v_shared_acct);
  IF v_before_self_access IS NOT TRUE
     OR v_before_self_write IS NOT TRUE
     OR v_before_foreign_access IS NOT TRUE
     OR v_before_foreign_write IS NOT TRUE THEN
    RAISE EXCEPTION 'baseline fixture membership did not match expected production helper';
  END IF;

  CREATE OR REPLACE FUNCTION public.has_corporate_access(p_user_id uuid, p_corporate_account_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
    SELECT
      auth.uid() IS NOT NULL
      AND p_user_id IS NOT DISTINCT FROM auth.uid()
      AND EXISTS (
        SELECT 1
        FROM public.corporate_user_accounts
        WHERE user_id = p_user_id
          AND corporate_account_id = p_corporate_account_id
      );
  $function$;

  CREATE OR REPLACE FUNCTION public.can_write_corporate(p_user_id uuid, p_corporate_account_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
    SELECT
      auth.uid() IS NOT NULL
      AND p_user_id IS NOT DISTINCT FROM auth.uid()
      AND EXISTS (
        SELECT 1
        FROM public.corporate_user_accounts cua
        WHERE cua.user_id = p_user_id
          AND cua.corporate_account_id = p_corporate_account_id
          AND cua.role IN ('admin', 'manager')
      );
  $function$;

  v_after_self_access := public.has_corporate_access(v_self, v_admin_acct);
  v_after_self_write := public.can_write_corporate(v_self, v_admin_acct);
  v_after_foreign_access := public.has_corporate_access(v_foreign, v_shared_acct);
  v_after_foreign_write := public.can_write_corporate(v_foreign, v_shared_acct);
  IF v_after_self_access IS DISTINCT FROM v_before_self_access
     OR v_after_self_write IS DISTINCT FROM v_before_self_write
     OR v_after_foreign_access IS NOT FALSE
     OR v_after_foreign_write IS NOT FALSE THEN
    RAISE EXCEPTION 'self/foreign helper result mismatch after self-bind';
  END IF;

  IF public.has_corporate_access(v_self, v_other_acct)
     OR public.can_write_corporate(v_self, v_viewer_acct)
     OR public.can_write_corporate(v_self, v_owner_acct)
     OR NOT public.has_corporate_access(v_self, v_viewer_acct)
     OR NOT public.can_write_corporate(v_self, v_manager_acct) THEN
    RAISE EXCEPTION 'self membership semantics changed';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  IF public.has_corporate_access(v_foreign, v_shared_acct)
     OR public.can_write_corporate(v_foreign, v_shared_acct) THEN
    RAISE EXCEPTION 'service_role JWT reached arbitrary lookup';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  IF public.has_corporate_access(v_self, v_admin_acct)
     OR public.can_write_corporate(v_self, v_admin_acct) THEN
    RAISE EXCEPTION 'missing JWT did not fail closed';
  END IF;

  INSERT INTO a7c1_fix
  VALUES (
    v_self, v_foreign, v_admin_acct, v_manager_acct, v_viewer_acct,
    v_owner_acct, v_other_acct, v_shared_acct, v_loc_id, v_emp_id
  );

  PERFORM set_config('request.jwt.claim.sub', v_self::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_self, 'role', 'authenticated')::text, true);

  v_result := public.update_corporate_account_profile(
    v_owner_acct, 'A7C1 Owner Org Updated', 'Owner Person Updated', '07123456789', '4 Owner Street'
  );
  IF v_result->>'company_name' IS DISTINCT FROM 'A7C1 Owner Org Updated' THEN
    RAISE EXCEPTION 'owner profile update failed';
  END IF;

  v_result := public.update_corporate_account_profile(
    v_admin_acct, 'A7C1 Admin Org Updated', 'Admin Person Updated', '+447700900123', '1 Admin Road'
  );
  IF v_result->>'company_name' IS DISTINCT FROM 'A7C1 Admin Org Updated' THEN
    RAISE EXCEPTION 'admin profile update failed';
  END IF;

  v_result := public.update_corporate_account_profile(
    v_manager_acct, 'A7C1 Manager Org Updated', 'Manager Person Updated', '+447700900124', '2 Manager Road'
  );
  IF v_result->>'company_name' IS DISTINCT FROM 'A7C1 Manager Org Updated' THEN
    RAISE EXCEPTION 'manager profile update failed';
  END IF;

  BEGIN
    PERFORM public.update_corporate_account_profile(
      v_viewer_acct, 'Nope', 'Nope', '+447700900123', 'Nope Street'
    );
    RAISE EXCEPTION 'viewer profile update was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM public.update_corporate_account_profile(
      v_other_acct, 'Nope', 'Nope', '+447700900123', 'Nope Street'
    );
    RAISE EXCEPTION 'unrelated profile update was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.has_corporate_access(v_self, v_admin_acct);
    RAISE EXCEPTION 'anon helper execution was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  SELECT count(*) INTO v_auth_secdef
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_secdef <> 202 THEN
    RAISE EXCEPTION 'expected authenticated SECURITY DEFINER 202, got %', v_auth_secdef;
  END IF;
END;
$simulate$;

DO $member_rls$
DECLARE
  f a7c1_fix%ROWTYPE;
  v_visible integer;
BEGIN
  RESET ROLE;
  SELECT * INTO f FROM a7c1_fix;
  PERFORM set_config('request.jwt.claim.sub', f.self_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', f.self_id, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*) INTO v_visible FROM public.corporate_accounts WHERE id = f.admin_acct;
  IF v_visible <> 1 THEN
    RAISE EXCEPTION 'admin cannot read linked account';
  END IF;

  SELECT count(*) INTO v_visible FROM public.corporate_accounts WHERE id = f.other_acct;
  IF v_visible <> 0 THEN
    RAISE EXCEPTION 'admin can read another account';
  END IF;

  SELECT count(*) INTO v_visible FROM public.corporate_locations WHERE id = f.loc_id;
  IF v_visible <> 1 THEN
    RAISE EXCEPTION 'admin cannot read linked location';
  END IF;

  INSERT INTO public.corporate_locations (corporate_account_id, name, address)
  VALUES (f.admin_acct, 'A7C1 Admin New Location', '1 Admin Street');

  UPDATE public.corporate_locations
  SET address = '1 Admin Road'
  WHERE id = f.loc_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin cannot update linked location';
  END IF;

  SELECT count(*) INTO v_visible FROM public.corporate_users WHERE id = f.emp_id;
  IF v_visible <> 1 THEN
    RAISE EXCEPTION 'admin cannot read linked employees';
  END IF;

  SELECT count(*) INTO v_visible FROM public.corporate_accounts WHERE id = f.viewer_acct;
  IF v_visible <> 1 THEN
    RAISE EXCEPTION 'viewer lost read access';
  END IF;

  SELECT count(*) INTO v_visible FROM public.corporate_users WHERE corporate_account_id = f.viewer_acct;
  IF v_visible <> 0 THEN
    RAISE EXCEPTION 'viewer can read employee rows through write helper';
  END IF;

  BEGIN
    INSERT INTO public.corporate_locations (corporate_account_id, name, address)
    VALUES (f.viewer_acct, 'A7C1 Viewer Location', '3 Viewer Street');
    RAISE EXCEPTION 'viewer location insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$member_rls$;

DO $foreign_rls$
DECLARE
  f a7c1_fix%ROWTYPE;
  v_visible integer;
BEGIN
  RESET ROLE;
  SELECT * INTO f FROM a7c1_fix;
  PERFORM set_config('request.jwt.claim.sub', f.foreign_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', f.foreign_id, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*) INTO v_visible
  FROM public.corporate_accounts
  WHERE id IN (f.admin_acct, f.manager_acct, f.viewer_acct, f.owner_acct);
  IF v_visible <> 0 THEN
    RAISE EXCEPTION 'unrelated user can read fixture corporate accounts';
  END IF;

  BEGIN
    INSERT INTO public.corporate_locations (corporate_account_id, name, address)
    VALUES (f.admin_acct, 'A7C1 Foreign Location', '1 Admin Street');
    RAISE EXCEPTION 'unrelated user location insert was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
END;
$foreign_rls$;

DO $integrity$
BEGIN
  RESET ROLE;
  IF EXISTS (
    SELECT 1
    FROM a7c1_before b
    JOIN pg_proc p ON p.proname = b.proname
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'has_role',
        'update_corporate_account_profile',
        'corporate_new_booking_guard_decision',
        'enforce_corporate_new_booking_guard'
      )
      AND md5(p.prosrc) IS DISTINCT FROM b.body_md5
  ) THEN
    RAISE EXCEPTION 'unrelated function body changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM a7c1_before b
    JOIN pg_proc p ON p.proname = b.proname
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('has_corporate_access', 'can_write_corporate')
      AND p.proacl::text IS DISTINCT FROM b.acl
  ) THEN
    RAISE EXCEPTION 'helper ACL changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM a7c1_counts c
    WHERE c.staff_profiles IS DISTINCT FROM (SELECT count(*) FROM public.staff_profiles)
       OR c.customers IS DISTINCT FROM (SELECT count(*) FROM public.customers)
       OR c.drivers IS DISTINCT FROM (SELECT count(*) FROM public.drivers)
       OR c.trips IS DISTINCT FROM (SELECT count(*) FROM public.trips)
       OR c.payment_sessions IS DISTINCT FROM (SELECT count(*) FROM public.payment_sessions)
       OR c.wallet_rows IS DISTINCT FROM (SELECT count(*) FROM public.driver_wallet_ledger)
       OR c.wallet_sum IS DISTINCT FROM (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger)
       OR c.auth_users IS DISTINCT FROM (SELECT count(*) FROM auth.users)
       OR c.live_company IS DISTINCT FROM (
         SELECT company_name FROM public.corporate_accounts ORDER BY created_at LIMIT 1
       )
  ) THEN
    RAISE EXCEPTION 'live integrity changed inside simulation';
  END IF;
END;
$integrity$;

ROLLBACK;
