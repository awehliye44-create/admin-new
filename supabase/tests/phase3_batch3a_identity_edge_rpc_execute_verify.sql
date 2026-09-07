-- Phase 3 Batch 3A — transaction-only role matrix.
-- Applies the Batch 3A REVOKEs inside this transaction, probes, then ROLLBACK.
-- Do not run the migration file itself. This script must never COMMIT.
-- Privilege checks only. Does not call mutating identity RPCs.

BEGIN;

CREATE TEMP TABLE batch3a_probe (
  key text PRIMARY KEY,
  value text NOT NULL
) ON COMMIT DROP;

DO $$
DECLARE
  v_names text[] := ARRAY[
    'reset_auth_user_email_unconfirmed(uuid)',
    'get_user_id_by_email(text)',
    'mark_account_email_verified(uuid, text)',
    'stage_phone_change(uuid, text, text)',
    'stage_email_change(uuid, text, text)',
    'clear_phone_change_pending(uuid, text)',
    'complete_phone_change_customer(uuid)',
    'complete_phone_change_driver(uuid)',
    'complete_email_change_customer(uuid, text)',
    'complete_email_change_driver(uuid, text)',
    'finalize_customer_onboarding(uuid)',
    'sync_customer_phone_verification(uuid)',
    'sync_driver_phone_verification(uuid)'
  ];
  v_sig text;
  v_oid oid;
  v_before_hash text;
  v_after_hash text;
  v_users_before bigint;
  v_users_after bigint;
  v_customers_before bigint;
  v_customers_after bigint;
  v_drivers_before bigint;
  v_drivers_after bigint;
  v_auth_secdef_before int;
  v_auth_secdef_after int;
  v_denied int := 0;
  v_owner_uid uuid;
