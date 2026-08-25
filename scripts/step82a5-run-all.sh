#!/usr/bin/env bash
# Step 8.2A.5 master runner — local only, no production mutation.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
AUDIT="$REPO/.audit-step82a5-2026-08-19"
OUT="$REPO/.rollback-step82a5-2026-08-19"
mkdir -p "$AUDIT" "$OUT"

echo "=== 1. Production provider-refund index (read-only) ==="
if [[ -n "${DATABASE_URL:-}" ]]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$REPO/scripts/step82a5-production-provider-refund-index-readonly.sql" \
    | tee "$AUDIT/production-provider-refund-index.txt"
else
  echo "SKIP: DATABASE_URL not set" | tee "$AUDIT/production-provider-refund-index.txt"
fi

echo "=== 2. Download deployed archives (requires SUPABASE_ACCESS_TOKEN — use step82a5-secure-download-with-token.sh) ==="
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  bash "$REPO/scripts/step82a5-download-function-archive.sh"
else
  echo "SKIP download: SUPABASE_ACCESS_TOKEN unset — run scripts/step82a5-secure-download-with-token.sh" | tee "$AUDIT/download-skipped.log"
fi

echo "=== 3. Reconstruct rollback workdirs (archive-only; runs inside download script when token present) ==="

echo "=== 4. Forward deploy workdirs ==="
bash "$REPO/scripts/step82a5-build-forward-deploy-workdirs.sh" 2>&1 | tee "$AUDIT/forward-deploy.log"

echo "=== 5. Migration rehearsal ==="
bash "$REPO/scripts/step82a5-migration-rehearsal.sh" 2>&1 | tee "$AUDIT/migration-rehearsal-run.log" || true

echo "=== 6. Lock tests ==="
cd "$REPO"
deno test --allow-read supabase/functions/_shared/providerRefundAtomicRpcLock.test.ts 2>&1 | tee "$AUDIT/lock-tests.log" || true

echo "=== DONE ==="
