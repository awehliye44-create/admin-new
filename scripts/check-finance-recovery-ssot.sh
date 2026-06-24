#!/usr/bin/env bash
# CI guard: Trip History must not own finance recovery — SSOT lives on Financial Reconciliation.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src"

if ! command -v rg >/dev/null 2>&1; then
  echo "ripgrep (rg) is required" >&2
  exit 1
fi

TRIP_HISTORY="$SRC/pages/TripHistory.tsx"
fail=0

if rg -n 'PaymentControlsCard' "$TRIP_HISTORY" 2>/dev/null; then
  echo "FAIL: TripHistory must not import PaymentControlsCard directly — use FinanceRecoveryPanel only."
  fail=1
fi

if rg -n "variant=['\"]finance['\"]" "$TRIP_HISTORY" 2>/dev/null; then
  echo "FAIL: TripHistory must not use finance recovery variant."
  fail=1
fi

if ! rg -q 'FinanceRecoveryPanel' "$TRIP_HISTORY" 2>/dev/null; then
  echo "FAIL: TripHistory must render FinanceRecoveryPanel for capture mismatch guidance."
  fail=1
elif ! rg -q 'variant="summary"' "$TRIP_HISTORY" 2>/dev/null; then
  echo "FAIL: TripHistory FinanceRecoveryPanel must use variant=\"summary\" (read-only + link to SSOT)."
  fail=1
fi

if rg -n "admin-request-extra-payment|admin-edit-trip-fare" "$TRIP_HISTORY" 2>/dev/null; then
  echo "FAIL: TripHistory must not invoke finance recovery edge functions directly."
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  echo ""
  echo "See docs/P0_FINANCE_RECOVERY_SSOT_MK_260624_001.md"
  exit 1
fi

echo "OK: Trip History finance recovery SSOT guard passed"
