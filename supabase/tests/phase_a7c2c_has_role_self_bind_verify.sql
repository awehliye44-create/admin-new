-- Phase A7C2C body simulation. Applies the draft body, probes, then ROLLBACK.
-- Sentinel and temporary fixtures only. Does not print real identities.

BEGIN;
RESET ROLE;

CREATE TEMP TABLE a7c2c_before AS
SELECT
  p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  md5(p.prosrc) AS body_md5,
  p.prosrc AS body_src,
  p.proacl::text AS acl
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('has_role', 'is_super_admin');

CREATE TEMP TABLE a7c2c_policy_defs AS
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  pol.polname,
  pol.polcmd,
  coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') AS polqual,
  coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS polwithcheck
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '')
    || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')) ~* 'has_role\s*\(';

CREATE TEMP TABLE a7c2c_view_defs AS
SELECT c.relname AS view_name, pg_get_viewdef(c.oid, true) AS viewdef
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
  AND pg_get_viewdef(c.oid, true) ~* 'has_role\s*\(';

CREATE TEMP TABLE a7c2c_counts AS
SELECT
  (SELECT count(*) FROM public.staff_profiles) AS staff_profiles,
  (SELECT count(*) FROM public.user_roles) AS user_roles,
  (SELECT count(*) FROM public.corporate_user_accounts) AS corp_memberships,
  (SELECT count(*) FROM public.corporate_accounts) AS corporate_accounts,
  (SELECT count(*) FROM public.customers) AS customers,
  (SELECT count(*) FROM public.drivers) AS drivers,
  (SELECT count(*) FROM public.trips) AS trips,
  (SELECT count(*) FROM public.ride_offers) AS ride_offers,
  (SELECT count(*) FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*) FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger) AS wallet_sum,
  (SELECT count(*) FROM public.notifications) AS notifications,
  (SELECT count(*) FROM storage.objects) AS storage_objects,
  (SELECT count(*) FROM auth.users) AS auth_users,
  (SELECT count(*) FROM a7c2c_policy_defs) AS policies_with_has_role,
  (SELECT count(*) FROM a7c2c_view_defs) AS views_with_has_role;

