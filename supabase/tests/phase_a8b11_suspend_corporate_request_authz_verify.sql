-- Phase A8B11 body-gate simulation. Applies the draft function, probes, then ROLLBACK.
-- Never invokes suspend against live corporate_account_requests rows.
-- Authorized success uses a disposable fixture request inside the transaction.
-- service_role / postgres: privilege checks only (no invoke).

BEGIN;

CREATE TEMP TABLE phase_a8b11_live_hash (
  request_count int NOT NULL,
  pending_count int NOT NULL,
  approved_count int NOT NULL,
  suspended_count int NOT NULL,
  other_count int NOT NULL,
  accounts int NOT NULL,
  corporate_users int NOT NULL,
  notifications int NOT NULL,
  trips int NOT NULL,
  payment_sessions int NOT NULL,
  staff_profiles int NOT NULL,
  role_page_perms int NOT NULL,
  body_md5_before text NOT NULL
) ON COMMIT DROP;

INSERT INTO phase_a8b11_live_hash
SELECT
  (SELECT count(*)::int FROM public.corporate_account_requests),
  (SELECT count(*)::int FROM public.corporate_account_requests WHERE status = 'pending'),
  (SELECT count(*)::int FROM public.corporate_account_requests WHERE status = 'approved'),
  (SELECT count(*)::int FROM public.corporate_account_requests WHERE status = 'suspended'),
  (SELECT count(*)::int FROM public.corporate_account_requests
     WHERE status IS DISTINCT FROM 'pending'
       AND status IS DISTINCT FROM 'approved'
       AND status IS DISTINCT FROM 'suspended'),
  (SELECT count(*)::int FROM public.corporate_accounts),
  (SELECT count(*)::int FROM public.corporate_users),
  (SELECT count(*)::int FROM public.notifications),
  (SELECT count(*)::int FROM public.trips),
  (SELECT count(*)::int FROM public.payment_sessions),
  (SELECT count(*)::int FROM public.staff_profiles),
  (SELECT count(*)::int FROM public.role_page_permissions),
  md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.suspend_corporate_request(uuid,uuid)'::regprocedure));

