#!/usr/bin/env bash
# CI guard: admin-new payout SSOT must stay aligned with drive-hub-buddy copies.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRIVER_REPO="${DRIVER_REPO:-$ROOT/../drive-hub-buddy}"
FILES=(
  "supabase/functions/_shared/payoutAvailability.ts"
  "supabase/functions/_shared/perDriverFinancialReconciliation.ts"
)

fail=0

per_driver="$ROOT/supabase/functions/_shared/perDriverFinancialReconciliation.ts"
if ! grep -q 'availablePayoutPence(walletBalance)' "$per_driver"; then
  echo "FAIL: admin perDriverFinancialReconciliation must use availablePayoutPence(walletBalance)"
  fail=1
fi
if grep -q 'perDriverAvailableNowPence' "$per_driver"; then
  echo "FAIL: legacy perDriverAvailableNowPence must not appear in admin perDriverFinancialReconciliation"
  fail=1
fi

if [[ ! -d "$DRIVER_REPO" ]]; then
  echo "WARN: drive-hub-buddy not found at $DRIVER_REPO — skipping cross-repo hash compare"
  if [[ "$fail" -ne 0 ]]; then exit 1; fi
  echo "OK: admin finance payout SSOT formula guard passed"
  exit 0
fi

for rel in "${FILES[@]}"; do
  admin_file="$ROOT/$rel"
  driver_file="$DRIVER_REPO/$rel"
  if [[ ! -f "$driver_file" ]]; then
    echo "FAIL: missing drive-hub-buddy file $rel"
    fail=1
    continue
  fi
  admin_hash=$(shasum -a 256 "$admin_file" | awk '{print $1}')
  driver_hash=$(shasum -a 256 "$driver_file" | awk '{print $1}')
  if [[ "$admin_hash" != "$driver_hash" ]]; then
    echo "FAIL: SSOT drift between admin-new and drive-hub-buddy for $rel"
    echo "  admin-new:       $admin_hash"
    echo "  drive-hub-buddy: $driver_hash"
    echo "  Copy admin-new → drive-hub-buddy and run drive-hub-buddy/scripts/update-finance-payout-ssot-lock.sh"
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "OK: admin-new and drive-hub-buddy finance payout SSOT files match"
