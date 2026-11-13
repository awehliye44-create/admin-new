#!/usr/bin/env bash
# =============================================================================
# Build the PostgreSQL database the mandatory CI `pg-harness` job runs against.
#
#   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
#   ADMIN_DB_URL=postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres \
#     bash scripts/ci/pg-harness-bootstrap.sh
#
# WHY a baseline dump (exact blocker for `supabase start` / `supabase db reset --local`):
#   supabase/migrations/ starts at 20260112120246 with `INSERT INTO public.drivers ...`. The
#   base schema (public.trips, public.drivers, public.ride_offers, ... 297 tables / 890 functions)
#   was created on the hosted project before the migration history was exported and NO migration
#   creates it. Replaying the migration directory on an empty database therefore fails at the very
#   first file, so `supabase start` cannot produce a usable schema.
#
# Self-contained approach used instead (free, no secrets, no linked project):
#   1. start the plain public.ecr.aws/supabase/postgres:17.6.1.140 image (service container)
#   2. pg_harness_auth_stubs.sql    - auth.jwt() + the GoTrue columns the public schema reads
#   3. pg_harness_baseline_public.sql.gz  - SCHEMA-ONLY dump of `public` (no data, no owners/ACLs)
#                                           from the schema-snapshot local DB, current through the
#                                           migration named in pg_harness_baseline.version
#   4. every repo migration NEWER than that version, in order (-v ON_ERROR_STOP=1) — so the
#      migrations under test are really executed, not assumed
#   5. pg_harness_seed.sql          - QA config rows + one anchor driver/trip the rematch harness
#                                     borrows an in-area pickup / region from
#
# Refresh the baseline (only when the harness schema must move forward):
#   pg_dump "$LOCAL_SNAPSHOT_DB" --schema-only --schema=public --no-owner --no-privileges \
#     | sed -e '/^CREATE SCHEMA public;$/d' -e '/^COMMENT ON SCHEMA public/d' | gzip -9 -n \
#     > supabase/tests/ci/pg_harness_baseline_public.sql.gz     # then bump pg_harness_baseline.version
#
# LOCAL / CI database only (127.0.0.1 / localhost). Never touches prod.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
ADMIN_DB_URL="${ADMIN_DB_URL:-postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres}"
CI_DIR="supabase/tests/ci"

for u in "$DB_URL" "$ADMIN_DB_URL"; do
  case "$u" in
    *@127.0.0.1:*|*@localhost:*|*@127.0.0.1/*|*@localhost/*) ;;
    *) echo "REFUSING: database URL must be local (127.0.0.1/localhost). Got: $u" >&2; exit 2 ;;
  esac
done

echo "=== waiting for Postgres ==="
ready=0
for i in $(seq 1 60); do
  if PGCONNECT_TIMEOUT=3 psql "$ADMIN_DB_URL" -X -q -At -c 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
if [ "$ready" != "1" ]; then echo "ERROR: Postgres did not accept connections at $ADMIN_DB_URL" >&2; exit 1; fi
echo "server: $(psql "$ADMIN_DB_URL" -X -q -At -c 'select version()' | cut -c1-70)"

if [ "$(psql "$DB_URL" -X -q -At -c "select to_regclass('public.trips') is not null")" = "t" ]; then
  echo "ERROR: public.trips already exists - bootstrap needs a FRESH database (use a new service container)." >&2
  exit 1
fi

BASELINE="$(tr -d '[:space:]' < "$CI_DIR/pg_harness_baseline.version")"
echo "baseline: public schema snapshot current through migration $BASELINE"

echo "=== extensions + auth stubs ==="
psql "$ADMIN_DB_URL" -X -q -v ON_ERROR_STOP=1 \
  -c "create extension if not exists postgis schema extensions" \
  -c "create extension if not exists pg_net"
psql "$ADMIN_DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$CI_DIR/pg_harness_auth_stubs.sql"

echo "=== restoring baseline public schema ==="
gunzip -c "$CI_DIR/pg_harness_baseline_public.sql.gz" | psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f - >/dev/null
fn_count="$(psql "$DB_URL" -X -q -At -c "select count(*) from pg_proc where pronamespace='public'::regnamespace")"
tbl_count="$(psql "$DB_URL" -X -q -At -c "select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r'")"
echo "restored: $tbl_count tables, $fn_count functions"
if [ "$tbl_count" -lt 250 ] || [ "$fn_count" -lt 800 ]; then
  echo "ERROR: restored schema looks incomplete (expected >=250 tables, >=800 functions)" >&2; exit 1
fi

echo "=== applying repo migrations newer than $BASELINE ==="
applied=0
for f in $(ls supabase/migrations/*.sql | sort); do
  v="$(basename "$f" | grep -oE '^[0-9]{14}' || true)"
  [ -n "$v" ] || continue
  if [ "$v" -gt "$BASELINE" ]; then
    echo "  -> $(basename "$f")"
    psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null
    applied=$((applied + 1))
  fi
done
echo "applied $applied migration(s)"
if [ "$applied" -lt 5 ]; then
  echo "ERROR: expected at least the 2027-02-22 migrations to be applied (got $applied)" >&2; exit 1
fi

echo "=== seed ==="
psql "$DB_URL" -X -q -v ON_ERROR_STOP=1 -f "$CI_DIR/pg_harness_seed.sql" >/dev/null

echo "=== sanity ==="
psql "$DB_URL" -X -q -At -v ON_ERROR_STOP=1 <<'SQL'
select case when
  to_regprocedure('public.accept_ride_offer_core(uuid,uuid,boolean)') is not null
  and to_regprocedure('public.customer_counter_ride_offer_core(uuid,integer,uuid,uuid)') is not null
  and to_regprocedure('public.tr_ride_offer_financial_invariant_guard_fn()') is not null
  and to_regprocedure('public.offer_trip_financial_authority(public.trips)') is not null
  and to_regprocedure('public.financial_ssot_monitor_sweep()') is not null
  and exists (select 1 from pg_trigger where tgname = 'zz_ride_offer_financial_invariant_guard')
  and exists (select 1 from public.global_dispatch_settings where singleton)
then 'BOOTSTRAP_OK' else 'BOOTSTRAP_INCOMPLETE' end;
SQL
[ "$(psql "$DB_URL" -X -q -At -c "select to_regprocedure('public.offer_trip_financial_authority(public.trips)') is not null and to_regprocedure('public.customer_counter_ride_offer_core(uuid,integer,uuid,uuid)') is not null and exists (select 1 from public.global_dispatch_settings where singleton)")" = "t" ] \
  || { echo "ERROR: bootstrap incomplete" >&2; exit 1; }
echo "OK: PG harness database ready."
