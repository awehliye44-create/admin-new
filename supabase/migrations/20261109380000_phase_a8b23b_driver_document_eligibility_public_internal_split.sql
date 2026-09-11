-- ============================================================
-- Phase A8B23B: get_driver_document_eligibility public/internal split
-- Applied to ACTIVE_HEALTHY as 20261109380000.
--
-- Public (Driver JWT): self-bound wrapper
-- Internal (postgres parents / trusted chain): exact production computation
--
-- Baseline public MD5:  55d576d83a424beb3de3c79a4cf629d4
-- Applied public MD5:   dab246830972a37c6351767322b0f66d
-- Applied internal MD5: 55d576d83a424beb3de3c79a4cf629d4  (exact clone)
--
-- Direct parents rewired (call-site rename only):
--   check_driver_documents_approved
--     baseline b028018a57c8acfca1b6e1f59e7fc2c5
--     applied  c19c0eeb8b08eb136aed6683937ccd0e
--   assert_driver_presence_online_eligible
--     baseline 04fa4657ebaabb08623679496ff0652c
--     applied  189b842f514da1f2e484fd459df788f2
--   accept_ride_offer_eligibility_guard
--     baseline ac499859d589358f39ad28312a951c65
--     applied  5187523904390ffed251558534bc1bc6
--
-- service_role: revoked from public wrapper (no direct Edge caller).
-- Edge guard-onboarding-login uses check_driver_documents_approved via
-- service client with driver.id from drivers.user_id = auth user — retained.
--
-- Expected authenticated SECDEF count: unchanged 110
-- (internal helper has no authenticated EXECUTE).
-- ============================================================

BEGIN;

-- Preconditions
DO $$
DECLARE
  v_md5 text;
  v_auth int;
BEGIN
  IF (SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 1)
     IS DISTINCT FROM '20261109370000' THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: unexpected latest migration';
  END IF;
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261109380000') THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: migration already recorded';
  END IF;

  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'get_driver_document_eligibility'
    AND pg_get_function_identity_arguments(p.oid) = 'p_driver_id uuid';
  IF v_md5 IS DISTINCT FROM '55d576d83a424beb3de3c79a4cf629d4' THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: public eligibility md5=%', v_md5;
  END IF;

  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='check_driver_documents_approved')
     IS DISTINCT FROM 'b028018a57c8acfca1b6e1f59e7fc2c5' THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: check_driver_documents_approved drift';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='assert_driver_presence_online_eligible')
     IS DISTINCT FROM '04fa4657ebaabb08623679496ff0652c' THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: assert_driver_presence_online_eligible drift';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='accept_ride_offer_eligibility_guard')
     IS DISTINCT FROM 'ac499859d589358f39ad28312a951c65' THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: accept_ride_offer_eligibility_guard drift';
  END IF;

  SELECT count(*)::int INTO v_auth
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_auth IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: auth_secdef=%', v_auth;
  END IF;
END $$;

-- 1) Clone exact production computation into trusted internal helper
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'get_driver_document_eligibility'
    AND pg_get_function_identity_arguments(p.oid) = 'p_driver_id uuid';

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_driver_document_eligibility_internal(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''public''
AS %L',
    v_src
  );
END $$;

COMMENT ON FUNCTION public.get_driver_document_eligibility_internal(uuid) IS
  'Trusted arbitrary-driver document eligibility SSOT. Callable only by postgres-owned parents / owner privilege. No auth.uid() authorization — ACL + trusted callers only.';

REVOKE ALL ON FUNCTION public.get_driver_document_eligibility_internal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility_internal(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility_internal(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility_internal(uuid) FROM service_role;

DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='get_driver_document_eligibility_internal')
     IS DISTINCT FROM '55d576d83a424beb3de3c79a4cf629d4' THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: internal clone md5 mismatch';
  END IF;
END $$;

-- 2) Rewire direct parents (call-site rename only) before replacing public
DO $$
DECLARE
  r record;
  v_src text;
  v_new text;
