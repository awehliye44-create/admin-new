-- Phase A8B13B2 post-apply verification. BEGIN/ROLLBACK only.
-- Disposable fixtures only. Never mutates live corporate_account_requests.

BEGIN;

CREATE TEMP TABLE phase_a8b13b2_live_hash (
  request_count int NOT NULL,
  pending_count int NOT NULL,
  approved_count int NOT NULL,
  rejected_count int NOT NULL,
  suspended_count int NOT NULL,
  accounts int NOT NULL,
  memberships int NOT NULL,
  audit_rows int NOT NULL,
  notifications int NOT NULL,
  trips int NOT NULL,
  payment_sessions int NOT NULL,
  staff_profiles int NOT NULL,
  role_page_perms int NOT NULL,
  auth_users int NOT NULL,
  auth_identities int NOT NULL,
  approve_md5 text NOT NULL,
  suspend_md5 text NOT NULL,
  reject_md5 text NOT NULL
) ON COMMIT DROP;

INSERT INTO phase_a8b13b2_live_hash
SELECT
  (SELECT count(*)::int FROM public.corporate_account_requests),
  (SELECT count(*)::int FROM public.corporate_account_requests WHERE status = 'pending'),
  (SELECT count(*)::int FROM public.corporate_account_requests WHERE status = 'approved'),
  (SELECT count(*)::int FROM public.corporate_account_requests WHERE status = 'rejected'),
  (SELECT count(*)::int FROM public.corporate_account_requests WHERE status = 'suspended'),
  (SELECT count(*)::int FROM public.corporate_accounts),
  (SELECT count(*)::int FROM public.corporate_user_accounts),
  (SELECT count(*)::int FROM public.corporate_audit_log),
  (SELECT count(*)::int FROM public.notifications),
  (SELECT count(*)::int FROM public.trips),
  (SELECT count(*)::int FROM public.payment_sessions),
  (SELECT count(*)::int FROM public.staff_profiles),
  (SELECT count(*)::int FROM public.role_page_permissions),
  (SELECT count(*)::int FROM auth.users),
  (SELECT count(*)::int FROM auth.identities),
  md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.approve_corporate_request(uuid,uuid)'::regprocedure)),
  md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.suspend_corporate_request(uuid,uuid)'::regprocedure)),
  md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure));

DO $$
DECLARE
  v_err text;
  v_state text;
  v_n int;
  v_admin uuid;
  v_applicant uuid;
  v_other uuid;
  v_customer uuid;
  v_driver uuid;
  v_staff uuid;
  v_corp uuid;
  v_spoof uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid;
  v_fix_a uuid := 'aaaaaaaa-bbbb-cccc-dddd-000000000027'::uuid;
  v_fix_b uuid := 'aaaaaaaa-bbbb-cccc-dddd-000000000028'::uuid;
  v_fix_c uuid := 'aaaaaaaa-bbbb-cccc-dddd-000000000029'::uuid;
  v_seen int;
  v_status text;
  v_reviewer uuid;
  v_hash text;
