-- Phase A8B1 ACL simulation. Applies the draft REVOKEs, probes privilege only,
-- then ROLLBACK. Does not invoke the function body as any role.

BEGIN;

CREATE TEMP TABLE a8b1_hash AS
SELECT md5(p.prosrc) AS body_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'admin_cancel_trip_negotiation'
  AND pg_get_function_identity_arguments(p.oid) = 'p_trip_id uuid, p_reason text';

CREATE TEMP TABLE a8b1_counts AS
SELECT
  (SELECT count(*) FROM public.trips) AS trips,
  (SELECT count(*) FILTER (
      WHERE negotiation_locked_until IS NOT NULL
         OR current_offer_driver_id IS NOT NULL
         OR negotiation_owner_driver_id IS NOT NULL
    ) FROM public.trips) AS negotiating_ish,
  (SELECT count(*) FILTER (
      WHERE lower(coalesce(status, '')) NOT IN (
        'completed','cancelled','canceled','expired','no_driver','failed',
        'refunded','released','customer_cancelled','passenger_cancelled',
        'expired_no_driver','no_show'
      )
    ) FROM public.trips) AS nonterminal,
  (SELECT count(*) FILTER (WHERE confirmed_driver_id IS NOT NULL) FROM public.trips) AS with_confirmed_driver,
  (SELECT count(*) FILTER (WHERE driver_id IS NOT NULL) FROM public.trips) AS with_driver,
  (SELECT count(*) FROM public.ride_offers) AS ride_offers,
  (SELECT count(*) FILTER (WHERE status = 'pending') FROM public.ride_offers) AS offers_pending,
  (SELECT count(*) FILTER (WHERE status = 'countered') FROM public.ride_offers) AS offers_countered,
  (SELECT count(*) FILTER (WHERE status = 'revoked') FROM public.ride_offers) AS offers_revoked,
  (SELECT count(*) FROM public.dispatch_wave_snapshots) AS dispatch_snapshots,
  (SELECT count(*) FROM public.notifications) AS notifications,
  (SELECT count(*) FROM public.payment_sessions) AS payment_sessions,
  (SELECT count(*) FROM public.driver_wallet_ledger) AS wallet_rows,
  (SELECT coalesce(sum(abs(amount_pence)), 0) FROM public.driver_wallet_ledger) AS wallet_abs_sum,
  (SELECT count(*) FROM auth.users) AS auth_users;

