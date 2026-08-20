#!/usr/bin/env bash
# Step 8.2B3.1 — rebuild forward workdirs + run all local validation (no deploy).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
AUDIT="$REPO/.audit-step82b31-2026-08-19"
mkdir -p "$AUDIT"

bash "$REPO/scripts/step82b31-build-forward-workdirs.sh" | tee "$AUDIT/build-final.log"

echo "=== closure-builder tests ===" | tee -a "$AUDIT/tests.log"
deno test --allow-read --allow-write --allow-run --no-check "$REPO/scripts/step82b31-closure-builder.test.ts" | tee -a "$AUDIT/tests.log"

echo "=== deploy-wrapper tests ===" | tee -a "$AUDIT/tests.log"
bash "$REPO/scripts/step82b31-deploy-wrapper.test.sh" | tee -a "$AUDIT/tests.log"

echo "=== behavioural + regression ===" | tee -a "$AUDIT/tests.log"
deno test --allow-read --allow-run --no-check --allow-env \
  "$REPO/supabase/functions/_shared/adminCaptureTripPaymentPreconditions.test.ts" \
  "$REPO/supabase/functions/_shared/adminCaptureTripPaymentSSOT.test.ts" \
  "$REPO/supabase/functions/_shared/adminCaptureTripPaymentOwnershipLock.test.ts" \
  "$REPO/supabase/functions/_shared/applyProviderRefundBehaviour.test.ts" \
  "$REPO/supabase/functions/_shared/applyProviderRefundAtomicBehaviour.test.ts" \
  "$REPO/supabase/functions/_shared/financeOwnershipLock.test.ts" \
  "$REPO/supabase/functions/_shared/applyCanonicalSettlementAfterCapture.test.ts" \
  "$REPO/supabase/functions/_shared/step82a2BundleBoot.test.ts" \
  | tee -a "$AUDIT/tests.log"

echo "ALL_STEP82B31_LOCAL_VALIDATION_PASS"
