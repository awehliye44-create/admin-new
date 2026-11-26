#!/usr/bin/env bash
# #110 P2 — Apply production-equivalent missing trips UPDATE triggers to LOCAL harness only.
set -euo pipefail
HOST="${PGHOST:-127.0.0.1}"
case "$HOST" in
  127.0.0.1|localhost) ;;
  *)
    echo "REFUSED: host=$HOST is not local"
    exit 2
    ;;
esac
PORT="${PGPORT:-54329}"
USER="${PGUSER:-postgres}"
DB="${PGDATABASE:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 \
  -f "$ROOT/supabase/tests/trips_update_trigger_parity_110_local.sql"
psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -At <<'SQL'
SELECT 'count_total=' || count(*)
  || ' unconditional=' || count(*) FILTER (
       WHERE pg_get_triggerdef(t.oid) !~* 'WHEN \('
     )
  || ' conditional=' || count(*) FILTER (
       WHERE pg_get_triggerdef(t.oid) ~* 'WHEN \('
     )
FROM pg_trigger t
WHERE t.tgrelid = 'public.trips'::regclass
  AND NOT t.tgisinternal
  AND pg_get_triggerdef(t.oid) ILIKE '%UPDATE%';
SQL
echo "trips_update_trigger_parity_110_local COMPLETE"
