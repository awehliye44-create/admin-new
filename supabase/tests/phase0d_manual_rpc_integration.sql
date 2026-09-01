-- Phase 0d — finalize_manual_external_payout_completion integration tests.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_driver uuid := gen_random_uuid();
  v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_earn uuid := gen_random_uuid();
  v_result jsonb;
  v_audit_count integer;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'manual@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 250);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'MANUAL_ADMIN', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status, currency)
    VALUES (v_item, v_batch, v_driver, 250, 'VALIDATED', 'VALIDATED', 'GBP');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence)
    VALUES (v_item, v_earn, 250);

  SET LOCAL ROLE service_role;
  v_result := finalize_manual_external_payout_completion(
    v_item, 'EXT-REF-MAN-001', v_driver, 250, now(), gen_random_uuid(),
    'verified bank transfer batch test', '{"path":"phase0d"}'::jsonb
  );
  RESET ROLE;

  IF (v_result->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'manual external completion failed: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM driver_wallet_ledger
    WHERE driver_id = v_driver AND amount_pence = -250 AND provider_payout_id = 'EXT-REF-MAN-001'
  ) THEN
    RAISE EXCEPTION 'manual debit missing';
  END IF;

  SELECT count(*) INTO v_audit_count FROM admin_payment_audit WHERE action = 'manual_external_payout_completion';
  IF v_audit_count <> 1 THEN RAISE EXCEPTION 'expected one audit row, got %', v_audit_count; END IF;

  RAISE NOTICE 'manual external valid completion PASS';
  RAISE EXCEPTION 'ROLLBACK_SCENARIO';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK_SCENARIO' THEN RAISE; END IF;
END $$;

-- Idempotent replay
DO $$
DECLARE
  v_driver uuid := gen_random_uuid(); v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid(); v_item uuid := gen_random_uuid(); v_earn uuid := gen_random_uuid();
  v_r1 jsonb; v_r2 jsonb; v_debits integer;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'm2@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 300);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'MANUAL_ADMIN', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, currency)
    VALUES (v_item, v_batch, v_driver, 300, 'VALIDATED', 'GBP');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item, v_earn, 300);

  SET LOCAL ROLE service_role;
  v_r1 := finalize_manual_external_payout_completion(
    v_item, 'EXT-IDEM-001', v_driver, 300, now(), gen_random_uuid(), 'first', '{}'::jsonb);
  v_r2 := finalize_manual_external_payout_completion(
    v_item, 'EXT-IDEM-001', v_driver, 300, now(), gen_random_uuid(), 'replay', '{}'::jsonb);
  RESET ROLE;

  IF (v_r2->>'already_applied')::boolean IS NOT TRUE AND (v_r2->>'idempotent')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'manual replay not idempotent: %', v_r2;
  END IF;
  SELECT count(*) INTO v_debits FROM driver_wallet_ledger WHERE provider_payout_id = 'EXT-IDEM-001' AND amount_pence < 0;
  IF v_debits <> 1 THEN RAISE EXCEPTION 'manual duplicate debit: %', v_debits; END IF;
  IF (SELECT count(*) FROM admin_payment_audit WHERE provider_payment_id = 'EXT-IDEM-001') <> 1 THEN
    RAISE EXCEPTION 'manual replay duplicated audit';
  END IF;
  RAISE NOTICE 'manual idempotent replay PASS';
  RAISE EXCEPTION 'ROLLBACK_SCENARIO';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK_SCENARIO' THEN RAISE; END IF;
END $$;

-- Rejection matrix
DO $$
DECLARE
  v_driver uuid := gen_random_uuid(); v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid(); v_item uuid := gen_random_uuid(); v_earn uuid := gen_random_uuid();
  v_result jsonb;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'rej@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 100);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'MANUAL_ADMIN', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, currency)
    VALUES (v_item, v_batch, v_driver, 100, 'VALIDATED', 'GBP');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item, v_earn, 100);

  SET LOCAL ROLE service_role;
  v_result := finalize_manual_external_payout_completion(
    v_item, 'EXT-001', v_driver, 100, now(), gen_random_uuid(), '', '{}'::jsonb);
  IF v_result->>'error' <> 'MISSING_OPERATOR_REASON' THEN RAISE EXCEPTION 'missing reason got %', v_result; END IF;

  v_result := finalize_manual_external_payout_completion(
    v_item, 'EXT-001', v_driver, 100, NULL, gen_random_uuid(), 'ok reason', '{}'::jsonb);
  IF v_result->>'error' <> 'MISSING_COMPLETION_TIMESTAMP' THEN RAISE EXCEPTION 'missing ts got %', v_result; END IF;

  v_result := finalize_manual_external_payout_completion(
    v_item, '', v_driver, 100, now(), gen_random_uuid(), 'ok reason', '{}'::jsonb);
  IF v_result->>'error' <> 'MISSING_EXTERNAL_REFERENCE' THEN RAISE EXCEPTION 'missing ref got %', v_result; END IF;

  v_result := finalize_manual_external_payout_completion(
    v_item, 'EXT-001', v_driver, 50, now(), gen_random_uuid(), 'ok reason', '{}'::jsonb);
  IF v_result->>'error' <> 'AMOUNT_MISMATCH' THEN RAISE EXCEPTION 'wrong amount got %', v_result; END IF;

  UPDATE payout_items SET currency = 'USD' WHERE id = v_item;
  v_result := finalize_manual_external_payout_completion(
    v_item, 'EXT-001', v_driver, 100, now(), gen_random_uuid(), 'ok reason', '{}'::jsonb);
  IF v_result->>'error' <> 'CURRENCY_MISMATCH' THEN RAISE EXCEPTION 'currency got %', v_result; END IF;
  RESET ROLE;

  RAISE NOTICE 'manual rejection matrix PASS';
  RAISE EXCEPTION 'ROLLBACK_SCENARIO';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK_SCENARIO' THEN RAISE; END IF;
