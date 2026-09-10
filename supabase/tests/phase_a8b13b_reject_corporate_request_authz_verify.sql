-- Phase A8B13B reject RPC simulation. Applies draft function, probes, ROLLBACK.
-- Never rejects live corporate_account_requests rows.
-- Authorized success uses a disposable fixture request inside the transaction.
-- service_role / postgres: privilege checks only (no invoke).

BEGIN;

CREATE TEMP TABLE phase_a8b13b_live_hash (
  request_count int NOT NULL,
  pending_count int NOT NULL,
  approved_count int NOT NULL,
  rejected_count int NOT NULL,
  accounts int NOT NULL,
  notifications int NOT NULL,
  trips int NOT NULL,
  payment_sessions int NOT NULL,
  staff_profiles int NOT NULL,
  role_page_perms int NOT NULL
) ON COMMIT DROP;

INSERT INTO phase_a8b13b_live_hash
SELECT
  (SELECT count(*)::int FROM public.corporate_account_requests),
  (SELECT count(*)::int FROM public.corporate_account_requests WHERE status = 'pending'),
  (SELECT count(*)::int FROM public.corporate_account_requests WHERE status = 'approved'),
  (SELECT count(*)::int FROM public.corporate_account_requests WHERE status = 'rejected'),
  (SELECT count(*)::int FROM public.corporate_accounts),
  (SELECT count(*)::int FROM public.notifications),
  (SELECT count(*)::int FROM public.trips),
  (SELECT count(*)::int FROM public.payment_sessions),
  (SELECT count(*)::int FROM public.staff_profiles),
  (SELECT count(*)::int FROM public.role_page_permissions);

