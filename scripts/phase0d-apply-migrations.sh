#!/usr/bin/env bash
# Phase 0d — apply Supabase migrations to a local Postgres database via psql.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DB_URL="${1:-postgresql://admin@localhost:5432/onecab_phase0d_full}"
STOP_BEFORE="${2:-}"  # optional migration version prefix to stop before (exclusive)

psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  name text
);
-- Supabase roles used by RPC grant tests
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
SQL

applied=0
skipped=0
failed=0

while IFS= read -r f; do
  base="$(basename "$f")"
  version="${base%%_*}"
  if [[ -n "$STOP_BEFORE" && "$version" > "$STOP_BEFORE" || "$version" == "$STOP_BEFORE" ]]; then
    echo "STOP before $STOP_BEFORE at $base"
    break
  fi
  exists="$(psql "$DB_URL" -tAc "SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '$version' LIMIT 1" 2>/dev/null || echo "")"
  if [[ "$exists" == "1" ]]; then
    skipped=$((skipped + 1))
    continue
  fi
  echo "APPLY $base"
  if psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f" >> /tmp/phase0d_migrate_detail.log 2>&1; then
    psql "$DB_URL" -q -c "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('$version', '$base') ON CONFLICT DO NOTHING;"
    applied=$((applied + 1))
  else
    echo "FAIL $base — see /tmp/phase0d_migrate_detail.log"
    failed=$((failed + 1))
    exit 1
  fi
done < <(ls "$REPO"/supabase/migrations/*.sql | sort)

echo "MIGRATION_SUMMARY applied=$applied skipped=$skipped failed=$failed"