BEGIN
  FOR r IN
    SELECT p.proname,
           pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_function_result(p.oid) AS result,
           l.lanname,
           CASE p.provolatile WHEN 'v' THEN 'VOLATILE' WHEN 's' THEN 'STABLE' WHEN 'i' THEN 'IMMUTABLE' END AS vol,
           p.prosrc
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    JOIN pg_language l ON l.oid = p.prolang
    WHERE p.proname IN (
      'check_driver_documents_approved',
      'assert_driver_presence_online_eligible',
      'accept_ride_offer_eligibility_guard'
    )
  LOOP
    v_src := r.prosrc;
    IF position('get_driver_document_eligibility_internal(' in v_src) > 0 THEN
      RAISE EXCEPTION 'A8B23B HARD STOP: % already rewired', r.proname;
    END IF;
    IF position('get_driver_document_eligibility(' in v_src) = 0 THEN
      RAISE EXCEPTION 'A8B23B HARD STOP: % missing eligibility call', r.proname;
    END IF;
    v_new := replace(v_src, 'get_driver_document_eligibility(', 'get_driver_document_eligibility_internal(');

    IF r.lanname = 'sql' THEN
      EXECUTE format(
        'CREATE OR REPLACE FUNCTION public.%I(%s) RETURNS %s LANGUAGE sql %s SECURITY DEFINER SET search_path TO ''public'' AS $function$%s$function$',
        r.proname, r.args, r.result, r.vol, v_new
      );
    ELSE
      EXECUTE format(
        'CREATE OR REPLACE FUNCTION public.%I(%s) RETURNS %s LANGUAGE plpgsql %s SECURITY DEFINER SET search_path TO ''public'' AS $function$%s$function$',
        r.proname, r.args, r.result, r.vol, v_new
      );
    END IF;
  END LOOP;
END $$;

-- Preserve parent ACLs after CREATE OR REPLACE
GRANT EXECUTE ON FUNCTION public.check_driver_documents_approved(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM service_role;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM service_role;

-- 3) Public self-bound Driver wrapper (signature preserved)
CREATE OR REPLACE FUNCTION public.get_driver_document_eligibility(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Authenticated Driver self-service wrapper. Trusted arbitrary-driver
  -- evaluation lives in get_driver_document_eligibility_internal.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.drivers d
    WHERE d.id = p_driver_id
      AND d.user_id = auth.uid()
      AND d.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN public.get_driver_document_eligibility_internal(p_driver_id);
END;
$function$;

COMMENT ON FUNCTION public.get_driver_document_eligibility(uuid) IS
  'Driver-facing document eligibility RPC. Self-binds p_driver_id to drivers.user_id = auth.uid() then delegates to get_driver_document_eligibility_internal.';

REVOKE ALL ON FUNCTION public.get_driver_document_eligibility(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility(uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_document_eligibility(uuid) TO authenticated;

-- Postconditions
DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='get_driver_document_eligibility_internal')
     IS DISTINCT FROM '55d576d83a424beb3de3c79a4cf629d4' THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: internal md5 post';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='get_driver_document_eligibility')
     IS DISTINCT FROM 'dab246830972a37c6351767322b0f66d' THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: public wrapper md5 post';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='check_driver_documents_approved')
     IS DISTINCT FROM 'c19c0eeb8b08eb136aed6683937ccd0e' THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: check md5 post';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='assert_driver_presence_online_eligible')
     IS DISTINCT FROM '189b842f514da1f2e484fd459df788f2' THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: assert md5 post';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='accept_ride_offer_eligibility_guard')
     IS DISTINCT FROM '5187523904390ffed251558534bc1bc6' THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: accept md5 post';
  END IF;
  IF (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prosecdef
        AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     IS DISTINCT FROM 110 THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: auth_secdef changed';
  END IF;
  IF has_function_privilege('authenticated',
       'public.get_driver_document_eligibility_internal(uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: internal still auth executable';
  END IF;
  IF has_function_privilege('service_role',
       'public.get_driver_document_eligibility(uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8B23B HARD STOP: public still service_role executable';
  END IF;
END $$;

COMMIT;
