-- Later cash retirement verify. Applies the stub inside this transaction,
-- probes, then ROLLBACK. Does not permanently change trips or ledgers.

BEGIN;

CREATE OR REPLACE FUNCTION public.record_cash_trip_completion(
  p_trip_id uuid,
  p_driver_id uuid,
  p_gross_fare_pence integer,
  p_commission_pence integer,
  p_currency_code text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: Cash trip completion is no longer supported. ONECAB is digital-only.'
    USING ERRCODE = 'check_violation';
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) FROM anon;
REVOKE ALL ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.record_cash_trip_completion(uuid, uuid, integer, integer, text) FROM service_role;

DO $$
DECLARE
  v_trips int;
  v_ledger int;
  v_sig text;
BEGIN
  IF has_function_privilege('public', 'public.record_cash_trip_completion(uuid,uuid,integer,integer,text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.record_cash_trip_completion(uuid,uuid,integer,integer,text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_cash_trip_completion(uuid,uuid,integer,integer,text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', 'public.record_cash_trip_completion(uuid,uuid,integer,integer,text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('postgres', 'public.record_cash_trip_completion(uuid,uuid,integer,integer,text)'::regprocedure, 'EXECUTE') IS NOT TRUE
  THEN
    RAISE EXCEPTION 'cash acl matrix failed';
  END IF;

  SELECT pg_get_function_identity_arguments(p.oid) INTO v_sig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'record_cash_trip_completion';
  IF v_sig IS DISTINCT FROM 'p_trip_id uuid, p_driver_id uuid, p_gross_fare_pence integer, p_commission_pence integer, p_currency_code text' THEN
    RAISE EXCEPTION 'signature changed: %', v_sig;
  END IF;

  IF position('UPDATE trips' in (
    SELECT p.prosrc FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'record_cash_trip_completion'
  )) > 0 THEN
    RAISE EXCEPTION 'stub can still write trips';
  END IF;

  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.record_cash_trip_completion(
      '00000000-0000-0000-0000-000000000001'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      0, 0, 'GBP'
    );
    RAISE EXCEPTION 'authenticated succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
    PERFORM public.record_cash_trip_completion(
      '00000000-0000-0000-0000-000000000001'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      0, 0, 'GBP'
    );
    RAISE EXCEPTION 'service_role succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  BEGIN
    PERFORM public.record_cash_trip_completion(
      '00000000-0000-0000-0000-000000000001'::uuid,
      '00000000-0000-0000-0000-000000000002'::uuid,
      0, 0, 'GBP'
    );
    RAISE EXCEPTION 'postgres call did not raise';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM NOT LIKE 'FINANCIAL_MODEL_VIOLATION:%' THEN
        RAISE EXCEPTION 'unexpected exception: %', SQLERRM;
      END IF;
  END;

  SELECT count(*) INTO v_trips FROM public.trips;
  SELECT count(*) INTO v_ledger FROM public.driver_ledger;
  IF v_trips IS NULL OR v_ledger IS NULL THEN
    RAISE EXCEPTION 'integrity probes failed';
  END IF;
END $$;

SELECT 'pass' AS status, 0 AS warning_reduction;
ROLLBACK;
