#!/usr/bin/env bash
# Disposable Postgres cluster for supabase/tests/presence_liveness_nearby_radius_isolated.sql.
# Never touches a shared or production database.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PORT="${PRESENCE_NEARBY_PG_PORT:-55432}"
DATA="$(mktemp -d /tmp/onecab-presence-nearby-XXXXXX)"

cleanup() {
  "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DATA"
}
trap cleanup EXIT

"$PG_BIN/initdb" -D "$DATA" -U postgres -A trust >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $DATA -c listen_addresses=''" -l "$DATA/server.log" -w start >/dev/null

"$PG_BIN/psql" -h "$DATA" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f "$REPO/supabase/tests/presence_liveness_nearby_radius_isolated.sql"
