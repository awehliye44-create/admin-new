#!/usr/bin/env bash
# Isolated refund, airport and reassignment proof. Never touches a shared database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
PORT="${PORT:-55473}"
DATA="$(mktemp -d)/pg"

cleanup() { "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PG_BIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA.log" -w start >/dev/null

psql_run() { "$PG_BIN/psql" -h /tmp -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }

python3 - "$ROOT/supabase/migrations/20261217100000_financial_resilience_hardening.sql" "$DATA" << 'PY'
import pathlib, sys
src = pathlib.Path(sys.argv[1]).read_text().splitlines(True)
out = pathlib.Path(sys.argv[2])
out.joinpath("eligibility_fn.sql").write_text("".join(src[11:353]))
out.joinpath("refund_fn.sql").write_text("".join(src[354:735]))
PY

psql_run -q -f "$ROOT/supabase/tests/refund_airport_reassignment_isolated.sql"
psql_run -q -f "$DATA/eligibility_fn.sql"
psql_run -q -f "$DATA/refund_fn.sql"
psql_run -f "$ROOT/supabase/tests/refund_airport_reassignment_cases.sql"
