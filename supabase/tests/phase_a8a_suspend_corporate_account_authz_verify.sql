-- Phase A8A body-gate simulation. Applies the draft function, probes, then ROLLBACK.
-- Does not call service_role or postgres EXECUTE on suspend.
-- Does not suspend the live corporate account UUID.
-- Authorized success branch uses a disposable fixture account inside the transaction.

BEGIN;

CREATE OR REPLACE FUNCTION public.suspend_corporate_account(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.staff_has_page_access('corporate-accounts') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE corporate_accounts
  SET status = 'suspended', updated_at = now()
  WHERE id = p_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found';
  END IF;
END;
$fn$;

CREATE TEMP TABLE phase_a8a_live_account (
  live_id uuid PRIMARY KEY,
  live_status text NOT NULL,
  live_updated_at timestamptz NOT NULL
) ON COMMIT DROP;

INSERT INTO phase_a8a_live_account (live_id, live_status, live_updated_at)
SELECT id, status, updated_at
FROM public.corporate_accounts
ORDER BY created_at
LIMIT 1;

CREATE TEMP TABLE phase_a8a_status (
  label text PRIMARY KEY,
  total int,
  active int,
  suspended int,
  other int
) ON COMMIT DROP;

INSERT INTO phase_a8a_status
SELECT
  'before',
  count(*)::int,
  count(*) FILTER (WHERE status = 'active')::int,
  count(*) FILTER (WHERE status = 'suspended')::int,
  count(*) FILTER (WHERE status IS DISTINCT FROM 'active' AND status IS DISTINCT FROM 'suspended')::int
FROM public.corporate_accounts;

DO $$
DECLARE
  v_err text;
  v_state text;
  v_customer uuid;
  v_driver uuid;
  v_corporate_user uuid;
  v_staff uuid;
  v_before int;
  v_after int;
  v_fixture uuid := 'aaaaaaaa-bbbb-cccc-dddd-000000000001'::uuid;
  v_fixture_status text;
  v_live phase_a8a_live_account%ROWTYPE;
BEGIN
  SELECT * INTO v_live FROM phase_a8a_live_account LIMIT 1;
  IF v_live.live_id IS NULL THEN
    RAISE EXCEPTION 'no live corporate account row to guard';
  END IF;

  IF has_function_privilege('public', 'public.suspend_corporate_account(uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.suspend_corporate_account(uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.suspend_corporate_account(uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', 'public.suspend_corporate_account(uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('postgres', 'public.suspend_corporate_account(uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
  THEN
    RAISE EXCEPTION 'a8a acl drift';
  END IF;

  IF has_function_privilege('authenticated', 'public.staff_has_page_access(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'staff_has_page_access must stay non-executable by authenticated';
  END IF;

  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.suspend_corporate_account(uuid)'::regprocedure))
     <> md5($body$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.staff_has_page_access('corporate-accounts') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE corporate_accounts
  SET status = 'suspended', updated_at = now()
  WHERE id = p_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found';
  END IF;
END;
$body$) THEN
    RAISE EXCEPTION 'draft body hash mismatch after apply';
  END IF;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.suspend_corporate_account('00000000-0000-0000-0000-000000000000'::uuid);
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
    PERFORM public.suspend_corporate_account('00000000-0000-0000-0000-000000000000'::uuid);
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
    PERFORM public.suspend_corporate_account('00000000-0000-0000-0000-000000000000'::uuid);
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

  SELECT cua.user_id INTO v_corporate_user
  FROM public.corporate_user_accounts cua
  WHERE cua.user_id IS NOT NULL
  LIMIT 1;
  IF v_corporate_user IS NULL THEN
    RAISE EXCEPTION 'no corporate portal user';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_corporate_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_corporate_user, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.suspend_corporate_account('00000000-0000-0000-0000-000000000000'::uuid);
    RESET ROLE;
    RAISE EXCEPTION 'corporate user succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state <> '42501' THEN
        RAISE EXCEPTION 'corporate user unexpected: % %', v_state, v_err;
      END IF;
  END;

  INSERT INTO public.staff_profiles (user_id, staff_role_id, full_name, role, is_active, is_owner)
  VALUES (v_customer, 'phase-a8a-probe', 'phase a8a probe', 'operator', false, false);

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.suspend_corporate_account('00000000-0000-0000-0000-000000000000'::uuid);
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
    AND staff_role_id = 'phase-a8a-probe'
    AND is_owner = false;

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.suspend_corporate_account('00000000-0000-0000-0000-000000000000'::uuid);
    RESET ROLE;
    RAISE EXCEPTION 'staff without corporate-accounts succeeded';
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
   AND rpp.page_slug = 'corporate-accounts'
   AND rpp.can_access = true
  WHERE sp.is_active = true
  LIMIT 1;
  IF v_staff IS NULL THEN
    RAISE EXCEPTION 'no active corporate-accounts staff';
  END IF;

  SELECT count(*)::int INTO v_before FROM public.corporate_accounts WHERE status = 'suspended';

  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.suspend_corporate_account('00000000-0000-0000-0000-000000000000'::uuid);
    RESET ROLE;
    RAISE EXCEPTION 'authorized missing-account probe updated a row';
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state = '42501' OR v_err IS DISTINCT FROM 'Account not found' THEN
        RAISE EXCEPTION 'authorized missing-account probe failed wrong: % %', v_state, v_err;
      END IF;
  END;

  SELECT count(*)::int INTO v_after FROM public.corporate_accounts WHERE status = 'suspended';
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'authorized missing-account probe changed suspended count % -> %', v_before, v_after;
  END IF;

  INSERT INTO public.corporate_accounts (
    id,
    company_name,
    contact_name,
    contact_email,
    status
  ) VALUES (
    v_fixture,
    'Phase A8A Fixture Co',
    'Fixture Contact',
    'phase-a8a-fixture@example.invalid',
    'active'
  );

  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM public.suspend_corporate_account(v_fixture);
  RESET ROLE;

  SELECT status INTO v_fixture_status
  FROM public.corporate_accounts
  WHERE id = v_fixture;
  IF v_fixture_status IS DISTINCT FROM 'suspended' THEN
    RAISE EXCEPTION 'fixture suspend did not set suspended (got %)', v_fixture_status;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.corporate_accounts ca
    JOIN phase_a8a_live_account la ON la.live_id = ca.id
    WHERE ca.status IS DISTINCT FROM la.live_status
       OR ca.updated_at IS DISTINCT FROM la.live_updated_at
  ) THEN
    RAISE EXCEPTION 'live corporate account drift detected';
  END IF;
END $$;

INSERT INTO phase_a8a_status
SELECT
  'after_probes',
  count(*)::int,
  count(*) FILTER (WHERE status = 'active')::int,
  count(*) FILTER (WHERE status = 'suspended')::int,
  count(*) FILTER (WHERE status IS DISTINCT FROM 'active' AND status IS DISTINCT FROM 'suspended')::int
FROM public.corporate_accounts;

DO $$
DECLARE
  b phase_a8a_status%ROWTYPE;
  a phase_a8a_status%ROWTYPE;
  v_live phase_a8a_live_account%ROWTYPE;
BEGIN
  SELECT * INTO b FROM phase_a8a_status WHERE label = 'before';
  SELECT * INTO a FROM phase_a8a_status WHERE label = 'after_probes';
  SELECT * INTO v_live FROM phase_a8a_live_account LIMIT 1;

  IF a.total <> b.total + 1 THEN
    RAISE EXCEPTION 'unexpected account count drift % -> % (fixture only)', b.total, a.total;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.corporate_accounts ca
    WHERE ca.id = v_live.live_id
      AND (ca.status IS DISTINCT FROM v_live.live_status OR ca.updated_at IS DISTINCT FROM v_live.live_updated_at)
  ) THEN
    RAISE EXCEPTION 'live account changed during simulation';
  END IF;
END $$;

SELECT
  b.total AS accounts_before,
  b.active AS active_before,
  b.suspended AS suspended_before,
  a.total AS accounts_after,
  a.active AS active_after,
  a.suspended AS suspended_after,
  (SELECT status FROM public.corporate_accounts ca JOIN phase_a8a_live_account la ON la.live_id = ca.id) AS live_status_after,
  (SELECT live_updated_at = ca.updated_at FROM public.corporate_accounts ca JOIN phase_a8a_live_account la ON la.live_id = ca.id) AS live_updated_at_unchanged,
  (SELECT status FROM public.corporate_accounts WHERE id = 'aaaaaaaa-bbbb-cccc-dddd-000000000001'::uuid) AS fixture_status_after,
  has_function_privilege('authenticated', 'public.suspend_corporate_account(uuid)'::regprocedure, 'EXECUTE') AS auth_exec,
  has_function_privilege('service_role', 'public.suspend_corporate_account(uuid)'::regprocedure, 'EXECUTE') AS svc_exec,
  has_function_privilege('postgres', 'public.suspend_corporate_account(uuid)'::regprocedure, 'EXECUTE') AS pg_exec,
  has_function_privilege('public', 'public.suspend_corporate_account(uuid)'::regprocedure, 'EXECUTE') AS public_exec,
  has_function_privilege('anon', 'public.suspend_corporate_account(uuid)'::regprocedure, 'EXECUTE') AS anon_exec,
  md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.suspend_corporate_account(uuid)'::regprocedure)) AS draft_body_hash,
  (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'reactivate_corporate_account') AS reactivate_hash,
  (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'update_corporate_account_profile') AS update_profile_hash,
  (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'has_role' AND pg_get_function_identity_arguments(p.oid) = '_user_id uuid, _role app_role') AS has_role_hash,
  (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'is_super_admin') AS is_super_admin_hash,
  (SELECT count(*)::int FROM trips WHERE corporate_account_id IS NOT NULL) AS corporate_trips,
  (SELECT count(*)::int FROM corporate_invoices) AS corporate_invoices,
  to_regprocedure('public.corporate_new_booking_guard_decision(boolean,text,text,text,text)') IS NOT NULL AS booking_guard_installed,
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109110000') AS migration_applied
FROM phase_a8a_status b
JOIN phase_a8a_status a ON a.label = 'after_probes'
WHERE b.label = 'before';

ROLLBACK;
