-- Phase A8B2 ACL simulation. Applies the draft REVOKEs, probes privilege only,
-- then ROLLBACK. Does not invoke the function body as any role.
-- Does not pass real user UUIDs or PII into a successful call.

BEGIN;

CREATE TEMP TABLE a8b2_hash AS
SELECT md5(p.prosrc) AS body_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'upsert_pending_customer_signup'
  AND pg_get_function_identity_arguments(p.oid) =
    'p_user_id uuid, p_first_name text, p_last_name text, p_email text, p_phone text, p_signup_source text';

CREATE TEMP TABLE a8b2_counts AS
SELECT
  (SELECT count(*) FROM public.pending_customer_signups) AS pending_total,
  (SELECT count(*) FILTER (WHERE status = 'pending') FROM public.pending_customer_signups) AS pending_status,
  (SELECT count(*) FILTER (WHERE status = 'completed') FROM public.pending_customer_signups) AS completed_status,
  (SELECT count(*) FILTER (WHERE status = 'expired') FROM public.pending_customer_signups) AS expired_status,
  (SELECT count(*) FILTER (WHERE status = 'abandoned') FROM public.pending_customer_signups) AS abandoned_status,
  (SELECT count(*) FROM public.customers) AS customers,
  (SELECT count(*) FROM public.drivers) AS drivers,
  (SELECT count(*) FROM auth.users) AS auth_users,
  (SELECT count(*) FROM auth.identities) AS auth_identities,
  (SELECT count(*) FROM auth.users WHERE email_confirmed_at IS NULL) AS unverified_email_users,
  (SELECT count(*) FROM public.account_email_change_requests) AS email_change_requests,
  (SELECT count(*) FROM public.corporate_accounts) AS corporate_accounts,
  (SELECT count(*) FROM public.corporate_user_accounts) AS corporate_memberships,
  (SELECT count(*) FROM public.trips) AS trips,
  (SELECT count(*) FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*) FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger) AS wallet_signed_sum;