DO $pre$
BEGIN
  IF (SELECT body_md5 FROM a8b1_hash) IS DISTINCT FROM '38d3b73a135bbe8a9a838c092c9d8188' THEN
    RAISE EXCEPTION 'unexpected production body hash before simulation';
  END IF;
  IF has_function_privilege('authenticated', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('service_role', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('postgres', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('public', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'unexpected baseline ACL before simulation';
  END IF;
END;
$pre$;

REVOKE ALL ON FUNCTION public.admin_cancel_trip_negotiation(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_cancel_trip_negotiation(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_cancel_trip_negotiation(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cancel_trip_negotiation(uuid, text) TO service_role;

DO $acl$
BEGIN
  IF has_function_privilege('public', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('service_role', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE') IS NOT TRUE
     OR has_function_privilege('postgres', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE') IS NOT TRUE
  THEN
    RAISE EXCEPTION 'phase a8b1 ACL assertion failed';
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
  IF n <> 201 THEN
    RAISE EXCEPTION 'expected authenticated SECURITY DEFINER 201, got %', n;
  END IF;
END;
$auth_secdef$;

DO $auth_probe$
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.admin_cancel_trip_negotiation(
    '00000000-0000-0000-0000-000000000001'::uuid,
    'phase_a8b1_probe'
  );
  RAISE EXCEPTION 'authenticated admin_cancel_trip_negotiation was allowed';
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
    PERFORM public.admin_cancel_trip_negotiation(
      '00000000-0000-0000-0000-000000000001'::uuid,
      'phase_a8b1_probe'
    );
    RAISE EXCEPTION 'customer admin_cancel_trip_negotiation was allowed';
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
    PERFORM public.admin_cancel_trip_negotiation(
      '00000000-0000-0000-0000-000000000001'::uuid,
      'phase_a8b1_probe'
    );
    RAISE EXCEPTION 'driver admin_cancel_trip_negotiation was allowed';
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
    PERFORM public.admin_cancel_trip_negotiation(
      '00000000-0000-0000-0000-000000000001'::uuid,
      'phase_a8b1_probe'
    );
    RAISE EXCEPTION 'corporate admin_cancel_trip_negotiation was allowed';
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
    PERFORM public.admin_cancel_trip_negotiation(
      '00000000-0000-0000-0000-000000000001'::uuid,
      'phase_a8b1_probe'
    );
    RAISE EXCEPTION 'staff admin_cancel_trip_negotiation was allowed';
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
    FROM a8b1_hash h
    JOIN pg_proc p ON true
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'admin_cancel_trip_negotiation'
      AND pg_get_function_identity_arguments(p.oid) = 'p_trip_id uuid, p_reason text'
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
    FROM a8b1_counts c
    WHERE c.trips IS DISTINCT FROM (SELECT count(*) FROM public.trips)
       OR c.negotiating_ish IS DISTINCT FROM (
            SELECT count(*) FILTER (
              WHERE negotiation_locked_until IS NOT NULL
                 OR current_offer_driver_id IS NOT NULL
                 OR negotiation_owner_driver_id IS NOT NULL
            ) FROM public.trips)
       OR c.nonterminal IS DISTINCT FROM (
            SELECT count(*) FILTER (
              WHERE lower(coalesce(status, '')) NOT IN (
                'completed','cancelled','canceled','expired','no_driver','failed',
                'refunded','released','customer_cancelled','passenger_cancelled',
                'expired_no_driver','no_show'
              )
            ) FROM public.trips)
       OR c.with_confirmed_driver IS DISTINCT FROM (
            SELECT count(*) FILTER (WHERE confirmed_driver_id IS NOT NULL) FROM public.trips)
       OR c.with_driver IS DISTINCT FROM (
            SELECT count(*) FILTER (WHERE driver_id IS NOT NULL) FROM public.trips)
       OR c.ride_offers IS DISTINCT FROM (SELECT count(*) FROM public.ride_offers)
       OR c.offers_pending IS DISTINCT FROM (
            SELECT count(*) FILTER (WHERE status = 'pending') FROM public.ride_offers)
       OR c.offers_countered IS DISTINCT FROM (
            SELECT count(*) FILTER (WHERE status = 'countered') FROM public.ride_offers)
       OR c.offers_revoked IS DISTINCT FROM (
            SELECT count(*) FILTER (WHERE status = 'revoked') FROM public.ride_offers)
       OR c.dispatch_snapshots IS DISTINCT FROM (SELECT count(*) FROM public.dispatch_wave_snapshots)
       OR c.notifications IS DISTINCT FROM (SELECT count(*) FROM public.notifications)
       OR c.payment_sessions IS DISTINCT FROM (SELECT count(*) FROM public.payment_sessions)
       OR c.wallet_rows IS DISTINCT FROM (SELECT count(*) FROM public.driver_wallet_ledger)
       OR c.wallet_abs_sum IS DISTINCT FROM (
            SELECT coalesce(sum(abs(amount_pence)), 0) FROM public.driver_wallet_ledger)
       OR c.auth_users IS DISTINCT FROM (SELECT count(*) FROM auth.users)
  ) THEN
    RAISE EXCEPTION 'integrity counts changed inside simulation';
  END IF;
END;
$counts$;

SELECT
  (SELECT body_md5 FROM a8b1_hash) AS body_hash,
  has_function_privilege('public', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE') AS public_exec,
  has_function_privilege('anon', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE') AS anon_exec,
  has_function_privilege('authenticated', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE') AS auth_exec,
  has_function_privilege('service_role', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE') AS sr_exec,
  has_function_privilege('postgres', 'public.admin_cancel_trip_negotiation(uuid, text)'::regprocedure, 'EXECUTE') AS postgres_exec,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_secdef,
  (SELECT trips FROM a8b1_counts) AS trips,
  (SELECT ride_offers FROM a8b1_counts) AS ride_offers,
  (SELECT negotiating_ish FROM a8b1_counts) AS negotiating_ish,
  (SELECT nonterminal FROM a8b1_counts) AS nonterminal,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109120000') AS migration_applied;

ROLLBACK;
