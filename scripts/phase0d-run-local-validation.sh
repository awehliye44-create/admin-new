#!/usr/bin/env bash
# Phase 0d — local migration apply + SQL integration validation.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DB_NAME="${PHASE0D_DB:-onecab_phase0d_test}"
DB_URL="postgresql://admin@localhost:5432/${DB_NAME}"
AUDIT_DIR="${REPO}/.audit-phase0d"
mkdir -p "$AUDIT_DIR"

log() { echo "[phase0d] $*" | tee -a "$AUDIT_DIR/run.log"; }

capture_grants() {
  local label="$1" file="$2"
  psql "$DB_URL" -Atc "
    SELECT p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' ||
           coalesce(string_agg(r.rolname, ',' ORDER BY r.rolname), 'NONE')
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN LATERAL aclexplode(p.proacl) a ON true
    LEFT JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'finalize_driver_payout_completion',
        'finalize_manual_external_payout_completion',
        'assert_payout_item_ledger_lineage'
      )
    GROUP BY p.oid, p.proname
    ORDER BY p.proname;" > "$file" 2>/dev/null || true
}

capture_sigs() {
  local label="$1" file="$2"
  psql "$DB_URL" -Atc "
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('finalize_driver_payout_completion','finalize_manual_external_payout_completion')
    ORDER BY 1;" > "$file"
}

log "Recreate database ${DB_NAME}"
dropdb --if-exists "$DB_NAME"
createdb "$DB_NAME"

log "Bootstrap minimal schema"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/phase0d_local_bootstrap.sql" | tee "$AUDIT_DIR/bootstrap.log"

capture_grants "pre" "$AUDIT_DIR/grants_before.txt"
capture_sigs "pre" "$AUDIT_DIR/signatures_before.txt"

log "Apply lineage dependency migration"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/20260927180200_payout_item_ledger_allocation_lineage.sql" \
  | tee "$AUDIT_DIR/migration_lineage.log"

log "Apply migration 1/3 manual external RPC"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/20260930240000_manual_external_payout_completion_atomic.sql" \
  | tee "$AUDIT_DIR/migration_manual_external.log"

log "Apply migration 2/3 payout RPC hardening"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/20260901130000_payout_rpc_invariant_hardening.sql" \
  | tee "$AUDIT_DIR/migration_payout_hardening.log"

log "Apply migration 3/3 model-scoped views"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/20260901140000_model_scoped_driver_financial_summary.sql" \
  | tee "$AUDIT_DIR/migration_views.log"

capture_grants "post" "$AUDIT_DIR/grants_after.txt"
capture_sigs "post" "$AUDIT_DIR/signatures_after.txt"

log "Run payout RPC integration tests"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/phase0d_payout_rpc_integration.sql" \
  | tee "$AUDIT_DIR/payout_rpc_tests.log"

log "Run manual external RPC integration tests"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/phase0d_manual_rpc_integration.sql" \
  | tee "$AUDIT_DIR/manual_rpc_tests.log"

log "Run view security tests"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/phase0d_view_security.sql" \
  | tee "$AUDIT_DIR/view_security_tests.log"

log "Test migration idempotency (re-apply 3 migrations)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/20260930240000_manual_external_payout_completion_atomic.sql" \
  && psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/20260901130000_payout_rpc_invariant_hardening.sql" \
  && psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/20260901140000_model_scoped_driver_financial_summary.sql" \
  | tee "$AUDIT_DIR/idempotency.log"

log "PHASE0D_LOCAL_VALIDATION_COMPLETE"
