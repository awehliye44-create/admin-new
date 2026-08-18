#!/usr/bin/env bash
# Throwaway Postgres: forward migration, pg tests, rollback MD5 verify, reapply.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGDATA="${PGDATA:-/tmp/onecab_settlement_pgdata_step2a1}"
PGPORT="${PGPORT:-55432}"
PGUSER="${PGUSER:-$(whoami)}"
export PGDATA PGPORT PGUSER

PG_CTL="/opt/homebrew/opt/postgresql@16/bin/pg_ctl"
INITDB="/opt/homebrew/opt/postgresql@16/bin/initdb"
PSQL="/opt/homebrew/opt/postgresql@16/bin/psql"
CREATEDB="/opt/homebrew/opt/postgresql@16/bin/createdb"

FORWARD="${ROOT}/supabase/migrations/20260928150000_canonical_promotion_settlement_ssot.sql"
ROLLBACK="${ROOT}/.rollback-step2a-2026-08-18/ROLLBACK_canonical_promotion_settlement.sql"
HARNESS="${ROOT}/supabase/tests/canonical_promotion_settlement_pgsql.harness.sql"
SETUP="${ROOT}/supabase/tests/canonical_promotion_settlement_pgsql.setup.sql"
RESULTS="${ROOT}/.rollback-step2a-2026-08-18/pg_step2a1_results.txt"

BASELINE_COMMIT="bfe97947b234e162a0b75d3841585327"
BASELINE_SNAPSHOT="9f8fc40a74146559f115b4b1c415abb7"
BASELINE_TIER="1c56a7412eb636c1ac4a5173a7a6e735"

fn_md5() {
  local name="$1"
  "$PSQL" -p "$PGPORT" -d onecab_settlement_test -Atc \
    "SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='${name}' ORDER BY p.oid DESC LIMIT 1;"
}

start_pg() {
  if ! "$PG_CTL" -D "$PGDATA" status >/dev/null 2>&1; then
    if [[ ! -d "$PGDATA" ]]; then
      "$INITDB" -D "$PGDATA" -U "$PGUSER" --no-locale -E UTF8
    fi
    "$PG_CTL" -D "$PGDATA" -o "-p ${PGPORT}" -l /tmp/onecab_settlement_pg.log start
    sleep 2
  fi
  "$CREATEDB" -p "$PGPORT" onecab_settlement_test 2>/dev/null || true
}

stop_pg() {
  "$PG_CTL" -D "$PGDATA" stop -m fast 2>/dev/null || true
}

{
  echo "=== Step 2A.1 throwaway Postgres $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  start_pg

  echo "--- setup minimal schema ---"
  "$PSQL" -p "$PGPORT" -d onecab_settlement_test -v ON_ERROR_STOP=1 -f "$SETUP"

  echo "--- apply production baseline RPCs (pre-forward) ---"
  "$PSQL" -p "$PGPORT" -d onecab_settlement_test -v ON_ERROR_STOP=1 \
    -f "${ROOT}/.rollback-step2a-2026-08-18/baseline_accept_snapshot_wave_commission_ssot.sql"

  echo "--- forward migration ---"
  "$PSQL" -p "$PGPORT" -d onecab_settlement_test -v ON_ERROR_STOP=1 -f "$FORWARD"

  echo "--- pg harness tests (forward) ---"
  "$PSQL" -p "$PGPORT" -d onecab_settlement_test -v ON_ERROR_STOP=1 -f "$HARNESS"

  echo "--- forward function MD5 (post-apply) ---"
  FWD_COMMIT="$(fn_md5 commit_negotiation_fare)"
  FWD_SNAPSHOT="$(fn_md5 snapshot_accepted_wave_commission)"
  FWD_TIER="$(fn_md5 snapshot_driver_tier_commission_on_trip)"
  echo "forward commit_negotiation_fare md5=${FWD_COMMIT}"
  echo "forward snapshot_accepted_wave_commission md5=${FWD_SNAPSHOT}"
  echo "forward snapshot_driver_tier_commission_on_trip md5=${FWD_TIER}"

  echo "--- rollback ---"
  (cd "${ROOT}/.rollback-step2a-2026-08-18" && \
    "$PSQL" -p "$PGPORT" -d onecab_settlement_test -v ON_ERROR_STOP=1 -f ROLLBACK_canonical_promotion_settlement.sql)

  RB_COMMIT="$(fn_md5 commit_negotiation_fare)"
  RB_SNAPSHOT="$(fn_md5 snapshot_accepted_wave_commission)"
  RB_TIER="$(fn_md5 snapshot_driver_tier_commission_on_trip)"
  echo "rollback commit_negotiation_fare md5=${RB_COMMIT} (expect ${BASELINE_COMMIT})"
  echo "rollback snapshot_accepted_wave_commission md5=${RB_SNAPSHOT} (expect ${BASELINE_SNAPSHOT})"
  echo "rollback snapshot_driver_tier_commission_on_trip md5=${RB_TIER} (expect ${BASELINE_TIER})"

  if [[ "$RB_COMMIT" != "$BASELINE_COMMIT" ]]; then echo "FAIL commit MD5"; exit 1; fi
  if [[ "$RB_SNAPSHOT" != "$BASELINE_SNAPSHOT" ]]; then echo "FAIL snapshot MD5"; exit 1; fi
  if [[ "$RB_TIER" != "$BASELINE_TIER" ]]; then echo "FAIL tier MD5"; exit 1; fi

  echo "--- reapply forward ---"
  "$PSQL" -p "$PGPORT" -d onecab_settlement_test -v ON_ERROR_STOP=1 -f "$FORWARD"
  RE_COMMIT="$(fn_md5 commit_negotiation_fare)"
  RE_SNAPSHOT="$(fn_md5 snapshot_accepted_wave_commission)"
  RE_TIER="$(fn_md5 snapshot_driver_tier_commission_on_trip)"
  if [[ "$RE_COMMIT" != "$FWD_COMMIT" ]]; then echo "FAIL reapply commit MD5"; exit 1; fi
  if [[ "$RE_SNAPSHOT" != "$FWD_SNAPSHOT" ]]; then echo "FAIL reapply snapshot MD5"; exit 1; fi
  if [[ "$RE_TIER" != "$FWD_TIER" ]]; then echo "FAIL reapply tier MD5"; exit 1; fi

  echo "ALL_THROWAWAY_PG_CHECKS_PASSED"
} | tee "$RESULTS"

echo "Results written to $RESULTS"
