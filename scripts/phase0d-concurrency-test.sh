#!/usr/bin/env bash
# Phase 0d — concurrent finalize_driver_payout_completion (two sessions, one debit).
set -euo pipefail
DB_URL="${1:-postgresql://admin@localhost:5432/onecab_phase0d_test}"

psql "$DB_URL" -v ON_ERROR_STOP=1 -c "
CREATE TABLE IF NOT EXISTS phase0d_conc_fixture (item_id uuid, pay_id text);
TRUNCATE phase0d_conc_fixture;
"

psql "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  v_driver uuid := gen_random_uuid();
  v_trip uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid();
  v_item uuid := gen_random_uuid();
  v_earn uuid := gen_random_uuid();
BEGIN
  INSERT INTO drivers (id, email) VALUES (v_driver, 'conc@test.local');
  INSERT INTO trips (id, driver_id, financial_model) VALUES (v_trip, v_driver, 'PLATFORM_COLLECTED');
  INSERT INTO driver_wallet_ledger (id, driver_id, related_trip_id, type, amount_pence)
    VALUES (v_earn, v_driver, v_trip, 'TRIP_EARNING_NET', 800);
  INSERT INTO payout_batches (id, kind, run_date, status) VALUES (v_batch, 'WEEKLY_MONDAY', CURRENT_DATE, 'ITEMS_CREATED');
  INSERT INTO payout_items (id, batch_id, driver_id, amount_pence, status, execution_status)
    VALUES (v_item, v_batch, v_driver, 800, 'VALIDATED', 'VALIDATED');
  INSERT INTO payout_item_ledger_allocations (payout_item_id, ledger_entry_id, amount_pence) VALUES (v_item, v_earn, 800);
  INSERT INTO driver_payout_reservations (
    payout_item_id, payout_batch_id, driver_id, wallet_account_id, amount_pence, status,
    idempotency_key, reservation_fingerprint
  ) VALUES (v_item, v_batch, v_driver, gen_random_uuid(), 800, 'ACTIVE', 'conc', 'conc');
  INSERT INTO driver_payout_payment_intents (
    payout_item_id, driver_id, amount_pence, execution_status, provider_payment_id
  ) VALUES (v_item, v_driver, 800, 'SUBMITTED', 'pay_conc_001');
  UPDATE payout_items SET status = 'SUBMITTED', execution_status = 'SUBMITTED' WHERE id = v_item;
  INSERT INTO phase0d_conc_fixture VALUES (v_item, 'pay_conc_001');
END $$;
SQL

ITEM=$(psql "$DB_URL" -Atc "SELECT item_id FROM phase0d_conc_fixture LIMIT 1")

run_rpc() {
  psql "$DB_URL" -Atc "SELECT (finalize_driver_payout_completion('$ITEM'::uuid, 'pay_conc_001', 'completed', now(), '{}'::jsonb)->>'ok')"
}

run_rpc & pid1=$!
run_rpc & pid2=$!
wait "$pid1" || true
wait "$pid2" || true

DEBITS=$(psql "$DB_URL" -Atc "SELECT count(*) FROM driver_wallet_ledger WHERE provider_payout_id='pay_conc_001' AND amount_pence<0")
if [[ "$DEBITS" != "1" ]]; then
  echo "CONCURRENCY FAIL: debits=$DEBITS"
  exit 1
fi
echo "CONCURRENCY PASS: exactly one debit"
