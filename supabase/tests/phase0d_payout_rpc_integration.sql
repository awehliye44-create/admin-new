-- Phase 0d — direct finalize_driver_payout_completion integration tests.
-- Runs on isolated local DB; each scenario rolled back unless noted.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION phase0d_mark_submitted(p_item uuid)
RETURNS void LANGUAGE sql AS $$
  UPDATE payout_items SET status = 'SUBMITTED', execution_status = 'SUBMITTED' WHERE id = p_item;
$$;

DO $$ BEGIN RAISE NOTICE '=== assert_payout_item_ledger_lineage valid BEFORE completion debit ==='; END $$;

DO $$
DECLARE
  v_driver uuid := gen_random_uuid();
  v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_earn uuid := gen_random_uuid();
  v_res uuid := gen_random_uuid();
  v_intent uuid := gen_random_uuid();
BEGIN
  INSERT INTO drivers (id, first_name, email) VALUES (v_driver, 'Test', 't@test.local');
  INSERT INTO trips (id, driver_id, financial_model, status) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED', 'completed');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 376);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status, currency)
    VALUES (v_item, v_batch, v_driver, 376, 'VALIDATED', 'VALIDATED', 'GBP');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence)
    VALUES (v_item, v_earn, 376);
  INSERT INTO driver_payout_reservations (
    id, payout_item_id, payout_batch_id, driver_id, wallet_account_id,
    amount_pence, status, idempotency_key, reservation_fingerprint
  ) VALUES (
    v_res, v_item, v_batch, v_driver, gen_random_uuid(), 376, 'ACTIVE',
    'idem:' || v_item::text, 'fp:' || v_item::text
  );
  INSERT INTO driver_payout_payment_intents (
    id, payout_item_id, driver_id, amount_pence, execution_status, provider_payment_id, provider_state
  ) VALUES (
    v_intent, v_item, v_driver, 376, 'SUBMITTED', 'pay_lineage_pre', 'submitted'
  );
  PERFORM assert_payout_item_ledger_lineage(v_item);
  IF EXISTS (SELECT 1 FROM driver_wallet_ledger WHERE type IN ('WEEKLY_PAYOUT','PAYOUT') AND amount_pence < 0) THEN
    RAISE EXCEPTION 'lineage pre-check must not create completion debit';
  END IF;
  RAISE NOTICE 'lineage pre-completion PASS';
  RAISE EXCEPTION 'ROLLBACK_SCENARIO';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK_SCENARIO' THEN RAISE; END IF;
END $$;

-- 1. Valid completion
DO $$
DECLARE
  v_driver uuid := gen_random_uuid();
  v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_earn uuid := gen_random_uuid();
  v_res uuid;
  v_result jsonb;
  v_debit_count integer;
