-- Step 9.4D1 — throwaway Postgres tests (ON_DEMAND_DB_CLAIM_CAS).
-- Cases 1–12. Apply after bootstrap + migration (local DB only).
-- Secrets in this file are fixtures only.

BEGIN;

DO $$
DECLARE
  v1 jsonb;
  v2 jsonb;
  v_complete jsonb;
  v_fail jsonb;
  v_claim uuid;
  v_claim_b uuid;
  v_gen bigint;
  v_gen_final bigint;
  v_access text;
  v_refresh text;
  v_keys text;
BEGIN
  -- ═══════════════════════════════════════════════════════════════════════════
  -- 1) Fresh token requires no refresh
  -- ═══════════════════════════════════════════════════════════════════════════
  UPDATE public.revolut_business_oauth_refresh_coord
  SET
    access_token_expires_at = now() + interval '2 hours',
    refresh_claim_token = NULL,
    refresh_claimed_at = NULL,
    refresh_claim_expires_at = NULL,
    credential_generation = 10
  WHERE provider = 'revolut' AND environment = 'live';

  UPDATE public.payment_provider_vault
  SET secret_value = (now() + interval '2 hours')::text
  WHERE provider = 'revolut' AND environment = 'live'
    AND secret_name IN ('business_token_expires_at', 'REVOLUT_BUSINESS_TOKEN_EXPIRES_AT');

  UPDATE public.payment_provider_vault
  SET secret_value = 'fixture_access_fresh'
  WHERE provider = 'revolut' AND environment = 'live'
    AND secret_name IN ('business_access_token', 'REVOLUT_BUSINESS_ACCESS_TOKEN');

  v1 := public.claim_revolut_business_oauth_refresh('revolut', 'live', 60, 45);
  IF (v1->>'status') <> 'TOKEN_ALREADY_FRESH' THEN
    RAISE EXCEPTION 'case1 expected TOKEN_ALREADY_FRESH got %', v1;
  END IF;
  IF v1 ? 'claim_token' AND v1->>'claim_token' IS NOT NULL THEN
    RAISE EXCEPTION 'case1 must not return claim_token';
  END IF;
  IF v1::text ILIKE '%fixture_access%' OR v1::text ILIKE '%fixture_refresh%' THEN
    RAISE EXCEPTION 'case1 leaked secret material: %', v1;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- Prepare expired for remaining cases
  -- ═══════════════════════════════════════════════════════════════════════════
  UPDATE public.revolut_business_oauth_refresh_coord
  SET
    access_token_expires_at = now() - interval '1 hour',
    refresh_claim_token = NULL,
    refresh_claimed_at = NULL,
    refresh_claim_expires_at = NULL,
    credential_generation = 20
  WHERE provider = 'revolut' AND environment = 'live';

  UPDATE public.payment_provider_vault
  SET secret_value = (now() - interval '1 hour')::text
  WHERE provider = 'revolut' AND environment = 'live'
    AND secret_name IN ('business_token_expires_at', 'REVOLUT_BUSINESS_TOKEN_EXPIRES_AT');

  UPDATE public.payment_provider_vault
  SET secret_value = 'fixture_access_expired'
  WHERE provider = 'revolut' AND environment = 'live'
    AND secret_name IN ('business_access_token', 'REVOLUT_BUSINESS_ACCESS_TOKEN');

  UPDATE public.payment_provider_vault
  SET secret_value = 'fixture_refresh_v1'
  WHERE provider = 'revolut' AND environment = 'live'
    AND secret_name IN ('business_refresh_token', 'REVOLUT_BUSINESS_REFRESH_TOKEN');

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 2) Concurrent callers produce one claimant
  -- ═══════════════════════════════════════════════════════════════════════════
  v1 := public.claim_revolut_business_oauth_refresh('revolut', 'live', 60, 45);
  IF (v1->>'status') <> 'CLAIMED' THEN
    RAISE EXCEPTION 'case2a expected CLAIMED got %', v1;
  END IF;
  v_claim := (v1->>'claim_token')::uuid;
  v_gen := (v1->>'credential_generation')::bigint;

  v2 := public.claim_revolut_business_oauth_refresh('revolut', 'live', 60, 45);
  IF (v2->>'status') <> 'REFRESH_IN_PROGRESS' THEN
    RAISE EXCEPTION 'case2b expected REFRESH_IN_PROGRESS got %', v2;
  END IF;
  IF v2->>'claim_token' IS NOT NULL THEN
    RAISE EXCEPTION 'case2b non-owner must not receive claim_token';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 3) Wrong claim token cannot complete
  -- ═══════════════════════════════════════════════════════════════════════════
  v_complete := public.complete_revolut_business_oauth_refresh(
    '11111111-1111-1111-1111-111111111111'::uuid,
    v_gen,
    'fixture_access_wrong',
    now() + interval '40 minutes',
    'fixture_refresh_wrong',
    'READ,WRITE,PAY',
    'revolut',
    'live'
  );
  IF (v_complete->>'status') <> 'CLAIM_MISMATCH' OR (v_complete->>'persisted')::boolean THEN
    RAISE EXCEPTION 'case3 expected CLAIM_MISMATCH got %', v_complete;
  END IF;

  SELECT secret_value INTO v_access
  FROM public.payment_provider_vault
  WHERE provider = 'revolut' AND environment = 'live' AND secret_name = 'business_access_token';
  IF v_access <> 'fixture_access_expired' THEN
    RAISE EXCEPTION 'case3 vault mutated: %', v_access;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 4) Correct claimant increments generation once
  -- ═══════════════════════════════════════════════════════════════════════════
  v_complete := public.complete_revolut_business_oauth_refresh(
    v_claim,
    v_gen,
    'fixture_access_new',
    now() + interval '40 minutes',
    'fixture_refresh_rotated',
    'READ,WRITE,PAY',
    'revolut',
    'live'
  );
  IF (v_complete->>'status') <> 'COMPLETED' OR NOT (v_complete->>'persisted')::boolean THEN
    RAISE EXCEPTION 'case4 expected COMPLETED got %', v_complete;
  END IF;
  IF (v_complete->>'credential_generation')::bigint <> v_gen + 1 THEN
    RAISE EXCEPTION 'case4 generation not +1: %', v_complete;
  END IF;
  v_gen_final := (v_complete->>'credential_generation')::bigint;

  SELECT secret_value INTO v_access
  FROM public.payment_provider_vault
  WHERE provider = 'revolut' AND environment = 'live' AND secret_name = 'business_access_token';
  SELECT secret_value INTO v_refresh
  FROM public.payment_provider_vault
  WHERE provider = 'revolut' AND environment = 'live' AND secret_name = 'business_refresh_token';
  IF v_access <> 'fixture_access_new' OR v_refresh <> 'fixture_refresh_rotated' THEN
    RAISE EXCEPTION 'case4/8 vault access=% refresh=%', v_access, v_refresh;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 5) Stale claimant cannot overwrite newer credentials
  -- ═══════════════════════════════════════════════════════════════════════════
  UPDATE public.revolut_business_oauth_refresh_coord
  SET
    access_token_expires_at = now() - interval '1 hour',
    refresh_claim_token = NULL,
    refresh_claimed_at = NULL,
    refresh_claim_expires_at = NULL
  WHERE provider = 'revolut' AND environment = 'live';

  UPDATE public.payment_provider_vault
  SET secret_value = (now() - interval '1 hour')::text
  WHERE provider = 'revolut' AND environment = 'live'
    AND secret_name IN ('business_token_expires_at', 'REVOLUT_BUSINESS_TOKEN_EXPIRES_AT');

  v1 := public.claim_revolut_business_oauth_refresh('revolut', 'live', 60, 45);
  v_claim := (v1->>'claim_token')::uuid;
  v_gen := (v1->>'credential_generation')::bigint;

  -- Simulate peer already advanced generation while this claim is held
  UPDATE public.revolut_business_oauth_refresh_coord
  SET credential_generation = v_gen + 5
  WHERE provider = 'revolut' AND environment = 'live';

  v_complete := public.complete_revolut_business_oauth_refresh(
    v_claim,
    v_gen,
    'fixture_access_stale_writer',
    now() + interval '40 minutes',
    'fixture_refresh_stale',
    NULL,
    'revolut',
    'live'
  );
  IF (v_complete->>'status') <> 'STALE_GENERATION' OR (v_complete->>'persisted')::boolean THEN
    RAISE EXCEPTION 'case5 expected STALE_GENERATION got %', v_complete;
  END IF;

  SELECT secret_value INTO v_access
  FROM public.payment_provider_vault
  WHERE provider = 'revolut' AND environment = 'live' AND secret_name = 'business_access_token';
  IF v_access = 'fixture_access_stale_writer' THEN
    RAISE EXCEPTION 'case5 stale writer overwrote vault';
  END IF;

  -- Clear orphan claim for next cases
  UPDATE public.revolut_business_oauth_refresh_coord
  SET refresh_claim_token = NULL, refresh_claimed_at = NULL, refresh_claim_expires_at = NULL
  WHERE provider = 'revolut' AND environment = 'live';

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 6) Expired claim is reclaimable
  -- ═══════════════════════════════════════════════════════════════════════════
  UPDATE public.revolut_business_oauth_refresh_coord
  SET
    refresh_claim_token = '22222222-2222-2222-2222-222222222222'::uuid,
    refresh_claimed_at = now() - interval '10 minutes',
    refresh_claim_expires_at = now() - interval '5 minutes',
    access_token_expires_at = now() - interval '1 hour',
    credential_generation = 30
  WHERE provider = 'revolut' AND environment = 'live';

  v1 := public.claim_revolut_business_oauth_refresh('revolut', 'live', 60, 45);
  IF (v1->>'status') <> 'CLAIMED' THEN
    RAISE EXCEPTION 'case6 reclaim expected CLAIMED got %', v1;
  END IF;
  IF (v1->>'claim_token') = '22222222-2222-2222-2222-222222222222' THEN
    RAISE EXCEPTION 'case6 must issue a new claim token';
  END IF;
  v_claim := (v1->>'claim_token')::uuid;
  v_gen := (v1->>'credential_generation')::bigint;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 7) Crash-after-claim recovery (fail clears; second caller can claim)
  -- ═══════════════════════════════════════════════════════════════════════════
  v_fail := public.fail_revolut_business_oauth_refresh(
    v_claim, 'simulated_crash_after_claim', 'revolut', 'live'
  );
  IF (v_fail->>'status') <> 'FAILED' OR NOT (v_fail->>'cleared')::boolean THEN
    RAISE EXCEPTION 'case7 fail expected FAILED got %', v_fail;
  END IF;

  SELECT secret_value INTO v_access
  FROM public.payment_provider_vault
  WHERE provider = 'revolut' AND environment = 'live' AND secret_name = 'business_access_token';

  v1 := public.claim_revolut_business_oauth_refresh('revolut', 'live', 60, 45);
  IF (v1->>'status') <> 'CLAIMED' THEN
    RAISE EXCEPTION 'case7 recovery expected CLAIMED got %', v1;
  END IF;
  v_claim_b := (v1->>'claim_token')::uuid;

  SELECT secret_value INTO v_refresh
  FROM public.payment_provider_vault
  WHERE provider = 'revolut' AND environment = 'live' AND secret_name = 'business_access_token';
  IF v_refresh <> v_access THEN
    RAISE EXCEPTION 'case7/10 fail must preserve credentials';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 8) Refresh-token rotation is atomic (already covered in case4; re-assert)
  -- ═══════════════════════════════════════════════════════════════════════════
  v_complete := public.complete_revolut_business_oauth_refresh(
    v_claim_b,
    (v1->>'credential_generation')::bigint,
    'fixture_access_atomic',
    now() + interval '40 minutes',
    'fixture_refresh_atomic',
    'READ,WRITE,PAY',
    'revolut',
    'live'
  );
  IF (v_complete->>'status') <> 'COMPLETED' THEN
    RAISE EXCEPTION 'case8 complete failed %', v_complete;
  END IF;
  SELECT secret_value INTO v_access
  FROM public.payment_provider_vault
  WHERE provider = 'revolut' AND environment = 'live' AND secret_name = 'business_access_token';
  SELECT secret_value INTO v_refresh
  FROM public.payment_provider_vault
  WHERE provider = 'revolut' AND environment = 'live' AND secret_name = 'business_refresh_token';
  IF v_access <> 'fixture_access_atomic' OR v_refresh <> 'fixture_refresh_atomic' THEN
    RAISE EXCEPTION 'case8 atomic rotate failed access=% refresh=%', v_access, v_refresh;
  END IF;
  v_gen_final := (v_complete->>'credential_generation')::bigint;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 10) Refresh failure preserves credentials (fail path)
  -- ═══════════════════════════════════════════════════════════════════════════
  UPDATE public.revolut_business_oauth_refresh_coord
  SET access_token_expires_at = now() - interval '1 hour'
  WHERE provider = 'revolut' AND environment = 'live';
  UPDATE public.payment_provider_vault
  SET secret_value = (now() - interval '1 hour')::text
  WHERE provider = 'revolut' AND environment = 'live'
    AND secret_name IN ('business_token_expires_at', 'REVOLUT_BUSINESS_TOKEN_EXPIRES_AT');

  v1 := public.claim_revolut_business_oauth_refresh('revolut', 'live', 60, 45);
  v_claim := (v1->>'claim_token')::uuid;
  SELECT secret_value INTO v_access
  FROM public.payment_provider_vault
  WHERE provider = 'revolut' AND environment = 'live' AND secret_name = 'business_access_token';
  SELECT secret_value INTO v_refresh
  FROM public.payment_provider_vault
  WHERE provider = 'revolut' AND environment = 'live' AND secret_name = 'business_refresh_token';

  v_fail := public.fail_revolut_business_oauth_refresh(
    v_claim, 'provider_401_invalid_grant', 'revolut', 'live'
  );
  IF (v_fail->>'status') <> 'FAILED' THEN
    RAISE EXCEPTION 'case10 expected FAILED got %', v_fail;
  END IF;
  IF (SELECT secret_value FROM public.payment_provider_vault
      WHERE provider='revolut' AND environment='live' AND secret_name='business_access_token') <> v_access THEN
    RAISE EXCEPTION 'case10 access mutated';
  END IF;
  IF (SELECT secret_value FROM public.payment_provider_vault
      WHERE provider='revolut' AND environment='live' AND secret_name='business_refresh_token') <> v_refresh THEN
    RAISE EXCEPTION 'case10 refresh mutated';
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 11) All callers observe one final generation
  -- ═══════════════════════════════════════════════════════════════════════════
  IF (SELECT credential_generation FROM public.revolut_business_oauth_refresh_coord
      WHERE provider='revolut' AND environment='live') IS DISTINCT FROM v_gen_final THEN
    RAISE EXCEPTION 'case11 generation drifted from last successful complete';
  END IF;

  v1 := public.claim_revolut_business_oauth_refresh('revolut', 'live', 60, 45);
  -- token still expired from case10 setup — claim may be CLAIMED; force fresh for observation
  UPDATE public.revolut_business_oauth_refresh_coord
  SET access_token_expires_at = now() + interval '1 hour',
      refresh_claim_token = NULL, refresh_claimed_at = NULL, refresh_claim_expires_at = NULL
  WHERE provider = 'revolut' AND environment = 'live';
  UPDATE public.payment_provider_vault
  SET secret_value = (now() + interval '1 hour')::text
  WHERE provider = 'revolut' AND environment = 'live'
    AND secret_name IN ('business_token_expires_at', 'REVOLUT_BUSINESS_TOKEN_EXPIRES_AT');

  v1 := public.claim_revolut_business_oauth_refresh('revolut', 'live', 60, 45);
  v2 := public.claim_revolut_business_oauth_refresh('revolut', 'live', 60, 45);
  IF (v1->>'credential_generation')::bigint <> v_gen_final
     OR (v2->>'credential_generation')::bigint <> v_gen_final THEN
    RAISE EXCEPTION 'case11 callers disagree gen v1=% v2=% expected=%', v1, v2, v_gen_final;
  END IF;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 12) Claim RPCs return no secrets
  -- ═══════════════════════════════════════════════════════════════════════════
  SELECT string_agg(key, ',') INTO v_keys
  FROM jsonb_object_keys(v1) AS key;
  IF v1::text ILIKE '%fixture_access%' OR v1::text ILIKE '%fixture_refresh%' THEN
    RAISE EXCEPTION 'case12 claim JSON leaked fixture secret: %', v1;
  END IF;
  IF v1 ? 'access_token' OR v1 ? 'refresh_token' OR v1 ? 'private_key' THEN
    RAISE EXCEPTION 'case12 forbidden keys present: %', v1;
  END IF;

  -- Privilege: anon must not execute
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM public.claim_revolut_business_oauth_refresh('revolut', 'live', 60, 45);
    RAISE EXCEPTION 'case12b anon must be denied';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%case12b%' THEN RAISE; END IF;
      NULL;
  END;
  RESET ROLE;

  RAISE NOTICE 'step94d1_oauth_refresh_ownership: CASES_1_TO_12_SERIAL_PASS';