DO $simulate$
DECLARE
  v_admin uuid;
  v_customer uuid;
  v_foreign uuid;
  v_random uuid := '00000000-0000-4000-8000-000000000099';
  v_unowned_role public.app_role;
  v_before_admin boolean;
  v_after_admin boolean;
  v_after_unowned boolean;
  v_after_foreign boolean;
  v_after_random boolean;
  v_after_null boolean;
  v_after_service boolean;
  v_super_self_before boolean;
  v_super_self_after boolean;
  v_super_foreign boolean;
  v_staff_action boolean;
  v_auth_secdef integer;
  v_policy_count integer;
  v_view_count integer;
  v_vehicle_admin_count integer;
  v_vehicle_customer_count integer;
  v_corp_admin_count integer;
  v_corp_customer_count integer;
  v_storage_admin_count integer;
  v_storage_customer_count integer;
  v_demand_admin boolean;
  v_demand_customer boolean;
  v_realtime_admin boolean;
  v_realtime_customer boolean;
  v_trigger_admin boolean;
  v_trigger_customer boolean;
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'has_role'
        AND pg_get_function_identity_arguments(p.oid) = '_user_id uuid, _role app_role') <> 1 THEN
    RAISE EXCEPTION 'expected one has_role overload';
  END IF;

  IF (SELECT body_md5 FROM a7c2c_before
      WHERE proname = 'has_role' AND args = '_user_id uuid, _role app_role')
      IS DISTINCT FROM '2ff1ba77ea1446501c56062a519ecd56' THEN
    RAISE EXCEPTION 'has_role hash drifted before draft apply';
  END IF;

  IF (SELECT body_md5 FROM a7c2c_before
      WHERE proname = 'is_super_admin' AND args = '_user_id uuid')
      IS DISTINCT FROM 'd6c5934ff9df061653c4a477cd0dec85' THEN
    RAISE EXCEPTION 'is_super_admin hash drifted before draft apply';
  END IF;

  SELECT count(*) INTO v_policy_count FROM a7c2c_policy_defs;
  IF v_policy_count <> 334 THEN
    RAISE EXCEPTION 'expected 334 has_role policies, got %', v_policy_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM a7c2c_policy_defs
    WHERE polqual !~* 'has_role\s*\(\s*auth\.uid\s*\('
      AND polwithcheck !~* 'has_role\s*\(\s*auth\.uid\s*\('
      AND (polqual || ' ' || polwithcheck) ~* 'has_role\s*\('
  ) THEN
    RAISE EXCEPTION 'policy passes a user id other than auth.uid()';
  END IF;

  SELECT count(*) INTO v_view_count FROM a7c2c_view_defs;
  IF v_view_count <> 3 THEN
    RAISE EXCEPTION 'expected 3 has_role views, got %', v_view_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM a7c2c_view_defs
    WHERE viewdef !~* 'has_role\s*\(\s*auth\.uid\s*\('
  ) THEN
    RAISE EXCEPTION 'view passes a user id other than auth.uid()';
  END IF;

  SELECT ur.user_id INTO v_admin
  FROM public.user_roles ur
  WHERE ur.role = 'admin'::public.app_role
  ORDER BY ur.created_at NULLS LAST
  LIMIT 1;

  SELECT ur.user_id INTO v_customer
  FROM public.user_roles ur
  WHERE ur.role = 'customer'::public.app_role
    AND ur.user_id IS DISTINCT FROM v_admin
  ORDER BY ur.created_at NULLS LAST
  LIMIT 1;

  SELECT u.id INTO v_foreign
  FROM auth.users u
  WHERE u.id IS DISTINCT FROM v_admin
    AND u.id IS DISTINCT FROM v_customer
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = u.id AND ur.role = 'admin'::public.app_role
    )
  ORDER BY u.created_at
  LIMIT 1;

  IF v_admin IS NULL OR v_customer IS NULL OR v_foreign IS NULL THEN
    RAISE EXCEPTION 'simulation aborted: fixture actors unavailable';
  END IF;

  SELECT e.enumlabel::public.app_role INTO v_unowned_role
  FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public'
    AND t.typname = 'app_role'
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = v_admin
        AND ur.role = e.enumlabel::public.app_role
    )
  ORDER BY e.enumsortorder
  LIMIT 1;

  IF v_unowned_role IS NULL THEN
    RAISE EXCEPTION 'simulation aborted: no unowned app_role for admin fixture';
  END IF;

  -- Capture production self oracle before body change.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_before_admin := public.has_role(v_admin, 'admin'::public.app_role);

  CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
    SELECT
      auth.uid() IS NOT NULL
      AND _user_id IS NOT DISTINCT FROM auth.uid()
      AND EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = _user_id
          AND user_roles.role = _role
      )
  $function$;

  -- Direct oracle: authenticated self owned role.
  v_after_admin := public.has_role(v_admin, 'admin'::public.app_role);
  IF v_after_admin IS DISTINCT FROM v_before_admin THEN
    RAISE EXCEPTION 'self admin role result diverged';
  END IF;
  IF v_after_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'expected self admin role true for fixture admin';
  END IF;

  -- Direct oracle: authenticated self role not held by fixture.
  v_after_unowned := public.has_role(v_admin, v_unowned_role);
  IF v_after_unowned IS NOT FALSE THEN
    RAISE EXCEPTION 'unowned role did not return false';
  END IF;

  -- Direct oracle: authenticated foreign user id.
  v_after_foreign := public.has_role(v_foreign, 'admin'::public.app_role);
  IF v_after_foreign IS NOT FALSE THEN
    RAISE EXCEPTION 'foreign _user_id did not return false';
  END IF;

  -- Direct oracle: authenticated random UUID.
  v_after_random := public.has_role(v_random, 'admin'::public.app_role);
  IF v_after_random IS NOT FALSE THEN
    RAISE EXCEPTION 'random _user_id did not return false';
  END IF;

  -- Direct oracle: no JWT.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  v_after_null := public.has_role(v_admin, 'admin'::public.app_role);
  IF v_after_null IS NOT FALSE THEN
    RAISE EXCEPTION 'null auth.uid() did not return false';
  END IF;

  -- Direct oracle: service_role JWT (auth.uid() null).
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  v_after_service := public.has_role(v_admin, 'admin'::public.app_role);
  IF v_after_service IS NOT FALSE THEN
    RAISE EXCEPTION 'service_role JWT reached arbitrary has_role lookup';
  END IF;

  -- Direct oracle: anon direct invocation denied at ACL.
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.has_role(v_admin, 'admin'::public.app_role);
    RAISE EXCEPTION 'anon has_role was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;

  -- Parent regression: is_super_admin self semantics preserved.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_super_self_before := public.is_super_admin(v_admin);
  v_super_self_after := public.is_super_admin(auth.uid());
  IF v_super_self_after IS DISTINCT FROM v_super_self_before THEN
    RAISE EXCEPTION 'is_super_admin self semantics changed';
  END IF;
  v_super_foreign := public.is_super_admin(v_foreign);
  IF v_super_foreign IS NOT FALSE THEN
    RAISE EXCEPTION 'is_super_admin foreign lookup did not fail closed';
  END IF;

  -- Parent regression: staff_has_action remains callable for self.
  v_staff_action := public.staff_has_action(auth.uid(), 'demand_zones.view');
  IF v_staff_action IS NULL THEN
    RAISE EXCEPTION 'staff_has_action returned null';
  END IF;

  -- Representative RLS / policy paths via read-only SELECT probes.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_vehicle_admin_count FROM public.vehicles;
  SELECT count(*) INTO v_corp_admin_count FROM public.corporate_accounts;
  SELECT count(*) INTO v_storage_admin_count FROM storage.objects WHERE bucket_id = 'onecab-documents';
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_vehicle_customer_count FROM public.vehicles;
  SELECT count(*) INTO v_corp_customer_count FROM public.corporate_accounts;
  SELECT count(*) INTO v_storage_customer_count FROM storage.objects WHERE bucket_id = 'onecab-documents';
  RESET ROLE;

  IF v_vehicle_admin_count < v_vehicle_customer_count THEN
    RAISE EXCEPTION 'vehicles admin read path regressed';
  END IF;
  IF v_corp_admin_count < v_corp_customer_count THEN
    RAISE EXCEPTION 'corporate_accounts admin path regressed';
  END IF;
  IF v_storage_admin_count < v_storage_customer_count THEN
    RAISE EXCEPTION 'storage admin path regressed';
  END IF;

  -- Policy-expression probes without external side effects.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_demand_admin := public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.is_super_admin(auth.uid())
    OR public.staff_has_action(auth.uid(), 'demand_zones.view');
  v_realtime_admin := public.has_role(auth.uid(), 'admin'::public.app_role);

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  v_demand_customer := public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.is_super_admin(auth.uid())
    OR public.staff_has_action(auth.uid(), 'demand_zones.view');
  v_realtime_customer := public.has_role(auth.uid(), 'admin'::public.app_role);

  IF v_demand_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'demand-zone representative admin path regressed';
  END IF;
  IF v_realtime_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'realtime representative admin path regressed';
  END IF;
  IF v_realtime_customer IS NOT FALSE THEN
    RAISE EXCEPTION 'realtime representative customer path did not deny admin role';
  END IF;

  -- Trigger-protected function paths remain auth.uid()-scoped.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_trigger_admin := public.has_role(auth.uid(), 'admin'::public.app_role);

  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  v_trigger_customer := public.has_role(auth.uid(), 'admin'::public.app_role);

  IF v_trigger_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'trigger-path admin role probe failed';
  END IF;
  IF v_trigger_customer IS NOT FALSE THEN
    RAISE EXCEPTION 'trigger-path customer admin role probe did not deny';
  END IF;

  -- Read-only parent RPC that passes auth.uid() through local actor vars.
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM public.admin_list_drivers();

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
    SELECT 1 FROM a7c2c_before b
    JOIN pg_proc p ON p.proname = b.proname
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND b.proname = 'is_super_admin'
      AND md5(p.prosrc) IS DISTINCT FROM b.body_md5
  ) THEN
    RAISE EXCEPTION 'is_super_admin body changed during simulation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM a7c2c_before b
    JOIN pg_proc p ON p.proname = b.proname
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND b.proname = 'has_role'
      AND p.proacl::text IS DISTINCT FROM b.acl
  ) THEN
    RAISE EXCEPTION 'has_role ACL changed during simulation';
  END IF;
