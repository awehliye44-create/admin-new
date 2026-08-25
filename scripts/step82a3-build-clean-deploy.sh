#!/usr/bin/env bash
# Step 8.2A.3 — clean Phase 1 deploy worktrees (excludes MK-007/recovery/unrelated dirty files).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/.deploy-step82a3-clean"
rm -rf "$OUT"
mkdir -p "$OUT/workdirs"

copy_fn() {
  local slug="$1"
  local dest="$OUT/workdirs/$slug"
  mkdir -p "$dest/supabase/functions/$slug" "$dest/supabase/functions/_shared"
  cp "$REPO/supabase/functions/$slug/index.ts" "$dest/supabase/functions/$slug/"
  cp "$REPO/supabase/functions/deno.json" "$dest/supabase/functions/" 2>/dev/null || true
  cp "$REPO/supabase/config.toml" "$dest/supabase/" 2>/dev/null || true
}

copy_fn admin-capture-trip-payment
copy_fn admin-refund-trip-payment
copy_fn revolut-capture-order

# Shared closure for Step 8.2A.3 refund/capture paths only
SHARED=(
  adminCaptureTripPaymentSSOT.ts
  adminCaptureTripPaymentPreconditions.ts
  adminPaymentGate.ts
  applyProviderRefund.ts
  providerRefundSSOT.ts
  paymentSessionCaptureGateSSOT.ts
  paymentSessionSSOT.ts
  revolutOrders.ts
  tripPaymentProviderSSOT.ts
  commissionWalletSSOT.ts
  persistConfirmedProviderCapture.ts
)
for f in "${SHARED[@]}"; do
  cp "$REPO/supabase/functions/_shared/$f" "$OUT/workdirs/admin-refund-trip-payment/supabase/functions/_shared/"
  cp "$REPO/supabase/functions/_shared/$f" "$OUT/workdirs/admin-capture-trip-payment/supabase/functions/_shared/"
  cp "$REPO/supabase/functions/_shared/$f" "$OUT/workdirs/revolut-capture-order/supabase/functions/_shared/" 2>/dev/null || true
done

mkdir -p "$OUT/migrations"
cp "$REPO/supabase/migrations/20260930150000_provider_refund_ledger_idempotency.sql" "$OUT/migrations/"
cp "$REPO/supabase/migrations/rollback/rollback_20260930150000_provider_refund_ledger_idempotency.sql" "$OUT/migrations/"

echo "Clean deploy worktrees: $OUT"
