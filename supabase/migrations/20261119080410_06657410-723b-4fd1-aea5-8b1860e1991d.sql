-- New database steps start closed to visitors (anon); open one on purpose with an explicit GRANT.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;

-- Self-check: a freshly created function must not be runnable by visitors.
CREATE FUNCTION public._default_acl_probe() RETURNS int LANGUAGE sql AS 'SELECT 1';
DO $chk$
BEGIN
  IF has_function_privilege('anon', 'public._default_acl_probe()', 'EXECUTE') THEN
    RAISE EXCEPTION 'default privileges still open new functions to anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public._default_acl_probe()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public._default_acl_probe()', 'EXECUTE') THEN
    RAISE EXCEPTION 'default privileges dropped signed-in/backend access';
  END IF;
END
$chk$;
DROP FUNCTION public._default_acl_probe();