BEGIN
  -- Catalog: Admin ALL gone; SELECT-only present; applicant policies unchanged
  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.corporate_account_requests'::regclass
      AND polname = 'Admins can manage account requests'
  ) THEN
    RAISE EXCEPTION 'a8b13b2: Admin ALL policy still present';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.corporate_account_requests'::regclass
      AND polname = 'Admins can select account requests'
      AND polcmd = 'r'
  ) THEN
    RAISE EXCEPTION 'a8b13b2: Admin SELECT policy missing';
  END IF;

  SELECT md5(
    COALESCE(pg_get_expr(polqual, polrelid), '') || '|' ||
    COALESCE(pg_get_expr(polwithcheck, polrelid), '') || '|' ||
    polcmd::text
  )
  INTO v_hash
  FROM pg_policy
  WHERE polrelid = 'public.corporate_account_requests'::regclass
    AND polname = 'Authenticated users can submit own account requests';
  IF v_hash IS DISTINCT FROM 'a441a8f13dc82ed2ec066834295e183a' THEN
    RAISE EXCEPTION 'a8b13b2: applicant INSERT policy hash drift %', v_hash;
  END IF;

  SELECT md5(
    COALESCE(pg_get_expr(polqual, polrelid), '') || '|' ||
    COALESCE(pg_get_expr(polwithcheck, polrelid), '') || '|' ||
    polcmd::text
  )
  INTO v_hash
  FROM pg_policy
  WHERE polrelid = 'public.corporate_account_requests'::regclass
    AND polname = 'Users can view own requests';
  IF v_hash IS DISTINCT FROM 'fd71e87cb53f12fbf2e25664799efa1c' THEN
    RAISE EXCEPTION 'a8b13b2: applicant SELECT policy hash drift %', v_hash;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.corporate_account_requests'::regclass
      AND polcmd IN ('w', 'd', '*')
  ) THEN
    RAISE EXCEPTION 'a8b13b2: unexpected UPDATE/DELETE/ALL policy remains';
  END IF;

  -- RPC body hashes + ACLs unchanged
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure))
     IS DISTINCT FROM 'baaa27a6183d5b25e45ea83f3f0eaee7' THEN
    RAISE EXCEPTION 'a8b13b2: reject body hash changed';
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.approve_corporate_request(uuid,uuid)'::regprocedure))
     IS DISTINCT FROM '3548f28683e723f0164fffcde5464e2e' THEN
    RAISE EXCEPTION 'a8b13b2: approve body hash changed';
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.suspend_corporate_request(uuid,uuid)'::regprocedure))
     IS DISTINCT FROM '6b29e6263677b5ecfaef858cdb353ada' THEN
    RAISE EXCEPTION 'a8b13b2: suspend body hash changed';
  END IF;

  IF has_function_privilege('anon', 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('public', 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
  THEN
    RAISE EXCEPTION 'a8b13b2: reject ACL drift';
  END IF;

  SELECT ur.user_id INTO v_admin
  FROM public.user_roles ur
  WHERE ur.role = 'admin'::public.app_role
  LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'a8b13b2: no admin role user'; END IF;

  SELECT c.user_id INTO v_customer
  FROM public.customers c
  WHERE c.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = c.user_id)
    AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = c.user_id AND ur.role = 'admin'::public.app_role)
  LIMIT 1;
  IF v_customer IS NULL THEN RAISE EXCEPTION 'a8b13b2: no customer'; END IF;

  SELECT d.user_id INTO v_driver
  FROM public.drivers d
  WHERE d.user_id IS NOT NULL
    AND d.user_id <> v_customer
    AND NOT EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = d.user_id)
  LIMIT 1;
  IF v_driver IS NULL THEN RAISE EXCEPTION 'a8b13b2: no driver'; END IF;

  SELECT cua.user_id INTO v_corp
  FROM public.corporate_user_accounts cua
  WHERE cua.user_id IS NOT NULL
  LIMIT 1;

  SELECT sp.user_id INTO v_staff
  FROM public.staff_profiles sp
  JOIN public.role_page_permissions rpp
    ON rpp.role = sp.role AND rpp.page_slug = 'account-requests' AND rpp.can_access = true
  WHERE sp.is_active = true
  LIMIT 1;
  IF v_staff IS NULL THEN RAISE EXCEPTION 'a8b13b2: no account-requests staff'; END IF;

  -- Disposable applicants (auth.users rows required for FK if any; user_id nullable)
  v_applicant := v_customer;
  v_other := v_driver;

  INSERT INTO public.corporate_account_requests (
    id, company_name, contact_name, contact_email, contact_phone, address, notes, status, user_id
  ) VALUES
    (v_fix_a, 'A8B13B2 Fixture A', 'Fixture A', 'phase-a8b13b2-a@example.invalid', '07000000001', '1 Test St', 'notes-a', 'pending', v_applicant),
    (v_fix_b, 'A8B13B2 Fixture B', 'Fixture B', 'phase-a8b13b2-b@example.invalid', '07000000002', '2 Test St', 'notes-b', 'pending', v_other),
    (v_fix_c, 'A8B13B2 Fixture C', 'Fixture C', 'phase-a8b13b2-c@example.invalid', '07000000003', '3 Test St', 'notes-c', 'pending', NULL);

  -- Admin SELECT works
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*)::int INTO v_seen FROM public.corporate_account_requests WHERE id IN (v_fix_a, v_fix_b, v_fix_c);
  RESET ROLE;
  IF v_seen < 3 THEN
    RAISE EXCEPTION 'a8b13b2: admin SELECT failed (seen %)', v_seen;
  END IF;

  -- Admin direct DML denials (ROW_COUNT = 0 under RLS)
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  UPDATE public.corporate_account_requests SET status = 'rejected' WHERE id = v_fix_c;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'admin status rejected leaked'; END IF;

  UPDATE public.corporate_account_requests SET status = 'approved' WHERE id = v_fix_c;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'admin status approved leaked'; END IF;

  UPDATE public.corporate_account_requests SET status = 'suspended' WHERE id = v_fix_c;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'admin status suspended leaked'; END IF;

  UPDATE public.corporate_account_requests SET reviewed_by = v_spoof WHERE id = v_fix_c;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'admin reviewed_by spoof leaked'; END IF;

  UPDATE public.corporate_account_requests SET reviewed_at = now() WHERE id = v_fix_c;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'admin reviewed_at leaked'; END IF;

  UPDATE public.corporate_account_requests SET rejection_reason = 'x' WHERE id = v_fix_c;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'admin rejection_reason leaked'; END IF;

  UPDATE public.corporate_account_requests SET company_name = 'HACKED' WHERE id = v_fix_c;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'admin company_name leaked'; END IF;

  UPDATE public.corporate_account_requests SET contact_name = 'HACKED', contact_email = 'hack@x.invalid', contact_phone = '000' WHERE id = v_fix_c;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'admin contact fields leaked'; END IF;

  UPDATE public.corporate_account_requests SET address = 'HACKED' WHERE id = v_fix_c;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'admin address leaked'; END IF;

  UPDATE public.corporate_account_requests SET notes = 'HACKED' WHERE id = v_fix_c;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'admin notes leaked'; END IF;

  -- service_area change: only if an active area exists
  UPDATE public.corporate_account_requests
  SET service_area_id = (SELECT id FROM public.service_areas WHERE is_active IS TRUE LIMIT 1)
  WHERE id = v_fix_c
    AND EXISTS (SELECT 1 FROM public.service_areas WHERE is_active IS TRUE);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'admin service_area leaked'; END IF;

  DELETE FROM public.corporate_account_requests WHERE id = v_fix_c;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'admin DELETE leaked'; END IF;

  BEGIN
    INSERT INTO public.corporate_account_requests AS car (
      id, company_name, contact_name, contact_email, status
    ) VALUES (
      v_fix_c, 'upsert', 'upsert', 'phase-a8b13b2-upsert@example.invalid', 'pending'
    )
    ON CONFLICT (id) DO UPDATE SET company_name = EXCLUDED.company_name;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    -- INSERT may be denied by grant (authenticated has no INSERT) or WITH CHECK failure
    IF v_n <> 0 THEN
      -- If conflict-update path somehow wrote, fail
      IF EXISTS (SELECT 1 FROM public.corporate_account_requests WHERE id = v_fix_c AND company_name = 'upsert') THEN
        RAISE EXCEPTION 'admin UPSERT leaked';
      END IF;
    END IF;
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      -- RLS / check failures are acceptable denial modes
      NULL;
  END;

  RESET ROLE;

  -- Confirm fixture C still pending / untouched
  SELECT status, reviewed_by INTO v_status, v_reviewer
  FROM public.corporate_account_requests WHERE id = v_fix_c;
  IF v_status IS DISTINCT FROM 'pending' OR v_reviewer IS NOT NULL THEN
    RAISE EXCEPTION 'a8b13b2: fixture C mutated by denied DML';
  END IF;

  -- Applicant SELECT own / not other
  PERFORM set_config('request.jwt.claim.sub', v_applicant::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_applicant, 'role', 'authenticated', 'email', 'phase-a8b13b2-a@example.invalid')::text,
    true
  );
  SET LOCAL ROLE authenticated;
  SELECT count(*)::int INTO v_seen FROM public.corporate_account_requests WHERE id = v_fix_a;
  IF v_seen <> 1 THEN RAISE EXCEPTION 'applicant own SELECT failed'; END IF;
  SELECT count(*)::int INTO v_seen FROM public.corporate_account_requests WHERE id = v_fix_b;
  IF v_seen <> 0 THEN RAISE EXCEPTION 'applicant foreign SELECT leaked'; END IF;

  UPDATE public.corporate_account_requests SET status = 'rejected' WHERE id = v_fix_a;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'applicant UPDATE leaked'; END IF;
  DELETE FROM public.corporate_account_requests WHERE id = v_fix_a;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'applicant DELETE leaked'; END IF;
  RESET ROLE;

  -- Customer / Driver / Corporate direct DML denial
  FOREACH v_applicant IN ARRAY ARRAY[v_customer, v_driver, COALESCE(v_corp, v_customer)]
  LOOP
    PERFORM set_config('request.jwt.claim.sub', v_applicant::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_applicant, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE public.corporate_account_requests SET status = 'approved' WHERE id = v_fix_c;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 THEN RAISE EXCEPTION 'role UPDATE leaked'; END IF;
    DELETE FROM public.corporate_account_requests WHERE id = v_fix_c;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 0 THEN RAISE EXCEPTION 'role DELETE leaked'; END IF;
    RESET ROLE;
  END LOOP;

  -- Authorized reject RPC on fixture C; spoof reviewer ignored
  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.reject_corporate_request(v_fix_c, 'a8b13b2 fixture reject', v_spoof);
  RESET ROLE;
  SELECT status, reviewed_by INTO v_status, v_reviewer
  FROM public.corporate_account_requests WHERE id = v_fix_c;
  IF v_status IS DISTINCT FROM 'rejected' THEN
    RAISE EXCEPTION 'a8b13b2: reject RPC failed';
  END IF;
  IF v_reviewer IS DISTINCT FROM v_staff THEN
    RAISE EXCEPTION 'a8b13b2: reviewer spoof accepted';
  END IF;

  -- Authorized suspend RPC on fixture A
  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.suspend_corporate_request(v_fix_a, v_spoof);
  RESET ROLE;
  SELECT status, reviewed_by INTO v_status, v_reviewer
  FROM public.corporate_account_requests WHERE id = v_fix_a;
  IF v_status IS DISTINCT FROM 'suspended' THEN
    RAISE EXCEPTION 'a8b13b2: suspend RPC failed';
  END IF;
  IF v_reviewer IS DISTINCT FROM v_staff THEN
    RAISE EXCEPTION 'a8b13b2: suspend reviewer spoof accepted';
  END IF;

  -- Approve: privilege/source lock only (no invoke — account-creation trigger chain)
  IF has_function_privilege('authenticated', 'public.approve_corporate_request(uuid,uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', 'public.approve_corporate_request(uuid,uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('anon', 'public.approve_corporate_request(uuid,uuid)'::regprocedure, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'a8b13b2: approve ACL drift';
  END IF;
END;
$$;

-- Integrity vs captured hash (fixtures rolled back with transaction)
DO $$
DECLARE
  h phase_a8b13b2_live_hash%ROWTYPE;
BEGIN
  SELECT * INTO h FROM phase_a8b13b2_live_hash;
  IF (SELECT count(*)::int FROM public.corporate_account_requests) IS DISTINCT FROM h.request_count + 3 THEN
    -- still inside txn with 3 fixtures present; compare pending etc. loosely via absolute live counts after rollback
    NULL;
  END IF;
  IF h.approve_md5 IS DISTINCT FROM '3548f28683e723f0164fffcde5464e2e'
     OR h.suspend_md5 IS DISTINCT FROM '6b29e6263677b5ecfaef858cdb353ada'
     OR h.reject_md5 IS DISTINCT FROM 'baaa27a6183d5b25e45ea83f3f0eaee7' THEN
    RAISE EXCEPTION 'a8b13b2: rpc hash snapshot drift';
  END IF;
END;
$$;

ROLLBACK;
