-- Post-apply privilege checks for
-- 20261112150000_phase_location_search_rpc_execute_revoke.sql
--
-- Read-only. Does not call any target function.

\set ON_ERROR_STOP on
\pset pager off

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('search_places(text, uuid, integer)', '61b8c51a24efd25a93013ec8b063cefb'),
      ('search_onecab_location_landmarks(text, uuid, text, uuid, integer)', '48f9f4a4c403fe76ee2962ee87ed5c56')
    ) AS expected(sig, body_md5)
  LOOP
    IF has_function_privilege('public', ('public.' || r.sig)::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', ('public.' || r.sig)::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', ('public.' || r.sig)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% still executable by PUBLIC, anon, or authenticated', r.sig;
    END IF;
    IF NOT has_function_privilege('postgres', ('public.' || r.sig)::regprocedure, 'EXECUTE')
       OR NOT has_function_privilege('service_role', ('public.' || r.sig)::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION '% lost postgres or service_role EXECUTE', r.sig;
    END IF;
    IF md5((SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.oid = ('public.' || r.sig)::regprocedure)) <> r.body_md5 THEN
      RAISE EXCEPTION '% body md5 changed', r.sig;
    END IF;
    IF NOT (
      SELECT p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.oid = ('public.' || r.sig)::regprocedure
    ) THEN
      RAISE EXCEPTION '% owner or SECURITY DEFINER changed', r.sig;
    END IF;
    IF (
      SELECT p.proconfig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.oid = ('public.' || r.sig)::regprocedure
    ) IS DISTINCT FROM (
      CASE r.sig
        WHEN 'search_places(text, uuid, integer)' THEN ARRAY['search_path=public, extensions']
        ELSE ARRAY['search_path=public']
      END
    ) THEN
      RAISE EXCEPTION '% search_path changed', r.sig;
    END IF;
  END LOOP;
END
$$;
