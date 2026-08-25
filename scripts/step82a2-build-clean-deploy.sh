#!/usr/bin/env bash
# Step 8.2A.2 — clean Phase 1 deployment worktree.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.deploy-step82a2-clean"
rm -rf "$OUT"

for slug in admin-capture-trip-payment revolut-capture-order admin-refund-trip-payment; do
  deno run --allow-read --allow-write --allow-run "$ROOT/scripts/step82a2-build-rollback-workdir.ts" \
    --slug "$slug" \
    --download-dir "$ROOT" \
    --out-dir "$OUT/workdirs/$slug" >/dev/null
done

cat > "$OUT/MANIFEST.json" <<EOF
{
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "scope": "Step 8.2A Phase 1 — admin capture/refund + legacy capture retire",
  "excluded_globs": [
    "admin-recover-mk007-mk009-wallet/**",
    ".audit-step4f4-2026-08-19/**",
    "resolve-service-area/**"
  ],
  "handlers": [
    "admin-capture-trip-payment",
    "revolut-capture-order",
    "admin-refund-trip-payment"
  ],
  "workdirs": {
    "admin-capture-trip-payment": "$OUT/workdirs/admin-capture-trip-payment",
    "revolut-capture-order": "$OUT/workdirs/revolut-capture-order",
    "admin-refund-trip-payment": "$OUT/workdirs/admin-refund-trip-payment"
  }
}
EOF

echo "Built $OUT"
