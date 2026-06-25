#!/usr/bin/env bash
# CI guard: Trip History must not own finance recovery — SSOT lives on Financial Reconciliation.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIP_HISTORY="$ROOT/src/pages/TripHistory.tsx"
fail=0

if [[ ! -f "$TRIP_HISTORY" ]]; then
  echo "FAIL: missing $TRIP_HISTORY" >&2
  exit 1
fi

if grep -n 'PaymentControlsCard' "$TRIP_HISTORY" >/dev/null 2>&1; then
  echo "FAIL: TripHistory must not import PaymentControlsCard directly — use FinanceRecoveryPanel only."
  fail=1
fi

if grep -nE "variant=['\"]finance['\"]" "$TRIP_HISTORY" >/dev/null 2>&1; then
  echo "FAIL: TripHistory must not use finance recovery variant."
  fail=1
fi

if ! grep -q 'FinanceRecoveryPanel' "$TRIP_HISTORY"; then
  echo "FAIL: TripHistory must render FinanceRecoveryPanel for capture mismatch guidance."
  fail=1
elif ! grep -q 'variant="summary"' "$TRIP_HISTORY"; then
  echo "FAIL: TripHistory FinanceRecoveryPanel must use variant=\"summary\" (read-only + link to SSOT)."
  fail=1
fi

if grep -nE 'admin-request-extra-payment|admin-edit-trip-fare' "$TRIP_HISTORY" >/dev/null 2>&1; then
  echo "FAIL: TripHistory must not invoke finance recovery edge functions directly."
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo ""
  echo "See docs/P0_FINANCE_RECOVERY_SSOT_MK_260624_001.md"
  exit 1
fi

echo "OK: Trip History finance recovery SSOT guard passed"