END;
$simulate$;

DO $integrity$
BEGIN
  RESET ROLE;
  IF EXISTS (
    SELECT 1 FROM a7c2c_counts c
    WHERE c.staff_profiles IS DISTINCT FROM (SELECT count(*) FROM public.staff_profiles)
       OR c.user_roles IS DISTINCT FROM (SELECT count(*) FROM public.user_roles)
       OR c.corp_memberships IS DISTINCT FROM (SELECT count(*) FROM public.corporate_user_accounts)
       OR c.corporate_accounts IS DISTINCT FROM (SELECT count(*) FROM public.corporate_accounts)
       OR c.customers IS DISTINCT FROM (SELECT count(*) FROM public.customers)
       OR c.drivers IS DISTINCT FROM (SELECT count(*) FROM public.drivers)
       OR c.trips IS DISTINCT FROM (SELECT count(*) FROM public.trips)
       OR c.ride_offers IS DISTINCT FROM (SELECT count(*) FROM public.ride_offers)
       OR c.payment_sessions IS DISTINCT FROM (SELECT count(*) FROM public.payment_sessions)
       OR c.wallet_rows IS DISTINCT FROM (SELECT count(*) FROM public.driver_wallet_ledger)
       OR c.wallet_sum IS DISTINCT FROM (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger)
       OR c.notifications IS DISTINCT FROM (SELECT count(*) FROM public.notifications)
       OR c.storage_objects IS DISTINCT FROM (SELECT count(*) FROM storage.objects)
       OR c.auth_users IS DISTINCT FROM (SELECT count(*) FROM auth.users)
  ) THEN
    RAISE EXCEPTION 'integrity counts changed inside simulation';
  END IF;
END;
$integrity$;

DO $restore$
DECLARE
  v_body text;
  v_expected text;
BEGIN
  SELECT body_src, body_md5
  INTO v_body, v_expected
  FROM a7c2c_before
  WHERE proname = 'has_role'
    AND args = '_user_id uuid, _role app_role';

  EXECUTE format(
    $fmt$
      CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path TO 'public'
      AS $function$%s$function$
    $fmt$,
    v_body
  );

  IF (SELECT md5(p.prosrc)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'has_role'
        AND pg_get_function_identity_arguments(p.oid) = '_user_id uuid, _role app_role')
      IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'has_role hash not restored before rollback';
  END IF;
END;
$restore$;

ROLLBACK;
