#!/usr/bin/env bash
# Runs the vehicle change request migration and its behaviour tests in a
# throwaway local Postgres (no Supabase project involved).
#   bash supabase/tests/driver_vehicle_change_request_isolated.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
DATA="$(mktemp -d)"; PORT="${PORT:-55439}"
trap '"$PG_BIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DATA"' EXIT
"$PG_BIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA" -l "$DATA/pg.log" start >/dev/null
PSQL=("$PG_BIN/psql" -h "$DATA" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -c "create database vcr"
"${PSQL[@]}" -d vcr -f "$HERE/driver_vehicle_change_request_isolated.setup.sql"
"${PSQL[@]}" -d vcr -f "$HERE/../migrations/20261214120000_driver_vehicle_change_request_flow.sql" 2>/dev/null
"${PSQL[@]}" -d vcr -f "$HERE/../migrations/20261214120000_driver_vehicle_change_request_flow.sql" 2>/dev/null
"${PSQL[@]}" -d vcr -f "$HERE/driver_vehicle_change_request_isolated.sql" | grep -E "PASS|FAIL|ALL_VEHICLE"
"${PSQL[@]}" -d vcr -f "$HERE/../migrations/rollback/rollback_20261214120000_driver_vehicle_change_request_flow.sql"
LEFT="$("${PSQL[@]}" -d vcr -tAc "select count(*) from pg_proc where proname in ('submit_driver_vehicle_change_request','admin_decide_vehicle_change_request')")"
[ "$LEFT" = "0" ] || { echo "FAIL: rollback left RPCs"; exit 1; }
"${PSQL[@]}" -d vcr -f "$HERE/../migrations/20261214120000_driver_vehicle_change_request_flow.sql" 2>/dev/null
echo "ROLLBACK_AND_REAPPLY_OK"
