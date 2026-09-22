#!/usr/bin/env bash
# Two real parallel psql sessions against weekly_claim_sim.
# Prerequisite: serial SQL has created the schema+function.
set -euo pipefail
export PATH=/usr/bin:/bin:/opt/homebrew/bin:$PATH

PSQL=(psql -h 127.0.0.1 -p 5432 -d postgres -U admin -v ON_ERROR_STOP=1 -At)
KEY='weekly-payout:milton-keynes:concurrent-live:2026-09-22T12:00:00+01:00'

echo "=== reset concurrent fixture ==="
"${PSQL[@]}" <<SQL
DELETE FROM weekly_claim_sim.weekly_payout_occurrence_runs
WHERE schedule_occurrence_key = '${KEY}';
SQL

echo "=== two concurrent live claims ==="
"${PSQL[@]}" -c "SELECT weekly_claim_sim.claim_weekly_payout_occurrence('${KEY}', false);" > /tmp/weekly_claim_a.json &
pid_a=$!
"${PSQL[@]}" -c "SELECT weekly_claim_sim.claim_weekly_payout_occurrence('${KEY}', false);" > /tmp/weekly_claim_b.json &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

echo "A=$(cat /tmp/weekly_claim_a.json)"
echo "B=$(cat /tmp/weekly_claim_b.json)"

"${PSQL[@]}" <<SQL
DO \$\$
DECLARE
  n int;
  winners int;
BEGIN
  SELECT count(*) INTO n
  FROM weekly_claim_sim.weekly_payout_occurrence_runs
  WHERE schedule_occurrence_key = '${KEY}' AND dry_run = false;
  IF n <> 1 THEN
    RAISE EXCEPTION 'CONCURRENT_FAIL rowcount=%', n;
  END IF;
END \$\$;
SQL

python3 - <<'PY'
import json, pathlib
def parse(p):
    raw = pathlib.Path(p).read_text().strip()
    return json.loads(raw)
a = parse("/tmp/weekly_claim_a.json")
b = parse("/tmp/weekly_claim_b.json")
assert a["ok"] is True and b["ok"] is True
ids = {a["run_id"], b["run_id"]}
assert len(ids) == 1, ids
reused = sorted([bool(a["reused"]), bool(b["reused"])])
assert reused == [False, True], reused
print("CONCURRENT_CLAIM_IDEMPOTENT PASS", list(ids)[0])
PY