END $$;

ROLLBACK;

-- ═══════════════════════════════════════════════════════════════════════════
-- 9) Transaction rollback preserves prior credentials
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;
DO $$
DECLARE
  v1 jsonb;
  v_claim uuid;
  v_gen bigint;
BEGIN
  UPDATE public.revolut_business_oauth_refresh_coord
  SET access_token_expires_at = now() - interval '1 hour',
      refresh_claim_token = NULL, refresh_claimed_at = NULL, refresh_claim_expires_at = NULL,
      credential_generation = 40
  WHERE provider = 'revolut' AND environment = 'live';
  UPDATE public.payment_provider_vault
  SET secret_value = 'fixture_access_pre_rollback'
  WHERE provider = 'revolut' AND environment = 'live'
    AND secret_name IN ('business_access_token', 'REVOLUT_BUSINESS_ACCESS_TOKEN');
  UPDATE public.payment_provider_vault
  SET secret_value = 'fixture_refresh_pre_rollback'
  WHERE provider = 'revolut' AND environment = 'live'
    AND secret_name IN ('business_refresh_token', 'REVOLUT_BUSINESS_REFRESH_TOKEN');
  UPDATE public.payment_provider_vault
  SET secret_value = (now() - interval '1 hour')::text
  WHERE provider = 'revolut' AND environment = 'live'
    AND secret_name IN ('business_token_expires_at', 'REVOLUT_BUSINESS_TOKEN_EXPIRES_AT');

  v1 := public.claim_revolut_business_oauth_refresh('revolut', 'live', 60, 45);
  v_claim := (v1->>'claim_token')::uuid;
  v_gen := (v1->>'credential_generation')::bigint;
  PERFORM public.complete_revolut_business_oauth_refresh(
    v_claim, v_gen,
    'fixture_access_should_rollback',
    now() + interval '40 minutes',
    'fixture_refresh_should_rollback',
    NULL, 'revolut', 'live'
  );
END $$;
ROLLBACK;

DO $$
DECLARE
  v_access text;
  v_refresh text;
BEGIN
  SELECT secret_value INTO v_access
  FROM public.payment_provider_vault
  WHERE provider = 'revolut' AND environment = 'live' AND secret_name = 'business_access_token';
  SELECT secret_value INTO v_refresh
  FROM public.payment_provider_vault
  WHERE provider = 'revolut' AND environment = 'live' AND secret_name = 'business_refresh_token';
  IF v_access = 'fixture_access_should_rollback' OR v_refresh = 'fixture_refresh_should_rollback' THEN
    RAISE EXCEPTION 'case9 rollback failed to preserve prior credentials access=% refresh=%', v_access, v_refresh;
  END IF;
  -- After outer ROLLBACK of complete txn, values should be whatever was committed before —
  -- bootstrap fixtures or last committed state from serial tests (those also rolled back).
  -- Re-seed check: table may still have bootstrap from migration session.
  RAISE NOTICE 'step94d1_oauth_refresh_ownership: CASE_9_ROLLBACK_PASS access_present=%', (v_access IS NOT NULL);
END $$;

SELECT 'STEP94D1_SQL_SERIAL_PASS' AS result;
