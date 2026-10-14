#!/usr/bin/env bash
# Applies the real receivable + shortfall-safety migrations (and the rollback) to a
# throwaway local Postgres cluster and runs the scenarios. Never touches a shared database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
PORT="${PORT:-55471}"
DATA="$(mktemp -d)/pg"

cleanup() { "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PG_BIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA.log" -w start >/dev/null

psql_run() { "$PG_BIN/psql" -h /tmp -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

psql_run -f "$ROOT/supabase/tests/waiting_shortfall_receivable_safety.setup.sql"
psql_run -f "$ROOT/supabase/migrations/20261127150000_customer_receivables_ssot.sql"
psql_run -f "$ROOT/supabase/migrations/20261217110000_waiting_shortfall_receivable_safety.sql"
psql_run -At -f "$ROOT/supabase/tests/waiting_shortfall_receivable_safety.sql"

# Rollback restores the original release function and drops the new RPCs; the table stays.
psql_run -f "$ROOT/supabase/migrations/rollback/rollback_20261217110000_waiting_shortfall_receivable_safety.sql"
psql_run -At -c "
  SELECT CASE WHEN to_regprocedure('public.finance_record_shortfall_exception(text,uuid,uuid,text,uuid,text,integer,integer,integer,text,text,jsonb)') IS NULL
              AND to_regclass('public.finance_shortfall_exceptions') IS NOT NULL
              AND position('v_debt_captured' IN pg_get_functiondef('public.customer_receivable_release_reservations(uuid,text)'::regprocedure)) = 0
         THEN 'rollback: OK' ELSE 'rollback: FAILED' END;" | tee /dev/stderr | grep -q 'rollback: OK'
