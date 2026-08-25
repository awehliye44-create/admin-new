#!/usr/bin/env bash
# Step 9.4D1 — local throwaway Postgres validation (never touches production).
# Real two-session concurrency + serial cases + rollback rehearsal.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT="${ROOT}/.audit-step94d1-2026-08-21"
PGDATA="${AUDIT}/pgdata"
PORT=55433
DB_URL="${STEP94D1_PG_URL:-postgresql://postgres@127.0.0.1:${PORT}/postgres?host=${PGDATA}}"
mkdir -p "$AUDIT"

log() { echo "$*" | tee -a "$AUDIT/run.log"; }

# Start throwaway Postgres if needed
if ! pg_isready -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1; then
  if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
    log "initdb $PGDATA"
    initdb -D "$PGDATA" --auth-local=trust --auth-host=trust -U postgres >/dev/null
    {
      echo "port = $PORT"
      echo "unix_socket_directories = '$PGDATA'"
      echo "listen_addresses = '127.0.0.1'"
    } >> "$PGDATA/postgresql.conf"
  fi
  log "pg_ctl start port=$PORT"
  pg_ctl -D "$PGDATA" -l "$AUDIT/pg.log" start
  for _ in $(seq 1 30); do
    pg_isready -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1 && break
    sleep 0.2
  done
fi

log "Using DB port=$PORT (throwaway)"

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -f "$ROOT/supabase/tests/step94d1_oauth_refresh_ownership_bootstrap.sql" \
  >>"$AUDIT/run.log" 2>&1

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -f "$ROOT/supabase/migrations/20261022120000_revolut_business_oauth_refresh_ownership.sql" \
  >>"$AUDIT/run.log" 2>&1

# Serial cases 1–12 (+ rollback case 9)
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -f "$ROOT/supabase/tests/step94d1_oauth_refresh_ownership.test.sql" \
  2>&1 | tee -a "$AUDIT/run.log" | tee "$AUDIT/test-output.txt"

# Real two-session concurrency: exactly one CLAIMED
psql "$DB_URL" -v ON_ERROR_STOP=1 <<'SQL' >>"$AUDIT/run.log"
UPDATE public.revolut_business_oauth_refresh_coord
SET access_token_expires_at = now() - interval '1 hour',
    refresh_claim_token = NULL, refresh_claimed_at = NULL, refresh_claim_expires_at = NULL,
    credential_generation = 100
WHERE provider = 'revolut' AND environment = 'live';
UPDATE public.payment_provider_vault
SET secret_value = (now() - interval '1 hour')::text
WHERE provider = 'revolut' AND environment = 'live'
  AND secret_name IN ('business_token_expires_at', 'REVOLUT_BUSINESS_TOKEN_EXPIRES_AT');
SQL

CONC_DIR=$(mktemp -d)
trap 'rm -rf "$CONC_DIR"' EXIT

# Session A and B race claim
(
  psql "$DB_URL" -v ON_ERROR_STOP=1 -Atc \
    "SELECT public.claim_revolut_business_oauth_refresh('revolut','live',60,45)::text;" \
    >"$CONC_DIR/a.json"
) &
PID_A=$!
(
  psql "$DB_URL" -v ON_ERROR_STOP=1 -Atc \
    "SELECT public.claim_revolut_business_oauth_refresh('revolut','live',60,45)::text;" \
    >"$CONC_DIR/b.json"
) &
PID_B=$!
wait $PID_A $PID_B

python3 - <<PY
import json
from pathlib import Path
d=Path("$CONC_DIR")
a=json.loads((d/"a.json").read_text().strip())
b=json.loads((d/"b.json").read_text().strip())
statuses=sorted([a["status"], b["status"]])
claimed=[x for x in (a,b) if x["status"]=="CLAIMED"]
progress=[x for x in (a,b) if x["status"]=="REFRESH_IN_PROGRESS"]
assert statuses==["CLAIMED","REFRESH_IN_PROGRESS"] or (
  # rare: both sequential if lock serialized fully then second sees in-progress
  len(claimed)==1 and len(progress)==1
), (a,b)
assert len(claimed)==1, (a,b)
assert claimed[0].get("claim_token"), claimed
assert progress[0].get("claim_token") in (None, ""), progress
# no secrets
blob=json.dumps([a,b])
assert "fixture_access" not in blob and "BEGIN PRIVATE" not in blob
print("TWO_SESSION_CONCURRENCY_PASS", json.dumps({"claimed_gen": claimed[0]["credential_generation"], "other": progress[0]["status"]}))
open("$AUDIT/concurrency-two-session.json","w").write(json.dumps({"a":a,"b":b},indent=2))
PY

# Migration reversal rehearsal on throwaway DB
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -f "$ROOT/supabase/migrations/rollback/rollback_20261022120000_revolut_business_oauth_refresh_ownership.sql" \
  >>"$AUDIT/run.log" 2>&1

psql "$DB_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT to_regclass('public.revolut_business_oauth_refresh_coord') IS NULL;" \
  | tee "$AUDIT/rollback-table-gone.flag" | grep -qx t

# Re-apply proves migration is re-runnable after rollback
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -f "$ROOT/supabase/migrations/20261022120000_revolut_business_oauth_refresh_ownership.sql" \
  >>"$AUDIT/run.log" 2>&1

psql "$DB_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT to_regclass('public.revolut_business_oauth_refresh_coord') IS NOT NULL;" \
  | grep -qx t

log "STEP94D1_THROWAWAY_PASS"
log "MIGRATION_REVERSAL_REHEARSAL_PASS"

# Leave server running for optional inspection; stop if STEP94D1_STOP_PG=1
if [[ "${STEP94D1_STOP_PG:-0}" == "1" ]]; then
  pg_ctl -D "$PGDATA" stop -m fast || true
fi
