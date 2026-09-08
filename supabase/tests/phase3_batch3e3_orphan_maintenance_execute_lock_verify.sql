-- 3E3 ACL simulation only. Applies the draft matrix, probes, then ROLLBACK.
-- Does not execute the five functions.

BEGIN;

REVOKE ALL ON FUNCTION public.expire_stale_negotiations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_negotiations() FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_negotiations() FROM authenticated;
REVOKE ALL ON FUNCTION public.expire_stale_negotiations() FROM service_role;

REVOKE ALL ON FUNCTION public.expire_stale_negotiations_guarded() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_negotiations_guarded() FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_negotiations_guarded() FROM authenticated;
REVOKE ALL ON FUNCTION public.expire_stale_negotiations_guarded() FROM service_role;

REVOKE ALL ON FUNCTION public.expire_stale_modification_requests() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_stale_modification_requests() FROM anon;
REVOKE ALL ON FUNCTION public.expire_stale_modification_requests() FROM authenticated;
REVOKE ALL ON FUNCTION public.expire_stale_modification_requests() FROM service_role;

REVOKE ALL ON FUNCTION public.sweep_stale_searching_trips() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sweep_stale_searching_trips() FROM anon;
REVOKE ALL ON FUNCTION public.sweep_stale_searching_trips() FROM authenticated;
REVOKE ALL ON FUNCTION public.sweep_stale_searching_trips() FROM service_role;

REVOKE ALL ON FUNCTION public.expire_negotiation_offer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_negotiation_offer(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.expire_negotiation_offer(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.expire_negotiation_offer(uuid) FROM service_role;

DO $$
DECLARE
  v_name text;
  v_auth int := 0;
  v_anon int := 0;
  v_public int := 0;
  v_pg_missing int := 0;
  v_svc int := 0;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'public.expire_stale_negotiations()',
    'public.expire_stale_negotiations_guarded()',
    'public.expire_stale_modification_requests()',
    'public.sweep_stale_searching_trips()',
    'public.expire_negotiation_offer(uuid)'
  ]
  LOOP
    IF has_function_privilege('authenticated', v_name::regprocedure, 'EXECUTE') THEN
      v_auth := v_auth + 1;
    END IF;
    IF has_function_privilege('anon', v_name::regprocedure, 'EXECUTE') THEN
      v_anon := v_anon + 1;
    END IF;
    IF has_function_privilege('public', v_name::regprocedure, 'EXECUTE') THEN
      v_public := v_public + 1;
    END IF;
    IF has_function_privilege('postgres', v_name::regprocedure, 'EXECUTE') IS NOT TRUE THEN
      v_pg_missing := v_pg_missing + 1;
    END IF;
    IF has_function_privilege('service_role', v_name::regprocedure, 'EXECUTE') THEN
      v_svc := v_svc + 1;
    END IF;
  END LOOP;

  IF v_auth <> 0 OR v_anon <> 0 OR v_public <> 0 OR v_pg_missing <> 0 OR v_svc <> 0 THEN
    RAISE EXCEPTION '3e3 acl failed auth=% anon=% public=% pg_missing=% svc=%',
      v_auth, v_anon, v_public, v_pg_missing, v_svc;
  END IF;
END $$;

SELECT
  (SELECT count(*)
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef_inside_txn,
  has_function_privilege('authenticated', 'public.sweep_stale_searching_trips()'::regprocedure, 'EXECUTE') AS auth_sweep,
  has_function_privilege('service_role', 'public.sweep_stale_searching_trips()'::regprocedure, 'EXECUTE') AS svc_sweep,
  has_function_privilege('postgres', 'public.sweep_stale_searching_trips()'::regprocedure, 'EXECUTE') AS pg_sweep;

ROLLBACK;
