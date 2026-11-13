#!/usr/bin/env bash
# Consolidated regression gates (committed offer fare, waiting clock, OTA telemetry,
# concurrency hardening, negotiation lock order, stacked offer guard, monitor scans).
#
#   bash scripts/check-consolidated-regression-gates.sh
#
# Always runs   : vitest (2 files) + Deno (7 files)
# PostgreSQL    : when a LOCAL Postgres accepts connections (DB_URL, default below) this delegates to
#                 scripts/ci/run-pg-gates.sh (rematch/waiting A-F, negotiation L/N1-N5/M, offer guard
#                 incl. stacked, MK-007 stamp, SQL SSOT execution) - strict, REQUIRE_PG_HARNESS=1 semantics.
#                 DB unavailable: NOTICE + skip, unless REQUIRE_PG_HARNESS=1 (then FAIL).
#                 SKIP_PG_HARNESS=1 skips the PG step explicitly (the CI `ci` job: PG runs in `pg-harness`).
#
# CI runs the PG step in the mandatory `pg-harness` job with REQUIRE_PG_HARNESS=1.
# Local-only: DB_URL must point at 127.0.0.1 / localhost. Never touches prod.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
REQUIRE_PG_HARNESS="${REQUIRE_PG_HARNESS:-}"
SKIP_PG_HARNESS="${SKIP_PG_HARNESS:-}"

echo "=== [1/3] vitest: committed offer fare SSOT ==="
npx vitest run tests/committedBookingOfferFareSSOT.test.ts tests/committedOfferFareSqlExecution.test.ts

echo
echo "=== [2/3] deno: waiting clock, OTA telemetry, concurrency lock, monitor scans, negotiation / offer guard locks ==="
if ! command -v deno >/dev/null 2>&1; then
  echo "ERROR: deno is required (CI uses denoland/setup-deno@v2)." >&2
  exit 1
fi
deno test --no-check --allow-read --allow-env \
  supabase/functions/_shared/waitingSegmentClock.execution.test.ts \
  supabase/functions/_shared/otaAdoptionTelemetry.execution.test.ts \
  supabase/tests/_shared/concurrencyHardening20270222.lock.test.ts \
  supabase/tests/_shared/financialSsotMonitorScansLock.test.ts \
  supabase/tests/_shared/financialSsotMonitorScansFixtures.test.ts \
  supabase/tests/_shared/negotiationAndOfferGuard20270222.lock.test.ts

echo
echo "=== [3/3] postgres harness (local DB only) ==="
if [ "$SKIP_PG_HARNESS" = "1" ]; then
  echo "NOTICE: SKIP_PG_HARNESS=1 - PostgreSQL gates are run by the mandatory CI job 'pg-harness'."
  echo
  echo "OK: consolidated (non-PG) regression gates passed."
  exit 0
fi

case "$DB_URL" in
  *@127.0.0.1:*|*@localhost:*|*@127.0.0.1/*|*@localhost/*) ;;
  *) echo "REFUSING: DB_URL must be a LOCAL database (127.0.0.1/localhost). Got: $DB_URL" >&2; exit 2 ;;
esac

pg_ok=0
if command -v psql >/dev/null 2>&1; then
  if PGCONNECT_TIMEOUT=3 psql "$DB_URL" -X -q -At -c 'select 1' >/dev/null 2>&1; then
    pg_ok=1
  fi
fi

if [ "$pg_ok" = "1" ]; then
  echo "Postgres reachable at local DB_URL - running the strict PG gates."
  DB_URL="$DB_URL" bash scripts/ci/run-pg-gates.sh
elif [ "$REQUIRE_PG_HARNESS" = "1" ]; then
  echo "ERROR: REQUIRE_PG_HARNESS=1 but no local Postgres accepts connections at $DB_URL (or psql missing)." >&2
  exit 1
else
  echo "NOTICE: no local Postgres accepting connections at $DB_URL (or psql missing) - SKIPPING the PG harness."
  echo "NOTICE: set REQUIRE_PG_HARNESS=1 to make this a hard failure (CI does)."
fi

echo
echo "OK: consolidated regression gates passed."