DO $pre$
BEGIN
  IF (SELECT body_md5 FROM a8b2_hash) IS DISTINCT FROM '9aab50bd458737ac94799041f1009106' THEN
    RAISE EXCEPTION 'unexpected production body hash before simulation';
  END IF;
  IF has_function_privilege(
       'authenticated',
       'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
       'EXECUTE'
     ) IS NOT TRUE
     OR has_function_privilege(
       'service_role',
       'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
       'EXECUTE'
     ) IS NOT TRUE
     OR has_function_privilege(
       'postgres',
       'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
       'EXECUTE'
     ) IS NOT TRUE
     OR has_function_privilege(
       'public',
       'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'unexpected baseline ACL before simulation';
  END IF;
END;
$pre$;

REVOKE ALL ON FUNCTION public.upsert_pending_customer_signup(uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_pending_customer_signup(uuid, text, text, text, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.upsert_pending_customer_signup(uuid, text, text, text, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_pending_customer_signup(uuid, text, text, text, text, text) TO service_role;

DO $acl$
BEGIN
  IF has_function_privilege(
       'public',
       'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
       'EXECUTE'
     ) IS NOT TRUE
     OR has_function_privilege(
       'postgres',
       'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
       'EXECUTE'
     ) IS NOT TRUE
  THEN
    RAISE EXCEPTION 'phase a8b2 ACL assertion failed';
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
  IF n <> 200 THEN
    RAISE EXCEPTION 'expected authenticated SECURITY DEFINER 200, got %', n;
  END IF;
END;
$auth_secdef$;

DO $auth_probe$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.upsert_pending_customer_signup(
    '00000000-0000-0000-0000-000000000001'::uuid,
    'Probe',
    'User',
    'probe@example.invalid',
    '00000000000',
    'phase_a8b2'
  );
  RAISE EXCEPTION 'authenticated upsert_pending_customer_signup was allowed';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END;
$auth_probe$;
RESET ROLE;

DO $customer_probe$
DECLARE
  v_customer uuid;
BEGIN
  SELECT c.user_id INTO v_customer
  FROM public.customers c
  WHERE c.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = c.user_id)
  LIMIT 1;
  IF v_customer IS NULL THEN
    RAISE EXCEPTION 'no customer fixture';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_customer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_customer, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.upsert_pending_customer_signup(
      '00000000-0000-0000-0000-000000000001'::uuid,
      'Probe',
      'User',
      'probe@example.invalid',
      '00000000000',
      'phase_a8b2'
    );
    RAISE EXCEPTION 'customer upsert_pending_customer_signup was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
END;
$customer_probe$;

DO $driver_probe$
DECLARE
  v_driver uuid;
BEGIN
  SELECT d.user_id INTO v_driver
  FROM public.drivers d
  WHERE d.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.staff_profiles sp WHERE sp.user_id = d.user_id)
  LIMIT 1;
  IF v_driver IS NULL THEN
    RAISE EXCEPTION 'no driver fixture';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.upsert_pending_customer_signup(
      '00000000-0000-0000-0000-000000000001'::uuid,
      'Probe',
      'User',
      'probe@example.invalid',
      '00000000000',
      'phase_a8b2'
    );
    RAISE EXCEPTION 'driver upsert_pending_customer_signup was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
END;
$driver_probe$;

DO $corporate_probe$
DECLARE
  v_corp uuid;
BEGIN
  SELECT cua.user_id INTO v_corp
  FROM public.corporate_user_accounts cua
  WHERE cua.user_id IS NOT NULL
  LIMIT 1;
  IF v_corp IS NULL THEN
    RAISE EXCEPTION 'no corporate fixture';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_corp::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_corp, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.upsert_pending_customer_signup(
      '00000000-0000-0000-0000-000000000001'::uuid,
      'Probe',
      'User',
      'probe@example.invalid',
      '00000000000',
      'phase_a8b2'
    );
    RAISE EXCEPTION 'corporate upsert_pending_customer_signup was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
END;
$corporate_probe$;

DO $staff_probe$
DECLARE
  v_staff uuid;
BEGIN
  SELECT sp.user_id INTO v_staff
  FROM public.staff_profiles sp
  WHERE sp.is_active = true
  LIMIT 1;
  IF v_staff IS NULL THEN
    RAISE EXCEPTION 'no staff fixture';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.upsert_pending_customer_signup(
      '00000000-0000-0000-0000-000000000001'::uuid,
      'Probe',
      'User',
      'probe@example.invalid',
      '00000000000',
      'phase_a8b2'
    );
    RAISE EXCEPTION 'staff upsert_pending_customer_signup was allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
END;
$staff_probe$;

DO $hashes$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM a8b2_hash h
    JOIN pg_proc p ON true
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'upsert_pending_customer_signup'
      AND pg_get_function_identity_arguments(p.oid) =
        'p_user_id uuid, p_first_name text, p_last_name text, p_email text, p_phone text, p_signup_source text'
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
    FROM a8b2_counts c
    WHERE c.pending_total IS DISTINCT FROM (SELECT count(*) FROM public.pending_customer_signups)
       OR c.pending_status IS DISTINCT FROM (
            SELECT count(*) FILTER (WHERE status = 'pending') FROM public.pending_customer_signups)
       OR c.completed_status IS DISTINCT FROM (
            SELECT count(*) FILTER (WHERE status = 'completed') FROM public.pending_customer_signups)
       OR c.expired_status IS DISTINCT FROM (
            SELECT count(*) FILTER (WHERE status = 'expired') FROM public.pending_customer_signups)
       OR c.abandoned_status IS DISTINCT FROM (
            SELECT count(*) FILTER (WHERE status = 'abandoned') FROM public.pending_customer_signups)
       OR c.customers IS DISTINCT FROM (SELECT count(*) FROM public.customers)
       OR c.drivers IS DISTINCT FROM (SELECT count(*) FROM public.drivers)
       OR c.auth_users IS DISTINCT FROM (SELECT count(*) FROM auth.users)
       OR c.auth_identities IS DISTINCT FROM (SELECT count(*) FROM auth.identities)
       OR c.unverified_email_users IS DISTINCT FROM (
            SELECT count(*) FROM auth.users WHERE email_confirmed_at IS NULL)
       OR c.email_change_requests IS DISTINCT FROM (
            SELECT count(*) FROM public.account_email_change_requests)
       OR c.corporate_accounts IS DISTINCT FROM (SELECT count(*) FROM public.corporate_accounts)
       OR c.corporate_memberships IS DISTINCT FROM (SELECT count(*) FROM public.corporate_user_accounts)
       OR c.trips IS DISTINCT FROM (SELECT count(*) FROM public.trips)
       OR c.payment_sessions IS DISTINCT FROM (SELECT count(*) FROM public.payment_sessions)
       OR c.wallet_rows IS DISTINCT FROM (SELECT count(*) FROM public.driver_wallet_ledger)
       OR c.wallet_signed_sum IS DISTINCT FROM (
            SELECT coalesce(sum(amount_pence), 0) FROM public.driver_wallet_ledger)
  ) THEN
    RAISE EXCEPTION 'integrity counts changed inside simulation';
  END IF;
END;
$counts$;

SELECT
  (SELECT body_md5 FROM a8b2_hash) AS body_hash,
  has_function_privilege(
    'public',
    'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
    'EXECUTE'
  ) AS public_exec,
  has_function_privilege(
    'anon',
    'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
    'EXECUTE'
  ) AS anon_exec,
  has_function_privilege(
    'authenticated',
    'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
    'EXECUTE'
  ) AS auth_exec,
  has_function_privilege(
    'service_role',
    'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
    'EXECUTE'
  ) AS sr_exec,
  has_function_privilege(
    'postgres',
    'public.upsert_pending_customer_signup(uuid, text, text, text, text, text)'::regprocedure,
    'EXECUTE'
  ) AS postgres_exec,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  (SELECT pending_total FROM a8b2_counts) AS pending_total,
  (SELECT auth_users FROM a8b2_counts) AS auth_users,
  (SELECT trips FROM a8b2_counts) AS trips,
  EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109130000'
  ) AS migration_applied;

ROLLBACK;
