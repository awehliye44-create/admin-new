-- Phase 3 Batch 3D4 invoice number authorization verify
-- Applies the body gate inside this transaction, probes, then ROLLBACK.
-- Sequence UPDATEs roll back with the transaction. No permanent invoice number.

BEGIN;

CREATE OR REPLACE FUNCTION public.generate_invoice_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  ym text := to_char(timezone('UTC', now()), 'YYMM');
  seq int;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.staff_has_page_access('statement-runs') THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  LOOP
    UPDATE public.driver_invoice_monthly_sequences
    SET last_seq = last_seq + 1
    WHERE invoice_month = ym
    RETURNING last_seq INTO seq;

    IF FOUND THEN
      RETURN 'INV-' || ym || '-' || lpad(seq::text, 3, '0');
    END IF;

    BEGIN
      INSERT INTO public.driver_invoice_monthly_sequences (invoice_month, last_seq)
      VALUES (ym, 1)
      RETURNING last_seq INTO seq;
      RETURN 'INV-' || ym || '-' || lpad(seq::text, 3, '0');
    EXCEPTION
      WHEN unique_violation THEN
        NULL;
    END;
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.generate_invoice_number() IS
  'Batch3D4: service_role OR staff_has_page_access(statement-runs). Fail closed. Sequence logic unchanged.';


DO $$
DECLARE
  v_num text;
  v_auth int;
  v_staff uuid;
  v_customer uuid;
  v_driver uuid;
  v_nargs int;
BEGIN
  IF has_function_privilege('public', 'public.generate_invoice_number()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.generate_invoice_number()'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.generate_invoice_number()'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR NOT has_function_privilege('service_role', 'public.generate_invoice_number()'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.generate_invoice_number()'::regprocedure, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'invoice execute acl changed';
  END IF;

  SELECT p.pronargs INTO v_nargs
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'generate_invoice_number';
  IF v_nargs <> 0 THEN
    RAISE EXCEPTION 'caller-supplied arguments would bypass the gate';
  END IF;

  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.generate_invoice_number();
    RAISE EXCEPTION 'anon-like authenticated succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  SELECT c.user_id INTO v_customer
  FROM public.customers c
  WHERE c.user_id IS NOT NULL
  LIMIT 1;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'no customer to prove deny path';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.generate_invoice_number();
    RAISE EXCEPTION 'customer succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  SELECT d.user_id INTO v_driver
  FROM public.drivers d
  WHERE d.user_id IS NOT NULL
  LIMIT 1;
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'no driver to prove deny path';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.generate_invoice_number();
    RAISE EXCEPTION 'driver succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  SELECT sp.user_id INTO v_staff
  FROM public.staff_profiles sp
  JOIN public.role_page_permissions rpp
    ON rpp.role = sp.role
   AND rpp.page_slug = 'statement-runs'
   AND rpp.can_access = true
  WHERE sp.is_active = true
  LIMIT 1;

  IF v_staff IS NULL THEN
    RAISE EXCEPTION 'no statement-runs staff to prove allow path';
  END IF;

  -- Owner cannot be deactivated. Prove inactive / missing-page on a
  -- transaction-local non-owner profile. The outer ROLLBACK removes it.
  INSERT INTO public.staff_profiles (user_id, staff_role_id, full_name, role, is_active, is_owner)
  VALUES (v_customer, 'phase3d4-probe', 'phase3d4 probe', 'operator', false, false);

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.generate_invoice_number();
    RAISE EXCEPTION 'inactive staff succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  UPDATE public.staff_profiles
  SET is_active = true
  WHERE user_id = v_customer
    AND staff_role_id = 'phase3d4-probe'
    AND is_owner = false;
  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.generate_invoice_number();
    RAISE EXCEPTION 'staff without statement-runs succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_num := public.generate_invoice_number();
  RESET ROLE;

  IF v_num IS NULL OR v_num NOT LIKE 'INV-%' THEN
    RAISE EXCEPTION 'authorized statement-runs call failed';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'service_role')::text, true);
  v_num := public.generate_invoice_number();
  IF v_num IS NULL OR v_num NOT LIKE 'INV-%' THEN
    RAISE EXCEPTION 'service_role call failed';
  END IF;

  SELECT count(*) INTO v_auth
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_auth <> 243 THEN
    RAISE EXCEPTION 'auth secdef % expected 243', v_auth;
  END IF;
END $$;

SELECT 'pass' AS status, 0 AS warning_reduction, 243 AS expected_auth_secdef;
ROLLBACK;
