#!/usr/bin/env bash
# Step 8.2A.5 — Full migration forward/rollback/reapply rehearsal on throwaway PG.
# Bounded runtime; cleans up throwaway instance on exit.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/.audit-step82a5-2026-08-19"
PGDATA="${PGDATA:-/tmp/onecab-step82a5-pg}"
PORT="${PGPORT:-54330}"
DBURL="postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres"
MAX_SECONDS="${STEP82A5_MIGRATION_MAX_SECONDS:-600}"
STARTED=$(date +%s)

mkdir -p "$OUT"
: > "$OUT/migration-rehearsal-script.log"
log() { echo "[step82a5-migration] $*" | tee -a "$OUT/migration-rehearsal-script.log"; }

elapsed() { echo $(( $(date +%s) - STARTED )); }
check_budget() {
  if [[ $(elapsed) -gt $MAX_SECONDS ]]; then
    log "FAIL exceeded budget ${MAX_SECONDS}s"
    exit 124
  fi
}

run_timeout() {
  local secs="$1"; shift
  log "exec (timeout ${secs}s): $*"
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  else
    "$@"
  fi
}

stop_throwaway_pg() {
  if pg_isready -h 127.0.0.1 -p "$PORT" -U postgres >/dev/null 2>&1; then
    log "stopping throwaway PG port=$PORT"
    pg_ctl -D "$PGDATA" -m fast stop >>"$OUT/migration-rehearsal-script.log" 2>&1 || true
  fi
  # terminate any stragglers bound to our port
  pids=$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    log "terminating processes on port $PORT"
    kill -TERM $pids 2>/dev/null || true
    sleep 1
    kill -KILL $pids 2>/dev/null || true
  fi
}

cleanup() {
  stop_throwaway_pg
}
trap cleanup EXIT INT TERM

stop_throwaway_pg
if [[ "${STEP82A5_MIGRATION_FRESH:-1}" == "1" ]]; then
  log "fresh throwaway PG — removing stale data dir $PGDATA"
  rm -rf "$PGDATA"
fi
log "initdb + start throwaway PG on port $PORT data=$PGDATA"
run_timeout 120 initdb -D "$PGDATA" -U postgres --no-locale --encoding=UTF8
run_timeout 120 pg_ctl -D "$PGDATA" -o "-p $PORT -F" -l "$PGDATA/log" -w start
check_budget

log "phase=bootstrap"
run_timeout 120 psql "$DBURL" -v ON_ERROR_STOP=1 \
  -f "$REPO/supabase/tests/step82a4_throwaway_bootstrap.sql" \
  >>"$OUT/migration-rehearsal-script.log" 2>&1
check_budget

log "phase=snapshot-pre"
run_timeout 60 psql "$DBURL" -v ON_ERROR_STOP=1 -Atc "
SELECT indexname||'|'||indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename IN ('driver_wallet_ledger','payment_session_refunds')
ORDER BY 1;
" > "$OUT/pre-forward-indexes-script.txt"

log "phase=forward-migration"
run_timeout 180 psql "$DBURL" -v ON_ERROR_STOP=1 \
  -f "$REPO/supabase/migrations/20260930150000_provider_refund_ledger_idempotency.sql" \
  >>"$OUT/migration-rehearsal-script.log" 2>&1
check_budget

log "phase=atomic-tests"
run_timeout 120 psql "$DBURL" -v ON_ERROR_STOP=1 \
  -f "$REPO/supabase/tests/apply_confirmed_provider_refund_atomic.test.sql" \
  >>"$OUT/migration-rehearsal-script.log" 2>&1

log "phase=concurrent-tests"
run_timeout 300 bash "$REPO/scripts/step82a4-concurrent-refund-tests.sh" "$DBURL" \
  >>"$OUT/migration-rehearsal-script.log" 2>&1
check_budget

