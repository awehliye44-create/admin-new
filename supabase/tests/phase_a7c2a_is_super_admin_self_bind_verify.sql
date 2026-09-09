-- Phase A7C2A body simulation. Applies the draft body, probes, then ROLLBACK.
-- Sentinel and temporary fixtures only. Does not print real identities.

BEGIN;
RESET ROLE;

CREATE TEMP TABLE a7c2a_before AS
SELECT
  p.proname,
  md5(p.prosrc) AS body_md5,
  p.proacl::text AS acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'is_super_admin',
    'has_role',
    'is_owner',
    'staff_has_action',
    'admin_assign_staff_role',
    'admin_save_demand_zone_settings'
  );

CREATE TEMP TABLE a7c2a_counts AS
SELECT
  (SELECT count(*) FROM public.staff_profiles) AS staff_profiles,
  (SELECT count(*) FROM public.user_roles) AS user_roles,
  (SELECT count(*) FROM public.corporate_user_accounts) AS corp_memberships,
  (SELECT count(*) FROM public.corporate_accounts) AS corporate_accounts,
  (SELECT count(*) FROM public.trips) AS trips,
  (SELECT count(*) FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*) FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger) AS wallet_sum,
  (SELECT count(*) FROM auth.users) AS auth_users;

DO $simulate$
DECLARE
  v_self uuid;
  v_foreign uuid;
  v_before_self boolean;
  v_after_self boolean;
  v_after_foreign boolean;
  v_after_null_ctx boolean;
  v_nested boolean;
  v_edge_compat boolean;
  v_auth_secdef integer;
  v_has_role_hash text;
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'is_super_admin') <> 1 THEN
    RAISE EXCEPTION 'expected one is_super_admin overload';
  END IF;

  SELECT md5(p.prosrc) INTO v_has_role_hash
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'has_role'
    AND pg_get_function_identity_arguments(p.oid) = '_user_id uuid, _role app_role';
  IF v_has_role_hash IS DISTINCT FROM '2ff1ba77ea1446501c56062a519ecd56' THEN
    RAISE EXCEPTION 'has_role hash drifted before draft apply';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policy pol
    WHERE (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
        || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')) ~* 'is_super_admin\s*\('
      AND (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
        || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')) !~* 'is_super_admin\s*\(\s*auth\.uid\s*\('
  ) THEN
    RAISE EXCEPTION 'policy passes a user id other than auth.uid()';
  END IF;

  SELECT user_id INTO v_self
  FROM public.staff_profiles
  WHERE is_active = true
  ORDER BY created_at
  LIMIT 1;
  SELECT u.id INTO v_foreign
  FROM auth.users u
  WHERE u.id IS DISTINCT FROM v_self
  ORDER BY u.created_at
  LIMIT 1;
  IF v_self IS NULL OR v_foreign IS NULL THEN
    RAISE EXCEPTION 'simulation aborted: fixture actors unavailable';
  END IF;

  -- No JWT: current production evaluates arbitrary ids; capture self only for compare.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  v_after_null_ctx := public.is_super_admin(v_self);

  PERFORM set_config('request.jwt.claim.sub', v_self::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_self, 'role', 'authenticated')::text, true);
  v_before_self := public.is_super_admin(v_self);

  CREATE OR REPLACE FUNCTION public.is_super_admin(_user_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
    SELECT
      auth.uid() IS NOT NULL
      AND _user_id IS NOT DISTINCT FROM auth.uid()
      AND CASE
        WHEN public.is_owner(_user_id) THEN true
        WHEN EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = _user_id)
          THEN EXISTS (
            SELECT 1 FROM public.staff_profiles sp
            WHERE sp.user_id = _user_id AND sp.is_active = true AND sp.role = 'super_admin'
          )
        ELSE public.has_role(_user_id, 'admin'::public.app_role)
      END;
  $function$;

  -- Authenticated self keeps the original membership result.
  v_after_self := public.is_super_admin(v_self);
  IF v_after_self IS DISTINCT FROM v_before_self THEN
    RAISE EXCEPTION 'self-bound result diverged from production self result';
  END IF;

  -- Foreign id under authenticated JWT fails closed.
  v_after_foreign := public.is_super_admin(v_foreign);
  IF v_after_foreign IS NOT FALSE THEN
    RAISE EXCEPTION 'foreign _user_id did not return false';
  END IF;

  -- useRoleCapabilities semantics: signed-in id only.
  IF public.is_super_admin(auth.uid()) IS DISTINCT FROM v_before_self THEN
    RAISE EXCEPTION 'mounted self-query semantics changed';
  END IF;

  -- Nested parent with auth.uid() remains compatible.
  v_nested := public.staff_has_action(auth.uid(), 'phase_a7c2a_sentinel');
  IF v_nested IS NULL THEN
    RAISE EXCEPTION 'nested staff_has_action returned null';
  END IF;

  -- Null JWT fails closed.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  IF public.is_super_admin(v_self) IS NOT FALSE THEN
    RAISE EXCEPTION 'null auth.uid() did not return false';
  END IF;

  -- service_role JWT: is_super_admin fails closed; staff_has_action still uses EXISTS/is_owner.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  IF public.is_super_admin(v_self) IS NOT FALSE THEN
    RAISE EXCEPTION 'service_role JWT reached arbitrary is_super_admin lookup';
  END IF;
  v_edge_compat := public.staff_has_action(v_self, 'demand_zones.recompute');
  IF v_edge_compat IS NOT TRUE THEN
    RAISE EXCEPTION 'service_role staff_has_action compatibility for demand_zones.recompute failed';
  END IF;

  -- Anon cannot execute.
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.is_super_admin(v_self);
    RAISE EXCEPTION 'anon is_super_admin was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  SELECT count(*) INTO v_auth_secdef
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth_secdef <> 202 THEN
    RAISE EXCEPTION 'expected authenticated SECURITY DEFINER 202, got %', v_auth_secdef;
  END IF;

  IF EXISTS (
    SELECT 1 FROM a7c2a_before b
    JOIN pg_proc p ON p.proname = b.proname
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'has_role'
      AND md5(p.prosrc) IS DISTINCT FROM b.body_md5
  ) THEN
    RAISE EXCEPTION 'has_role body changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM a7c2a_before b
    JOIN pg_proc p ON p.proname = b.proname
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'is_super_admin'
      AND p.proacl::text IS DISTINCT FROM b.acl
  ) THEN
    RAISE EXCEPTION 'is_super_admin ACL changed';
  END IF;

  -- silence unused pre-draft null-context capture
  IF v_after_null_ctx IS NULL THEN
    RAISE EXCEPTION 'unexpected null preimage';
  END IF;
END;
$simulate$;

DO $integrity$
BEGIN
  RESET ROLE;
  IF EXISTS (
    SELECT 1 FROM a7c2a_counts c
    WHERE c.staff_profiles IS DISTINCT FROM (SELECT count(*) FROM public.staff_profiles)
       OR c.user_roles IS DISTINCT FROM (SELECT count(*) FROM public.user_roles)
       OR c.corp_memberships IS DISTINCT FROM (SELECT count(*) FROM public.corporate_user_accounts)
       OR c.corporate_accounts IS DISTINCT FROM (SELECT count(*) FROM public.corporate_accounts)
       OR c.trips IS DISTINCT FROM (SELECT count(*) FROM public.trips)
       OR c.payment_sessions IS DISTINCT FROM (SELECT count(*) FROM public.payment_sessions)
       OR c.wallet_rows IS DISTINCT FROM (SELECT count(*) FROM public.driver_wallet_ledger)
       OR c.wallet_sum IS DISTINCT FROM (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger)
       OR c.auth_users IS DISTINCT FROM (SELECT count(*) FROM auth.users)
  ) THEN
    RAISE EXCEPTION 'integrity counts changed inside simulation';
  END IF;
END;
$integrity$;

ROLLBACK;
