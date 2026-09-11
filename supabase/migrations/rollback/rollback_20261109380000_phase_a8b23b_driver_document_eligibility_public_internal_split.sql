-- ============================================================
-- Rollback Phase A8B23B
-- Restores exact public eligibility body from internal clone,
-- restores direct parents to call the public name, drops internal,
-- restores baseline public ACL (including service_role).
-- Never grants PUBLIC/anon.
-- ============================================================

BEGIN;

-- 1) Restore parents: internal call → public call
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
    IF position('get_driver_document_eligibility_internal(' in v_src) = 0 THEN
      RAISE EXCEPTION 'A8B23B rollback HARD STOP: % missing internal call', r.proname;
    END IF;
    v_new := replace(v_src, 'get_driver_document_eligibility_internal(', 'get_driver_document_eligibility(');

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

GRANT EXECUTE ON FUNCTION public.check_driver_documents_approved(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.assert_driver_presence_online_eligible(uuid) FROM service_role;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.accept_ride_offer_eligibility_guard(uuid) FROM service_role;

-- 2) Restore public body from internal clone (exact baseline computation)
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'get_driver_document_eligibility_internal'
    AND pg_get_function_identity_arguments(p.oid) = 'p_driver_id uuid';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'A8B23B rollback HARD STOP: internal helper missing';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_driver_document_eligibility(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''public''
AS %L',
    v_src
  );
END $$;

GRANT EXECUTE ON FUNCTION public.get_driver_document_eligibility(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_document_eligibility(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility(uuid) FROM anon;

-- 3) Drop internal only after public + parents restored
DROP FUNCTION IF EXISTS public.get_driver_document_eligibility_internal(uuid);

-- 4) Assert baseline restored
DO $$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='get_driver_document_eligibility')
     IS DISTINCT FROM '55d576d83a424beb3de3c79a4cf629d4' THEN
    RAISE EXCEPTION 'A8B23B rollback HARD STOP: public md5 not restored';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='check_driver_documents_approved')
     IS DISTINCT FROM 'b028018a57c8acfca1b6e1f59e7fc2c5' THEN
    RAISE EXCEPTION 'A8B23B rollback HARD STOP: check md5 not restored';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='assert_driver_presence_online_eligible')
     IS DISTINCT FROM '04fa4657ebaabb08623679496ff0652c' THEN
    RAISE EXCEPTION 'A8B23B rollback HARD STOP: assert md5 not restored';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
      WHERE p.proname='accept_ride_offer_eligibility_guard')
     IS DISTINCT FROM 'ac499859d589358f39ad28312a951c65' THEN
    RAISE EXCEPTION 'A8B23B rollback HARD STOP: accept md5 not restored';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
    WHERE p.proname='get_driver_document_eligibility_internal'
  ) THEN
    RAISE EXCEPTION 'A8B23B rollback HARD STOP: internal still present';
  END IF;
END $$;

COMMIT;
