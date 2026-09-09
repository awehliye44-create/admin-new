-- Phase A7B ACL simulation. Applies the draft REVOKEs, probes, then ROLLBACK.
-- Does not invoke is_owner as service_role or postgres.
-- Authenticated probes use a sentinel UUID and fail at privilege validation.
-- Parent probes use a sentinel UUID only and do not disclose a real owner.

BEGIN;

CREATE TEMP TABLE a7b_hashes AS
SELECT md5(p.prosrc) AS body_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'is_owner';

CREATE TEMP TABLE a7b_counts AS
SELECT
  (SELECT count(*) FROM public.staff_profiles) AS staff_profiles,
  (SELECT count(*) FROM public.staff_profiles WHERE is_owner IS TRUE) AS staff_owners,
  (SELECT count(*) FROM public.user_roles) AS user_roles,
  (SELECT count(*) FROM public.corporate_user_accounts) AS corp_memberships,
  (SELECT count(*) FROM public.corporate_accounts) AS corporate_accounts,
  (SELECT count(*) FROM public.trips) AS trips,
  (SELECT count(*) FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*) FROM public.payout_items) AS payout_items,
  (SELECT count(*) FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger) AS wallet_sum,
  (SELECT count(*) FROM auth.users) AS auth_users;

REVOKE ALL ON FUNCTION public.is_owner(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_owner(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.is_owner(uuid) FROM authenticated;

DO $acl$
BEGIN
  IF has_function_privilege('public', 'public.is_owner(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.is_owner(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.is_owner(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.is_owner(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('postgres', 'public.is_owner(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'phase a7b ACL assertion failed';
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
  IF n <> 202 THEN
    RAISE EXCEPTION 'expected authenticated SECURITY DEFINER 202, got %', n;
  END IF;
END;
$auth_secdef$;

DO $parents$
BEGIN
  IF NOT (
    EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'is_super_admin'
        AND p.prosecdef
        AND pg_get_userbyid(p.proowner) = 'postgres'
        AND p.prosrc ~* 'is_owner\s*\('
    )
    AND EXISTS (
      SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = 'staff_has_action'
        AND p.prosecdef
        AND pg_get_userbyid(p.proowner) = 'postgres'
        AND p.prosrc ~* 'is_owner\s*\('
    )
  ) THEN
    RAISE EXCEPTION 'expected postgres-owned definer parents missing';
  END IF;
END;
$parents$;

DO $auth_probe$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.is_owner('00000000-0000-0000-0000-000000000001'::uuid);
  RAISE EXCEPTION 'authenticated is_owner was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_probe$;
RESET ROLE;

DO $parent_probe$
DECLARE
  v_super boolean;
  v_action boolean;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_super := public.is_super_admin('00000000-0000-0000-0000-000000000001'::uuid);
  v_action := public.staff_has_action('00000000-0000-0000-0000-000000000001'::uuid, 'phase_a7b_sentinel');
  IF v_super IS NOT FALSE OR v_action IS NOT FALSE THEN
    RAISE EXCEPTION 'sentinel parent probe returned unexpected true';
  END IF;
END;
$parent_probe$;
RESET ROLE;

DO $hashes$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM a7b_hashes h
    JOIN pg_proc p ON true
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'is_owner'
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
    FROM a7b_counts c
    WHERE c.staff_profiles IS DISTINCT FROM (SELECT count(*) FROM public.staff_profiles)
       OR c.staff_owners IS DISTINCT FROM (SELECT count(*) FROM public.staff_profiles WHERE is_owner IS TRUE)
       OR c.user_roles IS DISTINCT FROM (SELECT count(*) FROM public.user_roles)
       OR c.corp_memberships IS DISTINCT FROM (SELECT count(*) FROM public.corporate_user_accounts)
       OR c.corporate_accounts IS DISTINCT FROM (SELECT count(*) FROM public.corporate_accounts)
       OR c.trips IS DISTINCT FROM (SELECT count(*) FROM public.trips)
       OR c.payment_sessions IS DISTINCT FROM (SELECT count(*) FROM public.payment_sessions)
       OR c.payout_items IS DISTINCT FROM (SELECT count(*) FROM public.payout_items)
       OR c.wallet_rows IS DISTINCT FROM (SELECT count(*) FROM public.driver_wallet_ledger)
       OR c.wallet_sum IS DISTINCT FROM (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger)
       OR c.auth_users IS DISTINCT FROM (SELECT count(*) FROM auth.users)
  ) THEN
    RAISE EXCEPTION 'integrity counts changed inside simulation';
  END IF;
END;
$counts$;

ROLLBACK;