END $$;

-- Cross-driver reference reuse
DO $$
DECLARE
  v_d1 uuid := gen_random_uuid(); v_d2 uuid := gen_random_uuid();
  v_trip1 uuid := gen_random_uuid(); v_trip2 uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid();
  v_item1 uuid := gen_random_uuid(); v_item2 uuid := gen_random_uuid();
  v_earn1 uuid := gen_random_uuid(); v_earn2 uuid := gen_random_uuid(); v_result jsonb;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_d1, 'd1@test.local'), (v_d2, 'd2@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES
    (v_trip1, v_d1, 'PLATFORM_COLLECTED'),
    (v_trip2, v_d2, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn1, v_d1, v_trip1, 'TRIP_EARNING_NET', 100),
           (v_earn2, v_d2, v_trip2, 'TRIP_EARNING_NET', 100);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'MANUAL_ADMIN', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, currency)
    VALUES (v_item1, v_batch, v_d1, 100, 'failed', 'GBP');
  UPDATE payout_items SET provider_reference = 'SHARED-REF' WHERE id = v_item1;
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, currency)
    VALUES (v_item2, v_batch, v_d2, 100, 'VALIDATED', 'GBP');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence)
    VALUES (v_item2, v_earn2, 100);

  SET LOCAL ROLE service_role;
  v_result := finalize_manual_external_payout_completion(
    v_item2, 'SHARED-REF', v_d2, 100, now(), gen_random_uuid(), 'cross driver attempt', '{}'::jsonb);
  RESET ROLE;
  IF v_result->>'error' NOT IN ('CROSS_DRIVER_REFERENCE_REUSE','DUPLICATE_EXTERNAL_REFERENCE') THEN
    RAISE EXCEPTION 'cross driver reuse got %', v_result;
  END IF;
  RAISE NOTICE 'cross-driver reference reuse blocked PASS';
  RAISE EXCEPTION 'ROLLBACK_SCENARIO';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK_SCENARIO' THEN RAISE; END IF;
END $$;

-- Grant security checks
DO $$
DECLARE
  v_public boolean; v_anon boolean; v_auth boolean; v_service boolean;
BEGIN
  SELECT has_function_privilege('public', 'public.finalize_manual_external_payout_completion(uuid,text,uuid,integer,timestamptz,uuid,text,jsonb)', 'EXECUTE') INTO v_public;
  SELECT has_function_privilege('anon', 'public.finalize_manual_external_payout_completion(uuid,text,uuid,integer,timestamptz,uuid,text,jsonb)', 'EXECUTE') INTO v_anon;
  SELECT has_function_privilege('authenticated', 'public.finalize_manual_external_payout_completion(uuid,text,uuid,integer,timestamptz,uuid,text,jsonb)', 'EXECUTE') INTO v_auth;
  SELECT has_function_privilege('service_role', 'public.finalize_manual_external_payout_completion(uuid,text,uuid,integer,timestamptz,uuid,text,jsonb)', 'EXECUTE') INTO v_service;

  IF v_public THEN RAISE EXCEPTION 'PUBLIC can execute manual RPC'; END IF;
  IF v_anon THEN RAISE EXCEPTION 'anon can execute manual RPC'; END IF;
  IF v_auth THEN RAISE EXCEPTION 'authenticated can execute manual RPC'; END IF;
  IF NOT v_service THEN RAISE EXCEPTION 'service_role cannot execute manual RPC'; END IF;
  RAISE NOTICE 'manual RPC grant security PASS';
END $$;

DO $$ BEGIN RAISE NOTICE 'manual RPC integration tests ALL PASS'; END $$;