BEGIN
  INSERT INTO drivers (id, first_name, email) VALUES (v_driver, 'Valid', 'v@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 500);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item, v_batch, v_driver, 500, 'VALIDATED', 'VALIDATED');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence)
    VALUES (v_item, v_earn, 500);
  INSERT INTO driver_payout_reservations (
    payout_item_id, payout_batch_id, driver_id, wallet_account_id, amount_pence, status,
    idempotency_key, reservation_fingerprint
  ) VALUES (
    v_item, v_batch, v_driver, gen_random_uuid(), 500, 'ACTIVE',
    'idem-valid:' || v_item::text, 'fp-valid:' || v_item::text
  ) RETURNING id INTO v_res;
  INSERT INTO driver_payout_payment_intents (
    payout_item_id, driver_id, amount_pence, execution_status, provider_payment_id, provider_state
  ) VALUES (v_item, v_driver, 500, 'SUBMITTED', 'pay_valid_001', 'submitted');

  PERFORM phase0d_mark_submitted(v_item);
  v_result := finalize_driver_payout_completion(v_item, 'pay_valid_001', 'completed', now(), '{}'::jsonb);
  IF (v_result->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'valid completion failed: %', v_result;
  END IF;

  SELECT count(*) INTO v_debit_count FROM driver_wallet_ledger
  WHERE driver_id = v_driver AND amount_pence = -500 AND provider_payout_id = 'pay_valid_001';
  IF v_debit_count <> 1 THEN RAISE EXCEPTION 'expected one debit, got %', v_debit_count; END IF;

  IF NOT EXISTS (SELECT 1 FROM driver_payout_reservations WHERE payout_item_id = v_item AND status = 'CONSUMED') THEN
    RAISE EXCEPTION 'reservation not consumed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM payout_items WHERE id = v_item AND upper(status) = 'COMPLETED') THEN
    RAISE EXCEPTION 'payout item not completed';
  END IF;

  RAISE NOTICE 'valid completion PASS';
  RAISE EXCEPTION 'ROLLBACK_SCENARIO';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK_SCENARIO' THEN RAISE; END IF;
END $$;

-- 2. Idempotent replay
DO $$
DECLARE
  v_driver uuid := gen_random_uuid();
  v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_earn uuid := gen_random_uuid();
  v_r1 jsonb;
  v_r2 jsonb;
  v_debits integer;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'i@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'DRIVER_COMPENSATION_CREDIT', 376);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item, v_batch, v_driver, 376, 'VALIDATED', 'VALIDATED');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence)
    VALUES (v_item, v_earn, 376);
  INSERT INTO driver_payout_reservations (
    payout_item_id, payout_batch_id, driver_id, wallet_account_id, amount_pence, status,
    idempotency_key, reservation_fingerprint
  ) VALUES (v_item, v_batch, v_driver, gen_random_uuid(), 376, 'ACTIVE', 'i1', 'f1');
  INSERT INTO driver_payout_payment_intents (
    payout_item_id, driver_id, amount_pence, execution_status, provider_payment_id
  ) VALUES (v_item, v_driver, 376, 'SUBMITTED', 'pay_idem_001');

  PERFORM phase0d_mark_submitted(v_item);
  v_r1 := finalize_driver_payout_completion(v_item, 'pay_idem_001', 'completed', now(), '{}'::jsonb);
  v_r2 := finalize_driver_payout_completion(v_item, 'pay_idem_001', 'completed', now(), '{}'::jsonb);

  IF (v_r2->>'already_applied')::boolean IS NOT TRUE AND (v_r2->>'idempotent')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'replay not idempotent: %', v_r2;
  END IF;

  SELECT count(*) INTO v_debits FROM driver_wallet_ledger WHERE provider_payout_id = 'pay_idem_001' AND amount_pence < 0;
  IF v_debits <> 1 THEN RAISE EXCEPTION 'duplicate debit on replay: %', v_debits; END IF;

  RAISE NOTICE 'idempotent replay PASS';
  RAISE EXCEPTION 'ROLLBACK_SCENARIO';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM <> 'ROLLBACK_SCENARIO' THEN RAISE; END IF;
END $$;

BEGIN;
DO $$
DECLARE v_driver uuid := gen_random_uuid(); v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid(); v_item uuid := gen_random_uuid(); v_earn uuid := gen_random_uuid();
  v_result jsonb;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'mr@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 100);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item, v_batch, v_driver, 100, 'VALIDATED', 'VALIDATED');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item, v_earn, 100);
  INSERT INTO driver_payout_payment_intents (
    payout_item_id, driver_id, amount_pence, execution_status, provider_payment_id
  ) VALUES (v_item, v_driver, 100, 'SUBMITTED', 'pay_reject');
  PERFORM phase0d_mark_submitted(v_item);
  v_result := finalize_driver_payout_completion(v_item, 'pay_reject', 'completed', now(), '{}'::jsonb);
  IF v_result->>'error' <> 'RESERVATION_NOT_ACTIVE' THEN RAISE EXCEPTION 'missing reservation got %', v_result; END IF;
  RAISE NOTICE 'missing reservation rejection PASS';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE v_driver uuid := gen_random_uuid(); v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid(); v_item uuid := gen_random_uuid(); v_earn uuid := gen_random_uuid();
  v_result jsonb;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'mi@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 100);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item, v_batch, v_driver, 100, 'VALIDATED', 'VALIDATED');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item, v_earn, 100);
  PERFORM phase0d_mark_submitted(v_item);
  v_result := finalize_driver_payout_completion(v_item, 'pay_reject', 'completed', now(), '{}'::jsonb);
  IF v_result->>'error' <> 'PAYOUT_ITEM_NOT_SUBMITTED' THEN RAISE EXCEPTION 'missing intent got %', v_result; END IF;
  RAISE NOTICE 'missing intent rejection PASS';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE v_driver uuid := gen_random_uuid(); v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid(); v_item uuid := gen_random_uuid(); v_earn uuid := gen_random_uuid();
  v_result jsonb;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'pp@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 100);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item, v_batch, v_driver, 100, 'VALIDATED', 'VALIDATED');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item, v_earn, 100);
  INSERT INTO driver_payout_reservations (
    payout_item_id, payout_batch_id, driver_id, wallet_account_id, amount_pence, status,
    idempotency_key, reservation_fingerprint
  ) VALUES (v_item, v_batch, v_driver, gen_random_uuid(), 100, 'ACTIVE', 'pp', 'pp');
  INSERT INTO driver_payout_payment_intents (
    payout_item_id, driver_id, amount_pence, execution_status, provider_payment_id, provider_state
  ) VALUES (v_item, v_driver, 100, 'SUBMITTED', 'pay_reject', 'processing');
  PERFORM phase0d_mark_submitted(v_item);
  v_result := finalize_driver_payout_completion(v_item, 'pay_reject', 'completed', now(), '{}'::jsonb);
  IF v_result->>'error' <> 'PROVIDER_NOT_COMPLETED' THEN RAISE EXCEPTION 'provider pending got %', v_result; END IF;
  RAISE NOTICE 'provider pending rejection PASS';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE v_driver uuid := gen_random_uuid(); v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid(); v_item uuid := gen_random_uuid(); v_earn uuid := gen_random_uuid();
  v_result jsonb;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'pf@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 100);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item, v_batch, v_driver, 100, 'VALIDATED', 'VALIDATED');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item, v_earn, 100);
  INSERT INTO driver_payout_reservations (
    payout_item_id, payout_batch_id, driver_id, wallet_account_id, amount_pence, status,
    idempotency_key, reservation_fingerprint
  ) VALUES (v_item, v_batch, v_driver, gen_random_uuid(), 100, 'ACTIVE', 'pf', 'pf');
  INSERT INTO driver_payout_payment_intents (
    payout_item_id, driver_id, amount_pence, execution_status, provider_payment_id
  ) VALUES (v_item, v_driver, 100, 'SUBMITTED', 'pay_reject');
  PERFORM phase0d_mark_submitted(v_item);
  v_result := finalize_driver_payout_completion(v_item, 'pay_reject', 'failed', now(), '{}'::jsonb);
  IF v_result->>'error' <> 'PROVIDER_NOT_COMPLETED' THEN
    RAISE EXCEPTION 'provider failed expected PROVIDER_NOT_COMPLETED got %', v_result;
  END IF;
  RAISE NOTICE 'provider failed rejection PASS';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  v_driver uuid := gen_random_uuid(); v_wrong uuid := gen_random_uuid();
  v_trip uuid := gen_random_uuid(); v_batch uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid(); v_earn uuid := gen_random_uuid(); v_result jsonb;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'wd@test.local'), (v_wrong, 'x@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 100);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item, v_batch, v_driver, 100, 'VALIDATED', 'VALIDATED');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item, v_earn, 100);
  INSERT INTO driver_payout_reservations (
    payout_item_id, payout_batch_id, driver_id, wallet_account_id, amount_pence, status,
    idempotency_key, reservation_fingerprint
  ) VALUES (v_item, v_batch, v_wrong, gen_random_uuid(), 100, 'ACTIVE', 'wd', 'wd');
  INSERT INTO driver_payout_payment_intents (payout_item_id, driver_id, amount_pence, execution_status, provider_payment_id)
    VALUES (v_item, v_wrong, 100, 'SUBMITTED', 'pay_reject');
  PERFORM phase0d_mark_submitted(v_item);
  v_result := finalize_driver_payout_completion(v_item, 'pay_reject', 'completed', now(), '{}'::jsonb);
  IF v_result->>'error' <> 'DRIVER_MISMATCH' THEN RAISE EXCEPTION 'wrong driver got %', v_result; END IF;
  RAISE NOTICE 'wrong driver rejection PASS';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  v_driver uuid := gen_random_uuid(); v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid(); v_item uuid := gen_random_uuid(); v_earn uuid := gen_random_uuid();
  v_result jsonb;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'wa@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 100);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item, v_batch, v_driver, 100, 'VALIDATED', 'VALIDATED');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item, v_earn, 100);
  INSERT INTO driver_payout_reservations (
    payout_item_id, payout_batch_id, driver_id, wallet_account_id, amount_pence, status,
    idempotency_key, reservation_fingerprint
  ) VALUES (v_item, v_batch, v_driver, gen_random_uuid(), 200, 'ACTIVE', 'wa', 'wa');
  INSERT INTO driver_payout_payment_intents (payout_item_id, driver_id, amount_pence, execution_status, provider_payment_id)
    VALUES (v_item, v_driver, 100, 'SUBMITTED', 'pay_reject');
  PERFORM phase0d_mark_submitted(v_item);
  v_result := finalize_driver_payout_completion(v_item, 'pay_reject', 'completed', now(), '{}'::jsonb);
  IF v_result->>'error' <> 'AMOUNT_MISMATCH' THEN RAISE EXCEPTION 'wrong amount got %', v_result; END IF;
  RAISE NOTICE 'wrong amount rejection PASS';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  v_driver uuid := gen_random_uuid(); v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid(); v_item uuid := gen_random_uuid(); v_earn uuid := gen_random_uuid();
  v_result jsonb;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'asm@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 100);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item, v_batch, v_driver, 100, 'VALIDATED', 'VALIDATED');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item, v_earn, 50);
  INSERT INTO driver_payout_reservations (
    payout_item_id, payout_batch_id, driver_id, wallet_account_id, amount_pence, status,
    idempotency_key, reservation_fingerprint
  ) VALUES (v_item, v_batch, v_driver, gen_random_uuid(), 100, 'ACTIVE', 'asm', 'asm');
  INSERT INTO driver_payout_payment_intents (payout_item_id, driver_id, amount_pence, execution_status, provider_payment_id)
    VALUES (v_item, v_driver, 100, 'SUBMITTED', 'pay_reject');
  v_result := finalize_driver_payout_completion(v_item, 'pay_reject', 'completed', now(), '{}'::jsonb);
  IF v_result->>'error' NOT IN ('PAYOUT_LINEAGE_MISMATCH','PAYOUT_LINEAGE_VALIDATION_FAILED') THEN
    RAISE EXCEPTION 'alloc mismatch got %', v_result;
  END IF;
  RAISE NOTICE 'allocation sum mismatch rejection PASS';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  v_driver uuid := gen_random_uuid(); v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid(); v_item uuid := gen_random_uuid(); v_earn uuid := gen_random_uuid();
  v_result jsonb;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'dc@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'DRIVER_COLLECTED_COMMISSION_WALLET');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 100);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item, v_batch, v_driver, 100, 'VALIDATED', 'VALIDATED');
  BEGIN
    INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item, v_earn, 100);
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'DRIVER_COLLECTED allocation blocked at insert PASS';
    RETURN;
  END;
  RAISE EXCEPTION 'DRIVER_COLLECTED allocation should have been blocked';
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  v_driver uuid := gen_random_uuid(); v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid(); v_item uuid := gen_random_uuid(); v_earn uuid := gen_random_uuid();
  v_item2 uuid := gen_random_uuid(); v_batch2 uuid := gen_random_uuid();
  v_result jsonb;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'ca@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 100);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item, v_batch, v_driver, 100, 'VALIDATED', 'VALIDATED');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item, v_earn, 100);
  INSERT INTO driver_payout_reservations (
    payout_item_id, payout_batch_id, driver_id, wallet_account_id, amount_pence, status,
    idempotency_key, reservation_fingerprint
  ) VALUES (v_item, v_batch, v_driver, gen_random_uuid(), 100, 'ACTIVE', 'ca1', 'ca1');
  INSERT INTO driver_payout_payment_intents (payout_item_id, driver_id, amount_pence, execution_status, provider_payment_id)
    VALUES (v_item, v_driver, 100, 'SUBMITTED', 'pay_reject');
  PERFORM phase0d_mark_submitted(v_item);
  v_result := finalize_driver_payout_completion(v_item, 'pay_reject', 'completed', now(), '{}'::jsonb);
  IF (v_result->>'ok')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'first completion failed %', v_result; END IF;

  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch2, 'WEEKLY_MONDAY', CURRENT_DATE + 1, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item2, v_batch2, v_driver, 100, 'VALIDATED', 'VALIDATED');
  BEGIN
    INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item2, v_earn, 100);
    RAISE EXCEPTION 'consumed allocation reuse should fail';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'already-consumed allocation blocked PASS';
  END;
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE
  v_driver uuid := gen_random_uuid(); v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid(); v_item uuid := gen_random_uuid(); v_bad uuid := gen_random_uuid();
  v_result jsonb;
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'ut@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_bad, v_driver, v_trip, 'PLATFORM_COMMISSION', 100);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item, v_batch, v_driver, 100, 'VALIDATED', 'VALIDATED');
  BEGIN
    INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item, v_bad, 100);
    RAISE EXCEPTION 'unsupported type should not allocate';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'unsupported wallet type blocked PASS';
  END;
END $$;
ROLLBACK;

DO $$ BEGIN RAISE NOTICE 'payout RPC integration tests ALL PASS'; END $$;

DROP FUNCTION IF EXISTS phase0d_mark_submitted(uuid);
