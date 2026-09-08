-- Phase A1 ACL simulation only. Applies the draft matrix, probes, then ROLLBACK.
-- Does not execute either function as postgres or service_role.
-- Authenticated/anon probes use a non-matching sentinel and must fail 42501
-- before the function body runs. No Auth row is created or deleted.

BEGIN;

CREATE TEMP TABLE phase_a1_counts (
  label text PRIMARY KEY,
  auth_users int,
  auth_identities int,
  unverified_users int,
  customers int,
  drivers int,
  pending_onboarding int,
  auth_secdef int,
  reclaim_md5 text,
  repair_md5 text
) ON COMMIT DROP;

INSERT INTO phase_a1_counts
SELECT
  'before',
  (SELECT count(*)::int FROM auth.users),
  (SELECT count(*)::int FROM auth.identities),
  (SELECT count(*)::int FROM auth.users WHERE email_confirmed_at IS NULL AND deleted_at IS NULL),
  (SELECT count(*)::int FROM public.customers),
  (SELECT count(*)::int FROM public.drivers),
  (SELECT count(*)::int FROM public.pending_customer_signups),
  (SELECT count(*)::int
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reclaim_stale_onboarding_auth_user'),
  (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'repair_user_stale_auth_identities');

REVOKE ALL ON FUNCTION public.reclaim_stale_onboarding_auth_user(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reclaim_stale_onboarding_auth_user(text) FROM anon;
REVOKE ALL ON FUNCTION public.reclaim_stale_onboarding_auth_user(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reclaim_stale_onboarding_auth_user(text) TO service_role;

REVOKE ALL ON FUNCTION public.repair_user_stale_auth_identities(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repair_user_stale_auth_identities(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.repair_user_stale_auth_identities(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.repair_user_stale_auth_identities(uuid) TO service_role;

DO $$
DECLARE
  v_auth int := 0;
  v_anon int := 0;
  v_public int := 0;
  v_pg_missing int := 0;
  v_svc_missing int := 0;
  v_name text;
  v_err text;
  v_json jsonb;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'public.reclaim_stale_onboarding_auth_user(text)',
    'public.repair_user_stale_auth_identities(uuid)'
  ]
  LOOP
    IF has_function_privilege('authenticated', v_name::regprocedure, 'EXECUTE') THEN
      v_auth := v_auth + 1;
    END IF;
    IF has_function_privilege('anon', v_name::regprocedure, 'EXECUTE') THEN
      v_anon := v_anon + 1;
    END IF;
    IF has_function_privilege('public', v_name::regprocedure, 'EXECUTE') THEN
      v_public := v_public + 1;
    END IF;
    IF has_function_privilege('postgres', v_name::regprocedure, 'EXECUTE') IS NOT TRUE THEN
      v_pg_missing := v_pg_missing + 1;
    END IF;
    IF has_function_privilege('service_role', v_name::regprocedure, 'EXECUTE') IS NOT TRUE THEN
      v_svc_missing := v_svc_missing + 1;
    END IF;
  END LOOP;

  IF v_auth <> 0 OR v_anon <> 0 OR v_public <> 0 OR v_pg_missing <> 0 OR v_svc_missing <> 0 THEN
    RAISE EXCEPTION 'a1 acl failed auth=% anon=% public=% pg_missing=% svc_missing=%',
      v_auth, v_anon, v_public, v_pg_missing, v_svc_missing;
  END IF;

  -- Customer, driver, staff and the owning user all use the authenticated role.
  -- Privilege is checked before the body, so no jsonb user_id can be returned.
  BEGIN
    SET LOCAL ROLE authenticated;
    SELECT public.reclaim_stale_onboarding_auth_user('phase-a1-acl-probe-not-a-user@invalid.invalid') INTO v_json;
    RESET ROLE;
    RAISE EXCEPTION 'VERIFY FAIL: authenticated executed reclaim → %', v_json;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      RESET ROLE;
      IF SQLSTATE = '42501' THEN NULL;
      ELSE RAISE EXCEPTION 'VERIFY FAIL auth reclaim unexpected: % %', SQLSTATE, v_err;
      END IF;
  END;

  BEGIN
    SET LOCAL ROLE authenticated;
    SELECT public.repair_user_stale_auth_identities('00000000-0000-0000-0000-000000000000'::uuid) INTO v_json;
    RESET ROLE;
    RAISE EXCEPTION 'VERIFY FAIL: authenticated executed repair → %', v_json;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      RESET ROLE;
      IF SQLSTATE = '42501' THEN NULL;
      ELSE RAISE EXCEPTION 'VERIFY FAIL auth repair unexpected: % %', SQLSTATE, v_err;
      END IF;
  END;

  BEGIN
    SET LOCAL ROLE anon;
    SELECT public.reclaim_stale_onboarding_auth_user('phase-a1-acl-probe-not-a-user@invalid.invalid') INTO v_json;
    RESET ROLE;
    RAISE EXCEPTION 'VERIFY FAIL: anon executed reclaim → %', v_json;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      RESET ROLE;
      IF SQLSTATE = '42501' THEN NULL;
      ELSE RAISE EXCEPTION 'VERIFY FAIL anon reclaim unexpected: % %', SQLSTATE, v_err;
      END IF;
  END;

  BEGIN
    SET LOCAL ROLE anon;
    SELECT public.repair_user_stale_auth_identities('00000000-0000-0000-0000-000000000000'::uuid) INTO v_json;
    RESET ROLE;
    RAISE EXCEPTION 'VERIFY FAIL: anon executed repair → %', v_json;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      RESET ROLE;
      IF SQLSTATE = '42501' THEN NULL;
      ELSE RAISE EXCEPTION 'VERIFY FAIL anon repair unexpected: % %', SQLSTATE, v_err;
      END IF;
  END;
END $$;

INSERT INTO phase_a1_counts
SELECT
  'after_acl',
  (SELECT count(*)::int FROM auth.users),
  (SELECT count(*)::int FROM auth.identities),
  (SELECT count(*)::int FROM auth.users WHERE email_confirmed_at IS NULL AND deleted_at IS NULL),
  (SELECT count(*)::int FROM public.customers),
  (SELECT count(*)::int FROM public.drivers),
  (SELECT count(*)::int FROM public.pending_customer_signups),
  (SELECT count(*)::int
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reclaim_stale_onboarding_auth_user'),
  (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'repair_user_stale_auth_identities');

DO $$
DECLARE
  b phase_a1_counts%ROWTYPE;
  a phase_a1_counts%ROWTYPE;
BEGIN
  SELECT * INTO b FROM phase_a1_counts WHERE label = 'before';
  SELECT * INTO a FROM phase_a1_counts WHERE label = 'after_acl';
  IF a.auth_secdef <> b.auth_secdef - 2 THEN
    RAISE EXCEPTION 'a1 count failed before=% after=%', b.auth_secdef, a.auth_secdef;
  END IF;
  IF a.auth_secdef <> 223 THEN
    RAISE EXCEPTION 'a1 expected 223 inside simulation, got %', a.auth_secdef;
  END IF;
  IF a.auth_users <> b.auth_users
     OR a.auth_identities <> b.auth_identities
     OR a.unverified_users <> b.unverified_users
     OR a.customers <> b.customers
     OR a.drivers <> b.drivers
     OR a.pending_onboarding <> b.pending_onboarding
     OR a.reclaim_md5 <> b.reclaim_md5
     OR a.repair_md5 <> b.repair_md5 THEN
    RAISE EXCEPTION 'a1 integrity drift users %→% identities %→% unverified %→% customers %→% drivers %→% pending %→% reclaim % / % repair % / %',
      b.auth_users, a.auth_users,
      b.auth_identities, a.auth_identities,
      b.unverified_users, a.unverified_users,
      b.customers, a.customers,
      b.drivers, a.drivers,
      b.pending_onboarding, a.pending_onboarding,
      b.reclaim_md5, a.reclaim_md5,
      b.repair_md5, a.repair_md5;
  END IF;
END $$;

SELECT
  b.auth_secdef AS auth_secdef_before,
  a.auth_secdef AS auth_secdef_inside,
  b.auth_users,
  a.auth_users AS auth_users_after_acl,
  b.auth_identities,
  a.auth_identities AS auth_identities_after_acl,
  b.unverified_users,
  a.unverified_users AS unverified_after_acl,
  b.customers,
  a.customers AS customers_after_acl,
  b.drivers,
  a.drivers AS drivers_after_acl,
  b.pending_onboarding,
  a.pending_onboarding AS pending_after_acl,
  b.reclaim_md5,
  a.reclaim_md5 AS reclaim_md5_after,
  b.repair_md5,
  a.repair_md5 AS repair_md5_after,
  has_function_privilege('authenticated', 'public.reclaim_stale_onboarding_auth_user(text)'::regprocedure, 'EXECUTE') AS auth_reclaim,
  has_function_privilege('anon', 'public.reclaim_stale_onboarding_auth_user(text)'::regprocedure, 'EXECUTE') AS anon_reclaim,
  has_function_privilege('public', 'public.reclaim_stale_onboarding_auth_user(text)'::regprocedure, 'EXECUTE') AS public_reclaim,
  has_function_privilege('service_role', 'public.reclaim_stale_onboarding_auth_user(text)'::regprocedure, 'EXECUTE') AS svc_reclaim,
  has_function_privilege('postgres', 'public.reclaim_stale_onboarding_auth_user(text)'::regprocedure, 'EXECUTE') AS pg_reclaim,
  has_function_privilege('authenticated', 'public.repair_user_stale_auth_identities(uuid)'::regprocedure, 'EXECUTE') AS auth_repair,
  has_function_privilege('anon', 'public.repair_user_stale_auth_identities(uuid)'::regprocedure, 'EXECUTE') AS anon_repair,
  has_function_privilege('service_role', 'public.repair_user_stale_auth_identities(uuid)'::regprocedure, 'EXECUTE') AS svc_repair,
  has_function_privilege('postgres', 'public.repair_user_stale_auth_identities(uuid)'::regprocedure, 'EXECUTE') AS pg_repair
FROM phase_a1_counts b
JOIN phase_a1_counts a ON a.label = 'after_acl'
WHERE b.label = 'before';

ROLLBACK;