CREATE OR REPLACE FUNCTION public.reject_corporate_request(
  p_request_id uuid,
  p_rejection_reason text DEFAULT NULL::text,
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
  v_reason text;
  v_status text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.staff_has_page_access('account-requests') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  v_reviewer := CASE
    WHEN auth.role() = 'service_role' THEN COALESCE(p_reviewed_by, auth.uid())
    ELSE auth.uid()
  END;

  v_reason := NULLIF(btrim(COALESCE(p_rejection_reason, '')), '');
  IF v_reason IS NOT NULL AND char_length(v_reason) > 2000 THEN
    RAISE EXCEPTION 'rejection reason too long';
  END IF;

  SELECT status INTO v_status
  FROM public.corporate_account_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found';
  END IF;

  IF v_status IS DISTINCT FROM 'pending'
     AND v_status IS DISTINCT FROM 'under_review' THEN
    RAISE EXCEPTION 'Request cannot be rejected from status %', v_status;
  END IF;

  UPDATE public.corporate_account_requests
  SET status = 'rejected',
      rejection_reason = v_reason,
      reviewed_at = now(),
      reviewed_by = v_reviewer,
      updated_at = now()
  WHERE id = p_request_id;
END;
$fn$;

CREATE TEMP TABLE phase_a8b13b_live_rows (
  id uuid PRIMARY KEY,
  status text NOT NULL,
  reviewed_by uuid,
  reviewed_at timestamptz,
  rejection_reason text,
  updated_at timestamptz NOT NULL
) ON COMMIT DROP;

INSERT INTO phase_a8b13b_live_rows (id, status, reviewed_by, reviewed_at, rejection_reason, updated_at)
SELECT id, status, reviewed_by, reviewed_at, rejection_reason, updated_at
FROM public.corporate_account_requests;

DO $$
DECLARE
  v_err text;
  v_state text;
  v_customer uuid;
  v_driver uuid;
  v_staff uuid;
  v_spoof uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid;
  v_fixture uuid := 'aaaaaaaa-bbbb-cccc-dddd-000000000026'::uuid;
  v_approved uuid;
  v_missing uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_fixture_status text;
  v_fixture_reviewer uuid;
  v_draft_expected text := 'baaa27a6183d5b25e45ea83f3f0eaee7';
BEGIN
  IF has_function_privilege('public', 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
  THEN
    RAISE EXCEPTION 'a8b13b acl drift';
  END IF;

  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure))
     IS DISTINCT FROM v_draft_expected THEN
    RAISE EXCEPTION 'draft body hash mismatch (got %)',
      md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure));
  END IF;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.reject_corporate_request(v_missing, 'x', v_spoof);
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
  IF v_customer IS NULL THEN RAISE EXCEPTION 'no customer'; END IF;

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.reject_corporate_request(v_missing, 'x', v_spoof);
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
  IF v_driver IS NULL THEN RAISE EXCEPTION 'no driver'; END IF;

  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.reject_corporate_request(v_missing, 'x', v_spoof);
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

  INSERT INTO public.staff_profiles (user_id, staff_role_id, full_name, role, is_active, is_owner)
  VALUES (v_customer, 'phase-a8b13b-probe', 'phase a8b13b probe', 'operator', false, false);

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.reject_corporate_request(v_missing, 'x', v_spoof);
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

  UPDATE public.staff_profiles SET is_active = true
  WHERE user_id = v_customer AND staff_role_id = 'phase-a8b13b-probe';

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.reject_corporate_request(v_missing, 'x', v_spoof);
    RESET ROLE;
    RAISE EXCEPTION 'staff without page succeeded';
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
    ON rpp.role = sp.role AND rpp.page_slug = 'account-requests' AND rpp.can_access = true
  WHERE sp.is_active = true
  LIMIT 1;
  IF v_staff IS NULL THEN RAISE EXCEPTION 'no account-requests staff'; END IF;

  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.reject_corporate_request(v_missing, 'x', v_spoof);
    RESET ROLE;
    RAISE EXCEPTION 'authorized missing succeeded';
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state = '42501' OR v_err IS DISTINCT FROM 'Request not found' THEN
        RAISE EXCEPTION 'authorized missing wrong: % %', v_state, v_err;
      END IF;
  END;

  -- Approved live row cannot be rejected (status guard); no mutation
  SELECT id INTO v_approved FROM public.corporate_account_requests WHERE status = 'approved' LIMIT 1;
  IF v_approved IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM public.reject_corporate_request(v_approved, 'should fail', v_spoof);
      RESET ROLE;
      RAISE EXCEPTION 'approved reject succeeded';
    EXCEPTION
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
        RESET ROLE;
        IF v_err NOT LIKE 'Request cannot be rejected from status%' THEN
          RAISE EXCEPTION 'approved reject unexpected: % %', v_state, v_err;
        END IF;
    END;
  END IF;

  INSERT INTO public.corporate_account_requests (
    id, company_name, contact_name, contact_email, status, user_id
  ) VALUES (
    v_fixture,
    'Phase A8B13B Fixture Co',
    'Fixture Contact',
    'phase-a8b13b-fixture@example.invalid',
    'pending',
    NULL
  );

  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.reject_corporate_request(v_fixture, 'fixture reject', v_spoof);
  RESET ROLE;

  SELECT status, reviewed_by INTO v_fixture_status, v_fixture_reviewer
  FROM public.corporate_account_requests WHERE id = v_fixture;

  IF v_fixture_status IS DISTINCT FROM 'rejected' THEN
    RAISE EXCEPTION 'fixture not rejected (got %)', v_fixture_status;
  END IF;
  IF v_fixture_reviewer IS DISTINCT FROM v_staff OR v_fixture_reviewer = v_spoof THEN
    RAISE EXCEPTION 'reviewer spoof / binding failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.corporate_account_requests car
    JOIN phase_a8b13b_live_rows lr ON lr.id = car.id
    WHERE car.status IS DISTINCT FROM lr.status
       OR car.reviewed_by IS DISTINCT FROM lr.reviewed_by
       OR car.reviewed_at IS DISTINCT FROM lr.reviewed_at
       OR car.rejection_reason IS DISTINCT FROM lr.rejection_reason
       OR car.updated_at IS DISTINCT FROM lr.updated_at
  ) THEN
    RAISE EXCEPTION 'live corporate request drift';
  END IF;

  IF (SELECT count(*)::int FROM public.corporate_accounts) <> (SELECT accounts FROM phase_a8b13b_live_hash) THEN
    RAISE EXCEPTION 'corporate_accounts drift';
  END IF;
  IF (SELECT count(*)::int FROM public.notifications) <> (SELECT notifications FROM phase_a8b13b_live_hash) THEN
    RAISE EXCEPTION 'notifications drift';
  END IF;
END $$;

SELECT
  h.request_count AS requests_before,
  (SELECT count(*)::int FROM public.corporate_account_requests) AS requests_after_incl_fixture,
  h.pending_count AS pending_before,
  h.approved_count AS approved_before,
  h.rejected_count AS rejected_before,
  (SELECT status FROM public.corporate_account_requests WHERE id = 'aaaaaaaa-bbbb-cccc-dddd-000000000026'::uuid) AS fixture_status,
  has_function_privilege('authenticated', 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure, 'EXECUTE') AS auth_exec,
  has_function_privilege('anon', 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure, 'EXECUTE') AS anon_exec,
  md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.reject_corporate_request(uuid,text,uuid)'::regprocedure)) AS draft_body_hash,
  'baaa27a6183d5b25e45ea83f3f0eaee7'::text AS expected_draft_hash,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
       AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109260000') AS migration_applied,
  h.accounts AS corporate_accounts,
  h.notifications AS notifications
FROM phase_a8b13b_live_hash h;

ROLLBACK;
