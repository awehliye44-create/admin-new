-- Phase A7A ACL simulation. Applies the draft REVOKEs, probes, then ROLLBACK.
-- Does not invoke the function as postgres.
-- Authenticated and service_role probes use a random UUID and fail at privilege validation.
-- Does not return any corporate account UUID.

BEGIN;

CREATE TEMP TABLE a7a_hashes AS
SELECT md5(p.prosrc) AS body_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'get_user_corporate_accounts';

CREATE TEMP TABLE a7a_counts AS
SELECT
  (SELECT count(*) FROM public.corporate_user_accounts) AS corp_memberships,
  (SELECT count(*) FROM public.corporate_accounts) AS corporate_accounts,
  (SELECT count(*) FROM public.customers) AS customers,
  (SELECT count(*) FROM public.drivers) AS drivers,
  (SELECT count(*) FROM public.trips) AS trips,
  (SELECT count(*) FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*) FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger) AS wallet_sum,
  (SELECT count(*) FROM auth.users) AS auth_users,
  (SELECT count(*) FROM public.staff_profiles) AS staff_profiles;

REVOKE ALL ON FUNCTION public.get_user_corporate_accounts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_corporate_accounts(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_user_corporate_accounts(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_user_corporate_accounts(uuid) FROM service_role;

DO $acl$
BEGIN
  IF has_function_privilege('public', 'public.get_user_corporate_accounts(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_user_corporate_accounts(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_user_corporate_accounts(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.get_user_corporate_accounts(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.get_user_corporate_accounts(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'phase a7a ACL assertion failed';
  END IF;
END;
$acl$;

DO $auth_secdef$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF n <> 203 THEN
    RAISE EXCEPTION 'expected authenticated SECURITY DEFINER 203, got %', n;
  END IF;
END;
$auth_secdef$;

DO $auth_probe$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.get_user_corporate_accounts('00000000-0000-0000-0000-000000000001'::uuid);
  RAISE EXCEPTION 'authenticated get_user_corporate_accounts was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_probe$;
RESET ROLE;

DO $svc_probe$
BEGIN
  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.get_user_corporate_accounts('00000000-0000-0000-0000-000000000001'::uuid);
  RAISE EXCEPTION 'service_role get_user_corporate_accounts was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$svc_probe$;
RESET ROLE;

DO $hashes$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM a7a_hashes h
    JOIN pg_proc p ON true
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'get_user_corporate_accounts'
      AND md5(p.prosrc) IS DISTINCT FROM h.body_md5
  ) THEN
    RAISE EXCEPTION 'body hash changed';
  END IF;
END;
$hashes$;

DO $counts$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM a7a_counts c
    WHERE c.corp_memberships IS DISTINCT FROM (SELECT count(*) FROM public.corporate_user_accounts)
       OR c.corporate_accounts IS DISTINCT FROM (SELECT count(*) FROM public.corporate_accounts)
       OR c.customers IS DISTINCT FROM (SELECT count(*) FROM public.customers)
       OR c.drivers IS DISTINCT FROM (SELECT count(*) FROM public.drivers)
       OR c.trips IS DISTINCT FROM (SELECT count(*) FROM public.trips)
       OR c.payment_sessions IS DISTINCT FROM (SELECT count(*) FROM public.payment_sessions)
       OR c.wallet_rows IS DISTINCT FROM (SELECT count(*) FROM public.driver_wallet_ledger)
       OR c.wallet_sum IS DISTINCT FROM (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger)
       OR c.auth_users IS DISTINCT FROM (SELECT count(*) FROM auth.users)
       OR c.staff_profiles IS DISTINCT FROM (SELECT count(*) FROM public.staff_profiles)
  ) THEN
    RAISE EXCEPTION 'integrity counts changed inside simulation';
  END IF;
END;
$counts$;

ROLLBACK;