log "phase=rollback-pre-lineage"
run_timeout 180 psql "$DBURL" -v ON_ERROR_STOP=1 \
  -f "$REPO/supabase/migrations/rollback/rollback_20260930150000_provider_refund_ledger_idempotency.sql" \
  >>"$OUT/migration-rehearsal-script.log" 2>&1

log "phase=snapshot-post-rollback"
run_timeout 60 psql "$DBURL" -v ON_ERROR_STOP=1 -Atc "
SELECT indexname||'|'||indexdef FROM pg_indexes
WHERE schemaname='public' AND tablename IN ('driver_wallet_ledger','payment_session_refunds')
ORDER BY 1;
" > "$OUT/post-rollback-indexes-script.txt"

# Production preflight index is intentionally retained on rollback when pre-existing.
normalize_indexes() {
  rg -v '^payment_session_refunds_provider_refund_unique\|' "$1" > "${1}.norm" || true
}
normalize_indexes "$OUT/pre-forward-indexes-script.txt"
normalize_indexes "$OUT/post-rollback-indexes-script.txt"

if ! diff -u "$OUT/pre-forward-indexes-script.txt.norm" "$OUT/post-rollback-indexes-script.txt.norm" \
  >>"$OUT/migration-rehearsal-script.log" 2>&1; then
  log "FAIL catalog mismatch after rollback (normalized)"
  echo "MIGRATION_REVERSIBILITY=FAIL" > "$OUT/MIGRATION_REHEARSAL_SCRIPT.flag"
  exit 1
fi
log "catalog restored (provider_refund unique index retention expected)"

log "phase=reapply-forward"
run_timeout 180 psql "$DBURL" -v ON_ERROR_STOP=1 \
  -f "$REPO/supabase/migrations/20260930150000_provider_refund_ledger_idempotency.sql" \
  >>"$OUT/migration-rehearsal-script.log" 2>&1

log "phase=lineage-refuse"
run_timeout 60 psql "$DBURL" -v ON_ERROR_STOP=1 >>"$OUT/migration-rehearsal-script.log" 2>&1 <<'SQL'
INSERT INTO public.drivers (id, user_id) VALUES
  ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'::uuid)
ON CONFLICT DO NOTHING;
INSERT INTO public.trips (id, driver_id, payment_status, financial_model, capture_amount_pence, commission_pence, driver_net_pence, final_fare_pence, final_customer_fare_pence)
VALUES (
  'dddddddd-eeee-ffff-0000-111111111111'::uuid,
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid,
  'captured', 'PLATFORM_COLLECTED', 1250, 250, 1000, 1250, 1250
) ON CONFLICT DO NOTHING;
INSERT INTO public.driver_wallet_ledger (
  id, driver_id, type, amount_pence, related_trip_id, payment_provider, provider_refund_id
) VALUES (
  'cccccccc-dddd-eeee-ffff-000000000001'::uuid,
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid,
  'REFUND_DEBIT', -100, 'dddddddd-eeee-ffff-0000-111111111111'::uuid, 'revolut', 'prov_ref_test_1'
) ON CONFLICT DO NOTHING;
SQL

set +e
run_timeout 120 psql "$DBURL" -v ON_ERROR_STOP=1 \
  -f "$REPO/supabase/migrations/rollback/rollback_20260930150000_provider_refund_ledger_idempotency.sql" \
  >>"$OUT/migration-refuse-with-lineage-script.log" 2>&1
rc=$?
set -e
if [[ $rc -eq 0 ]]; then
  log "FAIL rollback succeeded with lineage present"
  echo "MIGRATION_REVERSIBILITY=FAIL" > "$OUT/MIGRATION_REHEARSAL_SCRIPT.flag"
  exit 1
fi
log "rollback correctly refused with lineage rc=$rc"

echo "MIGRATION_REVERSIBILITY=PASS" > "$OUT/MIGRATION_REHEARSAL_SCRIPT.flag"
log "migration rehearsal PASS elapsed=$(elapsed)s budget=${MAX_SECONDS}s"
