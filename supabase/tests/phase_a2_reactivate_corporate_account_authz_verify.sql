-- Phase A2 body-gate simulation. Applies the draft function, probes, then ROLLBACK.
-- Does not call service_role or postgres. Authorized probe uses a missing UUID
-- and must fail with Account not found after the gate, before any status change.

BEGIN;

CREATE OR REPLACE FUNCTION public.reactivate_corporate_account(p_account_id uuid)
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
  SET status = 'active', updated_at = now()
  WHERE id = p_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found';
  END IF;
END;
$fn$;

CREATE TEMP TABLE phase_a2_status (
  label text PRIMARY KEY,
  total int,
  active int,
  suspended int,
  other int
) ON COMMIT DROP;

INSERT INTO phase_a2_status
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
  v_staff uuid;
  v_before int;
  v_after int;
BEGIN
  IF has_function_privilege('public', 'public.reactivate_corporate_account(uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.reactivate_corporate_account(uuid)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reactivate_corporate_account(uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', 'public.reactivate_corporate_account(uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('postgres', 'public.reactivate_corporate_account(uuid)'::regprocedure, 'EXECUTE') IS NOT TRUE
  THEN
    RAISE EXCEPTION 'a2 acl drift';
  END IF;

  IF has_function_privilege('authenticated', 'public.staff_has_page_access(text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'staff_has_page_access must stay non-executable by authenticated';
  END IF;

  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.reactivate_corporate_account('00000000-0000-0000-0000-000000000000'::uuid);
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
    PERFORM public.reactivate_corporate_account('00000000-0000-0000-0000-000000000000'::uuid);
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
    PERFORM public.reactivate_corporate_account('00000000-0000-0000-0000-000000000000'::uuid);
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
  VALUES (v_customer, 'phase-a2-probe', 'phase a2 probe', 'operator', false, false);

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.reactivate_corporate_account('00000000-0000-0000-0000-000000000000'::uuid);
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
    AND staff_role_id = 'phase-a2-probe'
    AND is_owner = false;

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.reactivate_corporate_account('00000000-0000-0000-0000-000000000000'::uuid);
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

  SELECT count(*)::int INTO v_before FROM public.corporate_accounts WHERE status = 'active';

  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.reactivate_corporate_account('00000000-0000-0000-0000-000000000000'::uuid);
    RESET ROLE;
    RAISE EXCEPTION 'authorized probe updated a row';
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      RESET ROLE;
      IF v_state = '42501' OR v_err IS DISTINCT FROM 'Account not found' THEN
        RAISE EXCEPTION 'authorized probe failed closed wrong: % %', v_state, v_err;
      END IF;
  END;

  SELECT count(*)::int INTO v_after FROM public.corporate_accounts WHERE status = 'active';
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'authorized probe changed active count % -> %', v_before, v_after;
  END IF;
END $$;

INSERT INTO phase_a2_status
SELECT
  'after_probes',
  count(*)::int,
  count(*) FILTER (WHERE status = 'active')::int,
  count(*) FILTER (WHERE status = 'suspended')::int,
  count(*) FILTER (WHERE status IS DISTINCT FROM 'active' AND status IS DISTINCT FROM 'suspended')::int
FROM public.corporate_accounts;

DO $$
DECLARE
  b phase_a2_status%ROWTYPE;
  a phase_a2_status%ROWTYPE;
BEGIN
  SELECT * INTO b FROM phase_a2_status WHERE label = 'before';
  SELECT * INTO a FROM phase_a2_status WHERE label = 'after_probes';
  IF a.total <> b.total OR a.active <> b.active OR a.suspended <> b.suspended OR a.other <> b.other THEN
    RAISE EXCEPTION 'corporate status drift % / %', row_to_json(b), row_to_json(a);
  END IF;
END $$;

SELECT
  b.total,
  b.active,
  b.suspended,
  a.total AS total_after,
  a.active AS active_after,
  a.suspended AS suspended_after,
  has_function_privilege('authenticated', 'public.reactivate_corporate_account(uuid)'::regprocedure, 'EXECUTE') AS auth_exec,
  has_function_privilege('service_role', 'public.reactivate_corporate_account(uuid)'::regprocedure, 'EXECUTE') AS svc_exec,
  has_function_privilege('postgres', 'public.reactivate_corporate_account(uuid)'::regprocedure, 'EXECUTE') AS pg_exec,
  (SELECT count(*)::int
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef
FROM phase_a2_status b
JOIN phase_a2_status a ON a.label = 'after_probes'
WHERE b.label = 'before';

ROLLBACK;
