-- Step 8.2B1 — POST-APPLY RPC verification (read-only catalog; no invocation)

SELECT
  p.proname,
  pg_get_userbyid(p.proowner) AS owner,
  p.prosecdef AS security_definer,
  p.provolatile AS volatility,
  pg_get_function_identity_arguments(p.oid) AS identity_args,
  md5(pg_get_functiondef(p.oid)) AS function_def_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'apply_confirmed_provider_refund_atomic';

SELECT
  unnest(p.proconfig) AS proconfig_entry
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'apply_confirmed_provider_refund_atomic';

SELECT grantee, privilege_type
FROM information_schema.routine_privileges
WHERE specific_schema = 'public'
  AND routine_name = 'apply_confirmed_provider_refund_atomic'
ORDER BY grantee, privilege_type;
