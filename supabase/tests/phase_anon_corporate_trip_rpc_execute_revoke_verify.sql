-- Post-apply privilege checks for
-- 20261112130000_phase_anon_corporate_trip_rpc_execute_revoke.sql
--
-- Read-only. Does not call either RPC. Does not mutate trips.

\set ON_ERROR_STOP on
\pset pager off

SELECT p.proname,
       pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef,
       p.provolatile,
       p.proconfig,
       md5(p.prosrc) AS body_md5,
       has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('activate_paid_corporate_trip', 'discard_unpaid_corporate_trip')
ORDER BY 1;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname,
           md5(p.prosrc) AS body_md5,
           has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('activate_paid_corporate_trip', 'discard_unpaid_corporate_trip')
  LOOP
    IF r.public_exec OR r.anon_exec THEN
      RAISE EXCEPTION '% still executable by PUBLIC or anon', r.proname;
    END IF;
    IF NOT r.auth_exec THEN
      RAISE EXCEPTION '% lost authenticated EXECUTE', r.proname;
    END IF;
    IF NOT r.service_exec THEN
      RAISE EXCEPTION '% lost service_role EXECUTE', r.proname;
    END IF;
    IF r.proname = 'activate_paid_corporate_trip'
       AND r.body_md5 <> '79b1898de50029d37e32229816f77772' THEN
      RAISE EXCEPTION 'activate_paid_corporate_trip body md5 changed: %', r.body_md5;
    END IF;
    IF r.proname = 'discard_unpaid_corporate_trip'
       AND r.body_md5 <> 'af569ff4389a1baf45a91ba462050407' THEN
      RAISE EXCEPTION 'discard_unpaid_corporate_trip body md5 changed: %', r.body_md5;
    END IF;
  END LOOP;
END
$$;