CREATE OR REPLACE FUNCTION public.suspend_corporate_request(
  p_request_id uuid,
  p_reviewed_by uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
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

  UPDATE public.corporate_account_requests
  SET status = 'suspended',
      suspended_at = now(),
      reviewed_at = now(),
      reviewed_by = v_reviewer,
      updated_at = now()
  WHERE id = p_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
END;
$fn$;

CREATE TEMP TABLE phase_a8b11_live_rows (
  id uuid PRIMARY KEY,
  status text NOT NULL,
  reviewed_by uuid,
  reviewed_at timestamptz,
  suspended_at timestamptz,
  updated_at timestamptz NOT NULL
) ON COMMIT DROP;

INSERT INTO phase_a8b11_live_rows (id, status, reviewed_by, reviewed_at, suspended_at, updated_at)
SELECT id, status, reviewed_by, reviewed_at, suspended_at, updated_at
FROM public.corporate_account_requests;

DO $$
DECLARE
  v_err text;
  v_state text;
  v_customer uuid;
  v_driver uuid;
  v_corporate_user uuid;
  v_staff uuid;
  v_spoof uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid;
  v_fixture uuid := 'aaaaaaaa-bbbb-cccc-dddd-000000000011'::uuid;
  v_fixture_status text;
  v_fixture_reviewer uuid;
  v_missing uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_draft_expected text := md5($body$
DECLARE
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

  UPDATE public.corporate_account_requests
  SET status = 'suspended',
      suspended_at = now(),
      reviewed_at = now(),
      reviewed_by = v_reviewer,
      updated_at = now()
  WHERE id = p_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;
END;
$body$);
BEGIN
  IF has_function_privilege('public', 'public.suspend_corporate_request(uuid,uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.suspend_corporate_request(uuid,uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.suspend_corporate_request(uuid,uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', 'public.suspend_corporate_request(uuid,uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('postgres', 'public.suspend_corporate_request(uuid,uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
  THEN
    RAISE EXCEPTION 'a8b11 acl drift';
  END IF;

  IF has_function_privilege('authenticated', 'public.staff_has_page_access(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'staff_has_page_access must stay non-executable by authenticated';
  END IF;

  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.suspend_corporate_request(uuid,uuid)'::regprocedure))
     IS DISTINCT FROM v_draft_expected THEN
    RAISE EXCEPTION 'draft body hash mismatch after apply (got %, expected %)',
      md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.suspend_corporate_request(uuid,uuid)'::regprocedure)),
      v_draft_expected;
  END IF;

  IF v_draft_expected IS DISTINCT FROM '6b29e6263677b5ecfaef858cdb353ada' THEN
    RAISE EXCEPTION 'canonical proposed hash drifted: %', v_draft_expected;
  END IF;

  -- PUBLIC / anon: no EXECUTE (already checked); skip invoke.

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.suspend_corporate_request(v_missing, v_spoof);
    RESET ROLE;
    RAISE EXCEPTION 'ordinary authenticated succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'ordinary authenticated unexpected: % %', v_state, v_err;
      END IF;
  END;

  SELECT c.user_id INTO v_customer
  FROM public.customers c
  WHERE c.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = c.user_id)
  LIMIT 1;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'no customer without staff profile';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.suspend_corporate_request(v_missing, v_spoof);
    RESET ROLE;
    RAISE EXCEPTION 'customer succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'customer unexpected: % %', v_state, v_err;
      END IF;
  END;

  SELECT d.user_id INTO v_driver
  FROM public.drivers d
  WHERE d.user_id IS NOT NULL
    AND d.user_id <> v_customer
    AND NOT EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = d.user_id)
  LIMIT 1;
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'no driver without staff profile';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.suspend_corporate_request(v_missing, v_spoof);
    RESET ROLE;
    RAISE EXCEPTION 'driver succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'driver unexpected: % %', v_state, v_err;
      END IF;
  END;

  -- No live corporate_users.user_id fixture in this project; use a non-staff
  -- synthetic JWT as the Corporate Portal stand-in (must still get 42501).
  v_corporate_user := 'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid;
  IF EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = v_corporate_user) THEN
    RAISE EXCEPTION 'synthetic corporate portal uid unexpectedly has staff profile';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_corporate_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_corporate_user, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.suspend_corporate_request(v_missing, v_spoof);
    RESET ROLE;
    RAISE EXCEPTION 'corporate portal user succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'corporate portal unexpected: % %', v_state, v_err;
      END IF;
  END;

  INSERT INTO public.staff_profiles (user_id, staff_role_id, full_name, role, is_active, is_owner)
  VALUES (v_customer, 'phase-a8b11-probe', 'phase a8b11 probe', 'operator', false, false);

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.suspend_corporate_request(v_missing, v_spoof);
    RESET ROLE;
    RAISE EXCEPTION 'inactive staff succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'inactive staff unexpected: % %', v_state, v_err;
      END IF;
  END;

  UPDATE public.staff_profiles
  SET is_active = true
  WHERE user_id = v_customer
    AND staff_role_id = 'phase-a8b11-probe'
    AND is_owner = false;

  -- operator has can_access=false for account-requests
  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.suspend_corporate_request(v_missing, v_spoof);
    RESET ROLE;
    RAISE EXCEPTION 'staff without account-requests succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'missing-page staff unexpected: % %', v_state, v_err;
      END IF;
  END;

  SELECT sp.user_id INTO v_staff
  FROM public.staff_profiles sp
  JOIN public.role_page_permissions rpp
    ON rpp.role = sp.role
   AND rpp.page_slug = 'account-requests'
   AND rpp.can_access = true
  WHERE sp.is_active = true
  LIMIT 1;
  IF v_staff IS NULL THEN
    RAISE EXCEPTION 'no active account-requests staff';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.suspend_corporate_request(v_missing, v_spoof);
    RESET ROLE;
    RAISE EXCEPTION 'authorized missing-request probe updated a row';
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state = '42501' OR v_err IS DISTINCT FROM 'Request not found' THEN
        RAISE EXCEPTION 'authorized missing-request probe failed wrong: % %', v_state, v_err;
      END IF;
  END;

  INSERT INTO public.corporate_account_requests (
    id,
    company_name,
    contact_name,
    contact_email,
    status,
    user_id
  ) VALUES (
    v_fixture,
    'Phase A8B11 Fixture Co',
    'Fixture Contact',
    'phase-a8b11-fixture@example.invalid',
    'pending',
    NULL
  );

  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  -- Spoofed reviewer must not stick.
  PERFORM public.suspend_corporate_request(v_fixture, v_spoof);
  RESET ROLE;

  SELECT status, reviewed_by INTO v_fixture_status, v_fixture_reviewer
  FROM public.corporate_account_requests
  WHERE id = v_fixture;

  IF v_fixture_status IS DISTINCT FROM 'suspended' THEN
    RAISE EXCEPTION 'fixture suspend did not set suspended (got %)', v_fixture_status;
  END IF;

  IF v_fixture_reviewer IS DISTINCT FROM v_staff THEN
    RAISE EXCEPTION 'reviewer spoof succeeded: expected staff uid, got %', v_fixture_reviewer;
  END IF;

  IF v_fixture_reviewer = v_spoof THEN
    RAISE EXCEPTION 'spoofed p_reviewed_by was stored';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.corporate_account_requests car
    JOIN phase_a8b11_live_rows lr ON lr.id = car.id
    WHERE car.status IS DISTINCT FROM lr.status
       OR car.reviewed_by IS DISTINCT FROM lr.reviewed_by
       OR car.reviewed_at IS DISTINCT FROM lr.reviewed_at
       OR car.suspended_at IS DISTINCT FROM lr.suspended_at
       OR car.updated_at IS DISTINCT FROM lr.updated_at
  ) THEN
    RAISE EXCEPTION 'live corporate request drift detected';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.corporate_accounts ca
    WHERE lower(ca.contact_email) = lower('phase-a8b11-fixture@example.invalid')
       OR lower(ca.company_name) = lower('Phase A8B11 Fixture Co')
  ) THEN
    RAISE EXCEPTION 'fixture unexpectedly created or matched a corporate account';
  END IF;
