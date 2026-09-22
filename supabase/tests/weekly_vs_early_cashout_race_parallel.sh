#!/usr/bin/env bash
# Concurrent WEEKLY vs EARLY allocation against weekly_early_race_sim.
# Prerequisite: serial SQL has created the schema.
set -euo pipefail
export PATH=/usr/bin:/bin:/opt/homebrew/bin:$PATH
PSQL=(psql -h 127.0.0.1 -p 5432 -d postgres -U admin -v ON_ERROR_STOP=1 -At)

LEDGER='99999999-9999-9999-9999-999999999999'
WEEKLY='aaaaaaa1-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
EARLY='aaaaaaa2-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
DRIVER='c40dd8a6-f422-40bc-9534-bae7be88b93e'

echo "=== reset concurrent occupancy fixture ==="
"${PSQL[@]}" <<SQL
DELETE FROM weekly_early_race_sim.intents;
DELETE FROM weekly_early_race_sim.reservations;
DELETE FROM weekly_early_race_sim.allocations;
DELETE FROM weekly_early_race_sim.payout_items
WHERE id IN ('${WEEKLY}', '${EARLY}');
DELETE FROM weekly_early_race_sim.ledger WHERE id = '${LEDGER}';
INSERT INTO weekly_early_race_sim.ledger(id, driver_id, type, amount_pence)
VALUES ('${LEDGER}', '${DRIVER}', 'TRIP_EARNING_NET', 8166);
INSERT INTO weekly_early_race_sim.payout_items(id, driver_id, kind, status, execution_status, amount_pence)
VALUES
  ('${WEEKLY}', '${DRIVER}', 'WEEKLY_SCHEDULED', 'CREATED', 'CREATED', 8166),
  ('${EARLY}', '${DRIVER}', 'EARLY_CASHOUT', 'VALIDATED', 'VALIDATED', 8166);
SQL

echo "=== two concurrent allocations of the same 8166p earning ==="
"${PSQL[@]}" -c "INSERT INTO weekly_early_race_sim.allocations(payout_item_id, ledger_entry_id, amount_pence) VALUES ('${WEEKLY}', '${LEDGER}', 8166);" >/tmp/weekly_alloc.out 2>/tmp/weekly_alloc.err &
pid_w=$!
"${PSQL[@]}" -c "INSERT INTO weekly_early_race_sim.allocations(payout_item_id, ledger_entry_id, amount_pence) VALUES ('${EARLY}', '${LEDGER}', 8166);" >/tmp/early_alloc.out 2>/tmp/early_alloc.err &
pid_e=$!
set +e
wait "$pid_w"; w_ex=$?
wait "$pid_e"; e_ex=$?
set -e

echo "weekly_exit=$w_ex early_exit=$e_ex"
echo "weekly_err=$(tr '\n' ' ' < /tmp/weekly_alloc.err)"
echo "early_err=$(tr '\n' ' ' < /tmp/early_alloc.err)"

if [ "$w_ex" -eq 0 ] && [ "$e_ex" -ne 0 ]; then
  winner=weekly
elif [ "$e_ex" -eq 0 ] && [ "$w_ex" -ne 0 ]; then
  winner=early
else
  echo "CONCURRENT_ALLOC_FAIL both_exit weekly=$w_ex early=$e_ex"
  exit 1
fi

"${PSQL[@]}" <<SQL
DO \$\$
DECLARE
  n_alloc int;
  n_weekly int;
  n_early int;
BEGIN
  SELECT count(*) INTO n_alloc FROM weekly_early_race_sim.allocations
  WHERE ledger_entry_id = '${LEDGER}';
  SELECT count(*) INTO n_weekly FROM weekly_early_race_sim.allocations
  WHERE payout_item_id = '${WEEKLY}';
  SELECT count(*) INTO n_early FROM weekly_early_race_sim.allocations
  WHERE payout_item_id = '${EARLY}';
  IF n_alloc <> 1 OR (n_weekly + n_early) <> 1 THEN
    RAISE EXCEPTION 'ONE_EARNING_ONE_CONSUMER_FAIL alloc=% weekly=% early=%', n_alloc, n_weekly, n_early;
  END IF;
END \$\$;
SQL

echo "CONCURRENT_ONE_EARNING_ONE_CONSUMER PASS winner=$winner"