BEGIN
  SELECT count(*) INTO v_users_before FROM auth.users;
  SELECT count(*) INTO v_customers_before FROM public.customers;
  SELECT count(*) INTO v_drivers_before FROM public.drivers;

  SELECT count(*) INTO v_auth_secdef_before
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

  INSERT INTO batch3a_probe VALUES ('auth_secdef_before', v_auth_secdef_before::text);
  INSERT INTO batch3a_probe VALUES ('signature_count', array_length(v_names, 1)::text);

  FOREACH v_sig IN ARRAY v_names LOOP
    v_oid := to_regprocedure('public.' || v_sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'missing signature public.%', v_sig;
    END IF;
    IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'baseline missing authenticated EXECUTE on %', v_sig;
    END IF;
    v_before_hash := md5(pg_get_functiondef(v_oid));
    INSERT INTO batch3a_probe VALUES ('def_before:' || v_sig, v_before_hash);
  END LOOP;

  -- Same ACL delta as 20261107180000. In-transaction only.
  REVOKE ALL ON FUNCTION public.reset_auth_user_email_unconfirmed(uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.reset_auth_user_email_unconfirmed(uuid) TO service_role;
  REVOKE ALL ON FUNCTION public.get_user_id_by_email(text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.get_user_id_by_email(text) TO service_role;
  REVOKE ALL ON FUNCTION public.mark_account_email_verified(uuid, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.mark_account_email_verified(uuid, text) TO service_role;
  REVOKE ALL ON FUNCTION public.stage_phone_change(uuid, text, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.stage_phone_change(uuid, text, text) TO service_role;
  REVOKE ALL ON FUNCTION public.stage_email_change(uuid, text, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.stage_email_change(uuid, text, text) TO service_role;
  REVOKE ALL ON FUNCTION public.clear_phone_change_pending(uuid, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.clear_phone_change_pending(uuid, text) TO service_role;
  REVOKE ALL ON FUNCTION public.complete_phone_change_customer(uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.complete_phone_change_customer(uuid) TO service_role;
  REVOKE ALL ON FUNCTION public.complete_phone_change_driver(uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.complete_phone_change_driver(uuid) TO service_role;
  REVOKE ALL ON FUNCTION public.complete_email_change_customer(uuid, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.complete_email_change_customer(uuid, text) TO service_role;
  REVOKE ALL ON FUNCTION public.complete_email_change_driver(uuid, text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.complete_email_change_driver(uuid, text) TO service_role;
  REVOKE ALL ON FUNCTION public.finalize_customer_onboarding(uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.finalize_customer_onboarding(uuid) TO service_role;
  REVOKE ALL ON FUNCTION public.sync_customer_phone_verification(uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.sync_customer_phone_verification(uuid) TO service_role;
  REVOKE ALL ON FUNCTION public.sync_driver_phone_verification(uuid) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.sync_driver_phone_verification(uuid) TO service_role;

  FOREACH v_sig IN ARRAY v_names LOOP
    v_oid := to_regprocedure('public.' || v_sig);
    IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: PUBLIC still has EXECUTE on %', v_sig;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: anon still has EXECUTE on %', v_sig;
    END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: authenticated still has EXECUTE on %', v_sig;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: service_role lost EXECUTE on %', v_sig;
    END IF;
    IF NOT has_function_privilege('postgres', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL: postgres lost EXECUTE on %', v_sig;
    END IF;
    v_after_hash := md5(pg_get_functiondef(v_oid));
    SELECT value INTO v_before_hash FROM batch3a_probe WHERE key = 'def_before:' || v_sig;
    IF v_before_hash IS DISTINCT FROM v_after_hash THEN
      RAISE EXCEPTION 'FAIL: function definition changed for %', v_sig;
    END IF;
  END LOOP;

  -- Role probes: EXECUTE denied before function body. No identity mutation.
  SELECT c.user_id INTO v_owner_uid
  FROM public.customers c
  WHERE c.user_id IS NOT NULL
  ORDER BY c.created_at NULLS LAST
  LIMIT 1;

  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.get_user_id_by_email('batch3a-probe-does-not-exist@example.invalid');
    RAISE EXCEPTION 'FAIL: anon executed get_user_id_by_email';
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := v_denied + 1;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.get_user_id_by_email('batch3a-probe-does-not-exist@example.invalid');
    RAISE EXCEPTION 'FAIL: customer jwt executed get_user_id_by_email';
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := v_denied + 1;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.get_user_id_by_email('batch3a-probe-does-not-exist@example.invalid');
    RAISE EXCEPTION 'FAIL: unrelated driver/staff jwt executed get_user_id_by_email';
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := v_denied + 1;
  END;
  RESET ROLE;

  IF v_owner_uid IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.sub', v_owner_uid::text, true);
    BEGIN
      EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.get_user_id_by_email('batch3a-probe-does-not-exist@example.invalid');
      RAISE EXCEPTION 'FAIL: owning user executed get_user_id_by_email';
    EXCEPTION WHEN insufficient_privilege THEN
      v_denied := v_denied + 1;
    END;
    RESET ROLE;
  ELSE
    v_denied := v_denied + 1;
  END IF;

  SELECT count(*) INTO v_auth_secdef_after
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_auth_secdef_after <> v_auth_secdef_before - array_length(v_names, 1) THEN
    RAISE EXCEPTION 'FAIL: auth SECDEF % -> %, expected drop %',
      v_auth_secdef_before, v_auth_secdef_after, array_length(v_names, 1);
  END IF;

  SELECT count(*) INTO v_users_after FROM auth.users;
  SELECT count(*) INTO v_customers_after FROM public.customers;
  SELECT count(*) INTO v_drivers_after FROM public.drivers;
  IF v_users_before IS DISTINCT FROM v_users_after
     OR v_customers_before IS DISTINCT FROM v_customers_after
     OR v_drivers_before IS DISTINCT FROM v_drivers_after THEN
    RAISE EXCEPTION 'FAIL: identity table counts changed inside probe';
  END IF;

  INSERT INTO batch3a_probe VALUES ('role_denials', v_denied::text);
  INSERT INTO batch3a_probe VALUES ('auth_secdef_after', v_auth_secdef_after::text);
  INSERT INTO batch3a_probe VALUES ('auth_secdef_drop', (v_auth_secdef_before - v_auth_secdef_after)::text);
  INSERT INTO batch3a_probe VALUES ('users_unchanged', (v_users_before = v_users_after)::text);
  INSERT INTO batch3a_probe VALUES ('customers_unchanged', (v_customers_before = v_customers_after)::text);
  INSERT INTO batch3a_probe VALUES ('drivers_unchanged', (v_drivers_before = v_drivers_after)::text);
  INSERT INTO batch3a_probe VALUES ('status', 'pass');
END $$;

SELECT key, value
FROM batch3a_probe
WHERE key NOT LIKE 'def_before:%'
ORDER BY key;

ROLLBACK;