END $$;

-- Integrity vs snapshot (live rows unchanged; fixture may add +1 request in-txn)
DO $$
DECLARE
  h phase_a8b11_live_hash%ROWTYPE;
  v_req int;
  v_accounts int;
  v_notif int;
BEGIN
  SELECT * INTO h FROM phase_a8b11_live_hash LIMIT 1;
  SELECT count(*)::int INTO v_req FROM public.corporate_account_requests;
  SELECT count(*)::int INTO v_accounts FROM public.corporate_accounts;
  SELECT count(*)::int INTO v_notif FROM public.notifications;

  IF v_req <> h.request_count + 1 THEN
    RAISE EXCEPTION 'request count drift % -> % (expect +1 fixture)', h.request_count, v_req;
  END IF;
  IF v_accounts <> h.accounts THEN
    RAISE EXCEPTION 'corporate_accounts drift';
  END IF;
  IF v_notif <> h.notifications THEN
    RAISE EXCEPTION 'notifications drift';
  END IF;
  IF (SELECT count(*)::int FROM public.corporate_users) <> h.corporate_users THEN
    RAISE EXCEPTION 'corporate_users drift';
  END IF;
  IF (SELECT count(*)::int FROM public.trips) <> h.trips THEN
    RAISE EXCEPTION 'trips drift';
  END IF;
  IF (SELECT count(*)::int FROM public.payment_sessions) <> h.payment_sessions THEN
    RAISE EXCEPTION 'payment_sessions drift';
  END IF;
  IF (SELECT count(*)::int FROM public.role_page_permissions) <> h.role_page_perms THEN
    RAISE EXCEPTION 'role_page_permissions drift';
  END IF;
END $$;

SELECT
  h.request_count AS requests_before,
  h.pending_count AS pending_before,
  h.approved_count AS approved_before,
  h.suspended_count AS suspended_before,
  (SELECT count(*)::int FROM public.corporate_account_requests) AS requests_after_incl_fixture,
  (SELECT count(*)::int FROM public.corporate_account_requests WHERE status = 'suspended') AS suspended_after_incl_fixture,
  (SELECT status FROM public.corporate_account_requests WHERE id = 'aaaaaaaa-bbbb-cccc-dddd-000000000011'::uuid) AS fixture_status,
  (SELECT reviewed_by IS NOT NULL FROM public.corporate_account_requests WHERE id = 'aaaaaaaa-bbbb-cccc-dddd-000000000011'::uuid) AS fixture_has_reviewer,
  has_function_privilege('authenticated', 'public.suspend_corporate_request(uuid,uuid)'::regprocedure, 'EXECUTE') AS auth_exec,
  has_function_privilege('service_role', 'public.suspend_corporate_request(uuid,uuid)'::regprocedure, 'EXECUTE') AS svc_exec,
  has_function_privilege('postgres', 'public.suspend_corporate_request(uuid,uuid)'::regprocedure, 'EXECUTE') AS pg_exec,
  has_function_privilege('public', 'public.suspend_corporate_request(uuid,uuid)'::regprocedure, 'EXECUTE') AS public_exec,
  has_function_privilege('anon', 'public.suspend_corporate_request(uuid,uuid)'::regprocedure, 'EXECUTE') AS anon_exec,
  md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.suspend_corporate_request(uuid,uuid)'::regprocedure)) AS draft_body_hash,
  '6b29e6263677b5ecfaef858cdb353ada'::text AS expected_draft_hash,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109230000') AS migration_applied,
  h.accounts AS corporate_accounts,
  h.corporate_users AS corporate_users,
  h.notifications AS notifications
FROM phase_a8b11_live_hash h;

ROLLBACK;
