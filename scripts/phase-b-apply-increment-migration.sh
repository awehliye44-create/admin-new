#!/usr/bin/env bash
# Apply ONLY the Phase B incremental-authorisation migration.
# Never uses blanket db push. Requires Phase B gate + APPLY=1.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIG="$ROOT/supabase/migrations/20260806120000_revolut_same_order_increment_ssot.sql"
if [[ ! -f "$MIG" ]]; then
  MIG="/Users/admin/ONECAB/onecab-customer-native/supabase/migrations/20260806120000_revolut_same_order_increment_ssot.sql"
fi

export TARGET_PROJECT_REF="${TARGET_PROJECT_REF:?required}"
export PREPROD_LIVE_TESTING_APPROVED="${PREPROD_LIVE_TESTING_APPROVED:?required}"
export REVOLUT_ENVIRONMENT="${REVOLUT_ENVIRONMENT:?required}"
export REVOLUT_MERCHANT_SECRET_KEY_CLASS="${REVOLUT_MERCHANT_SECRET_KEY_CLASS:?required}"
export REVOLUT_MERCHANT_BASE_URL="${REVOLUT_MERCHANT_BASE_URL:?required}"
export ALLOW_PAYMENT_TRANSACTIONS="${ALLOW_PAYMENT_TRANSACTIONS:-false}"

bash "$ROOT/scripts/phase-b-revolut-increment-gate.sh"

if [[ ! -f "$MIG" ]]; then
  echo "ABORT: migration file missing: $MIG"
  exit 2
fi

EXPECTED_SUM="25096b21c39c9f22b02b31c3bce6b786368e99903bae39bf85edbaf60fb80d2c"
SUM="$(shasum -a 256 "$MIG" | awk '{print $1}')"
echo "Migration: $(basename "$MIG")"
echo "SHA-256: $SUM"
echo "Target: $TARGET_PROJECT_REF"

if [[ "$SUM" != "$EXPECTED_SUM" ]]; then
  echo "ABORT: migration checksum mismatch (expected ${EXPECTED_SUM})."
  exit 2
fi

echo "--- SQL objects (preview) ---"
rg -n "^(ALTER TABLE|CREATE TABLE|CREATE UNIQUE INDEX|CREATE INDEX|DROP INDEX|ADD COLUMN|ADD CONSTRAINT|DROP CONSTRAINT)" "$MIG" || true

if [[ "${APPLY:-0}" != "1" ]]; then
  echo ""
  echo "Dry run only. Re-run with APPLY=1 and MIGRATION_APPLY_APPROVED=true to execute."
  exit 0
fi

if [[ "${MIGRATION_APPLY_APPROVED:-}" != "true" ]]; then
  echo "ABORT: APPLY=1 also requires MIGRATION_APPLY_APPROVED=true (explicit migration boundary approval)."
  exit 2
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ABORT: DATABASE_URL required when APPLY=1."
  exit 2
fi

# DATABASE_URL must target the approved pre-prod project (direct Postgres host or pooler).
if ! echo "$DATABASE_URL" | grep -q "thazislrdkjpvvghtvzo"; then
  echo "ABORT: DATABASE_URL must target project thazislrdkjpvvghtvzo."
  exit 2
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$MIG"
echo "Migration applied to $TARGET_PROJECT_REF"
