-- Non-committing verification for 20261107120000_admin_riders_view_security_invoker_lock.sql
-- Applies migration in a transaction, runs role matrix, then ROLLBACK.
-- NEVER COMMIT. Always ends with ROLLBACK even on failure via wrapping.

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE TEMP TABLE _verify_riders AS
SELECT count(*)::int AS baseline_count FROM public.admin_riders_with_trip_stats;

DROP VIEW IF EXISTS public.admin_riders_with_trip_stats;

CREATE VIEW public.admin_riders_with_trip_stats
WITH (security_invoker = true)
AS
SELECT
  c.id,
  c.user_id,
  c.customer_code,
  c.first_name,
  c.last_name,
  c.phone,
  public.admin_get_user_email(c.user_id) AS email,
  c.created_at,
  c.updated_at,
  c.rider_status,
  c.email_verified,
  c.phone_verified,
  c.identity_verified_at,
  c.identity_provider,
  c.name_edit_locked,
  c.name_unlocked_at,
  COALESCE(ts.trip_count, 0) AS trip_count,
  ts.last_trip_at
FROM public.customers c
LEFT JOIN (
  SELECT
    t.passenger_id,
    count(*)::integer AS trip_count,
    max(t.created_at) AS last_trip_at
  FROM public.trips t
  WHERE t.passenger_id IS NOT NULL
  GROUP BY t.passenger_id
) ts ON ts.passenger_id = c.id
WHERE c.deleted_at IS NULL
  AND (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    OR auth.role() = 'service_role'
  );

REVOKE ALL ON TABLE public.admin_riders_with_trip_stats FROM PUBLIC;
REVOKE ALL ON TABLE public.admin_riders_with_trip_stats FROM anon;
REVOKE ALL ON TABLE public.admin_riders_with_trip_stats FROM authenticated;
REVOKE ALL ON TABLE public.admin_riders_with_trip_stats FROM service_role;
GRANT SELECT ON TABLE public.admin_riders_with_trip_stats TO authenticated;
GRANT SELECT ON TABLE public.admin_riders_with_trip_stats TO service_role;

DO $$
DECLARE
  opts text[];
BEGIN
  SELECT c.reloptions INTO opts
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'admin_riders_with_trip_stats';

  IF opts IS NULL OR NOT (opts @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'VERIFY FAIL: security_invoker=true missing (opts=%)', opts;
  END IF;
  IF has_table_privilege('anon', 'public.admin_riders_with_trip_stats', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAIL: anon still has SELECT';
  END IF;
  IF has_table_privilege('authenticated', 'public.admin_riders_with_trip_stats', 'INSERT')
     OR has_table_privilege('authenticated', 'public.admin_riders_with_trip_stats', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.admin_riders_with_trip_stats', 'DELETE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: authenticated still has DML';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.admin_riders_with_trip_stats', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAIL: authenticated missing SELECT';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.admin_riders_with_trip_stats', 'SELECT') THEN
    RAISE EXCEPTION 'VERIFY FAIL: service_role missing SELECT';
  END IF;
  IF has_table_privilege('service_role', 'public.admin_riders_with_trip_stats', 'INSERT') THEN
    RAISE EXCEPTION 'VERIFY FAIL: service_role has INSERT';
  END IF;
  RAISE NOTICE 'STRUCTURAL_OK';
END $$;

DO $$
BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM 1 FROM public.admin_riders_with_trip_stats LIMIT 1;
    RESET ROLE;
    RAISE EXCEPTION 'VERIFY FAIL: anon was able to SELECT';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE 'ANON_OK permission_denied';
  END;
END $$;

-- customer → 0 rows + email helper null
DO $$
DECLARE
  n int;
  target uuid;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '0275045a-41cc-48d8-823c-6176d0c25a53', 'role', 'authenticated')::text,
    true);
  PERFORM set_config('request.jwt.claim.sub', '0275045a-41cc-48d8-823c-6176d0c25a53', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.admin_riders_with_trip_stats;
  SELECT user_id INTO target FROM public.customers WHERE deleted_at IS NULL AND user_id IS NOT NULL LIMIT 1;
  IF public.admin_get_user_email(target) IS NOT NULL THEN
    RESET ROLE;
    RAISE EXCEPTION 'VERIFY FAIL: customer resolved admin_get_user_email';
  END IF;
  RESET ROLE;
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAIL: customer saw % rows', n;
  END IF;
  RAISE NOTICE 'CUSTOMER_OK zero_rows email_helper_null';
END $$;

-- driver → 0 rows
DO $$
DECLARE
  n int;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '00c10d74-00aa-401e-8ff2-48b8a2a1c349', 'role', 'authenticated')::text,
    true);
  PERFORM set_config('request.jwt.claim.sub', '00c10d74-00aa-401e-8ff2-48b8a2a1c349', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.admin_riders_with_trip_stats;
  RESET ROLE;
  IF n <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAIL: driver saw % rows', n;
  END IF;
  RAISE NOTICE 'DRIVER_OK zero_rows';
END $$;

-- admin → rows == baseline
DO $$
DECLARE
  n int;
  baseline int;
  em_nonnull int;
BEGIN
  SELECT baseline_count INTO baseline FROM _verify_riders;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', '9ab3080c-73ef-4c36-b92b-ae8e8f4815f2', 'role', 'authenticated')::text,
    true);
  PERFORM set_config('request.jwt.claim.sub', '9ab3080c-73ef-4c36-b92b-ae8e8f4815f2', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.admin_riders_with_trip_stats;
  SELECT count(*) FILTER (WHERE email IS NOT NULL) INTO em_nonnull
  FROM public.admin_riders_with_trip_stats;
  RESET ROLE;
  IF n < 1 OR n <> baseline THEN
    RAISE EXCEPTION 'VERIFY FAIL: admin rows=% baseline=%', n, baseline;
  END IF;
  RAISE NOTICE 'ADMIN_OK rows=% email_nonnull=%', n, em_nonnull;
END $$;

-- service_role → SELECT works
DO $$
DECLARE
  n int;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('role', 'service_role')::text,
    true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  SET LOCAL ROLE service_role;
  SELECT count(*) INTO n FROM public.admin_riders_with_trip_stats;
  RESET ROLE;
  IF n < 1 THEN
    RAISE EXCEPTION 'VERIFY FAIL: service_role saw 0 rows';
  END IF;
  RAISE NOTICE 'SERVICE_ROLE_OK rows=%', n;
END $$;

DO $$
DECLARE
  cols text;
BEGIN
  SELECT string_agg(attname, ',' ORDER BY attnum)
    INTO cols
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'admin_riders_with_trip_stats'
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF cols IS DISTINCT FROM 'id,user_id,customer_code,first_name,last_name,phone,email,created_at,updated_at,rider_status,email_verified,phone_verified,identity_verified_at,identity_provider,name_edit_locked,name_unlocked_at,trip_count,last_trip_at' THEN
    RAISE EXCEPTION 'VERIFY FAIL: column set changed: %', cols;
  END IF;
  RAISE NOTICE 'COLUMNS_OK';
END $$;

ROLLBACK;

SELECT 'VERIFY_COMPLETE_ROLLED_BACK' AS status;
