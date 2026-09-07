-- Phase 3 Batch 1 — transaction-only role matrix verification.
-- ALWAYS ends in ROLLBACK. Safe for linked production simulation.
-- Apply path under test must already be loaded inside the same transaction
-- (see phase3_batch1_rollback_simulation.sql orchestrator).

-- Probe helpers expect Batch1 functions to exist in-session.

DO $$
DECLARE
  v_driver_a uuid;
  v_driver_b uuid;
  v_user_a uuid;
  v_finance_uid uuid;
  v_ok boolean;
  v_notice text;
BEGIN
  SELECT d.id, d.user_id INTO v_driver_a, v_user_a
  FROM public.drivers d
  WHERE d.user_id IS NOT NULL
  ORDER BY d.created_at NULLS LAST
  LIMIT 1;

  SELECT d.id INTO v_driver_b
  FROM public.drivers d
  WHERE d.id IS DISTINCT FROM v_driver_a
  ORDER BY d.created_at NULLS LAST
  LIMIT 1;

  SELECT sp.user_id INTO v_finance_uid
  FROM public.staff_profiles sp
  WHERE sp.is_active
    AND sp.role IN ('super_admin', 'admin', 'finance_manager')
  LIMIT 1;

  -- anon / empty jwt: finance gate denies
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.assert_finance_payout_ledger_access();
    RAISE EXCEPTION 'FAIL: anon passed finance gate';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%not authorized%' THEN RAISE; END IF;
  END;

  -- random customer uid: deny finance + wallet other
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  BEGIN
    PERFORM public.assert_finance_payout_ledger_access();
    RAISE EXCEPTION 'FAIL: customer passed finance gate';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%not authorized%' THEN RAISE; END IF;
  END;

  IF v_driver_b IS NOT NULL THEN
    BEGIN
      PERFORM public.assert_driver_wallet_read_access(v_driver_b);
      RAISE EXCEPTION 'FAIL: random user read other wallet';
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM NOT ILIKE '%not authorized%' THEN RAISE; END IF;
    END;
  END IF;

  -- owning driver allowed for own wallet only
  IF v_user_a IS NOT NULL AND v_driver_a IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.sub', v_user_a::text, true);
    PERFORM public.assert_driver_wallet_read_access(v_driver_a);
    IF v_driver_b IS NOT NULL THEN
      BEGIN
        PERFORM public.assert_driver_wallet_read_access(v_driver_b);
        RAISE EXCEPTION 'FAIL: owner read cross-driver wallet';
      EXCEPTION WHEN insufficient_privilege THEN
        NULL;
      WHEN OTHERS THEN
        IF SQLERRM NOT ILIKE '%not authorized%' THEN RAISE; END IF;
      END;
    END IF;
  END IF;

  -- unauthorized staff role (operator) if present
  PERFORM set_config('request.jwt.claim.sub', COALESCE((
    SELECT sp.user_id::text FROM public.staff_profiles sp
    WHERE sp.is_active AND sp.role = 'operator' LIMIT 1
  ), '22222222-2222-2222-2222-222222222222'), true);
  BEGIN
    PERFORM public.assert_finance_payout_ledger_access();
    -- If no operator row, random uuid still denies — OK unless finance uid reused
    IF current_setting('request.jwt.claim.sub', true) = COALESCE(v_finance_uid::text, '') THEN
      NULL; -- skip
    ELSE
      RAISE EXCEPTION 'FAIL: unauthorized staff passed finance gate';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  WHEN OTHERS THEN
    IF SQLERRM NOT ILIKE '%not authorized%' THEN RAISE; END IF;
  END;

  -- authorized finance/admin
  IF v_finance_uid IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.sub', v_finance_uid::text, true);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM public.assert_finance_payout_ledger_access();
    IF v_driver_a IS NOT NULL THEN
      PERFORM public.assert_driver_wallet_read_access(v_driver_a);
    END IF;
  END IF;

  -- service_role claim
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM public.assert_finance_payout_ledger_access();
  IF v_driver_a IS NOT NULL THEN
    PERFORM public.assert_driver_wallet_read_access(v_driver_a);
  END IF;

  RAISE NOTICE 'phase3_batch1_authz_probes_ok';
END $$;
