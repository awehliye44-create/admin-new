#!/usr/bin/env bash
# Step 8.2A.4 — throwaway PostgreSQL harness (local writes only, not production).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PGDATA="${PGDATA:-/tmp/onecab-step82a4-pg}"
PGPORT="${PGPORT:-54329}"
export PGHOST=127.0.0.1 PGPORT
OUT_DIR="$REPO/.audit-step82a4-2026-08-19"
mkdir -p "$OUT_DIR"

log() { echo "[step82a4] $*" | tee -a "$OUT_DIR/harness.log"; }

if ! pg_isready -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1; then
  if [ ! -d "$PGDATA/PG_VERSION" ]; then
    log "initdb $PGDATA"
    initdb -D "$PGDATA" -E UTF8 --locale=C >/dev/null
  fi
  log "starting postgres on port $PGPORT"
  pg_ctl -D "$PGDATA" -o "-p $PGPORT -F" -l "$PGDATA/log" start
  sleep 2
fi

DBURL="postgresql://$(whoami)@127.0.0.1:$PGPORT/postgres"

log "bootstrap schema"
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/step82a4_throwaway_bootstrap.sql" >>"$OUT_DIR/harness.log" 2>&1

log "apply migration 20260930150000"
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/20260930150000_provider_refund_ledger_idempotency.sql" >>"$OUT_DIR/harness.log" 2>&1

log "run basic SQL harness"
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/apply_confirmed_provider_refund_atomic.test.sql" | tee "$OUT_DIR/basic-harness.txt"

log "run concurrent-session harness"
bash "$REPO/scripts/step82a4-concurrent-refund-tests.sh" "$DBURL" | tee "$OUT_DIR/concurrent-harness.txt"

log "migration checksums"
shasum -a 256 \
  "$REPO/supabase/migrations/20260930150000_provider_refund_ledger_idempotency.sql" \
  "$REPO/supabase/migrations/rollback/rollback_20260930150000_provider_refund_ledger_idempotency.sql" \
  | tee "$OUT_DIR/migration-checksums.txt"

log "DONE — results in $OUT_DIR"
