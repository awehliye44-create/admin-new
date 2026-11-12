#!/usr/bin/env bash
# Apply scheduled-parity migrations on disposable Postgres and verify.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$(cd "$(dirname "$0")" && pwd)"
NAME="onecab-isolated-scheduled-parity-$$"
PORT="${ISOLATED_PG_PORT:-55432}"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> starting disposable postgres ($NAME on :$PORT)"
docker run -d --name "$NAME" \
  -e POSTGRES_PASSWORD=postgres \
  -p "${PORT}:5432" \
  postgres:15-alpine >/dev/null

for i in $(seq 1 40); do
  if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
docker exec "$NAME" pg_isready -U postgres >/dev/null

psql=(psql "postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres" -v ON_ERROR_STOP=1)

echo "==> bootstrap fixture schema"
"${psql[@]}" -f "$DIR/00_bootstrap.sql"

echo "==> apply 20270218130000 lifecycle"
"${psql[@]}" -f "$ROOT/supabase/migrations/20270218130000_scheduled_auto_publish_webhook_create_fix.sql"

echo "==> apply 20270218130100 retire manual controls"
"${psql[@]}" -f "$ROOT/supabase/migrations/20270218130100_retire_manual_scheduled_dispatch_controls.sql"

echo "==> apply 20270218130200 finalize parity"
"${psql[@]}" -f "$ROOT/supabase/migrations/20270218130200_finalize_scheduled_create_parity.sql"

echo "==> verify lifecycle / finalize / retirement / capture gate"
"${psql[@]}" -f "$DIR/99_verify.sql"

echo "ISOLATED_MIGRATION_VERIFY_OK"
