#!/usr/bin/env bash
# CI guard: Admin modified-fare display must use shared SSOT — never page-local final+mod.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fail=0

say_fail() {
  echo "FAIL: $1" >&2
  fail=1
}

# Frontend + Edge live preview copies must stay identical.
if ! diff -q "$ROOT/src/lib/liveTripFareSSOT.ts" "$ROOT/supabase/functions/_shared/liveTripFareSSOT.ts" >/dev/null 2>&1; then
  say_fail "src/lib/liveTripFareSSOT.ts diverged from supabase/functions/_shared/liveTripFareSSOT.ts"
fi

for page in ActiveTrips MissedCancelled ScheduledRides; do
  f="$ROOT/src/pages/${page}.tsx"
  if [[ ! -f "$f" ]]; then
    say_fail "missing $f"
    continue
  fi
  if ! grep -q "adminTripCommittedFareDisplay" "$f"; then
    say_fail "${page}.tsx must import adminTripCommittedFareDisplay SSOT"
  fi
done

MC="$ROOT/src/pages/MissedCancelled.tsx"
SR="$ROOT/src/pages/ScheduledRides.tsx"
AT="$ROOT/src/pages/ActiveTrips.tsx"

if grep -nE '\(trip\.estimated_fare|estimated_fare\s*\?\?|estimated_fare\s*\|\|' "$MC" | grep -vE 'select\(|interface|type |estimated_fare:' >/dev/null 2>&1; then
  say_fail "MissedCancelled must not display raw estimated_fare"
fi

if grep -nE '\(trip\.estimated_fare|estimated_fare\s*\?\?|estimated_fare\s*\|\|' "$SR" | grep -vE 'select\(|interface|type |estimated_fare:' >/dev/null 2>&1; then
  say_fail "ScheduledRides must not display raw estimated_fare"
fi

if ! grep -q "resolveAdminActiveTripLiveFarePence\|toLiveTripFarePreviewInput" "$AT"; then
  say_fail "ActiveTrips must route live fare through adminTripCommittedFareDisplay helpers"
fi

if grep -q "resolvePayableFarePence" "$AT"; then
  say_fail "ActiveTrips must not call resolvePayableFarePence directly — use adminTripCommittedFareDisplay"
fi

TH="$ROOT/src/pages/TripHistory.tsx"
if ! grep -q "adminTripCommittedFareDisplay" "$TH"; then
  say_fail "TripHistory must resolve payable via adminTripCommittedFareDisplay SSOT entry"
fi
if grep -nE 'estimated_fare.*toFixed|trip\.estimated_fare\s*\*' "$TH" >/dev/null 2>&1; then
  say_fail "TripHistory must not display raw estimated_fare for payable"
fi
if grep -q "resolveCanonicalFinalPayablePence" "$TH"; then
  say_fail "TripHistory must not call resolveCanonicalFinalPayablePence directly — use adminTripCommittedFareDisplay"
fi

SSOT="$ROOT/src/lib/liveTripFareSSOT.ts"
if ! grep -q "resolveApprovedModificationDeltaPence" "$SSOT"; then
  say_fail "liveTripFareSSOT missing resolveApprovedModificationDeltaPence"
fi
if grep -q "confirmedFare + modStored" "$SSOT"; then
  say_fail "liveTripFareSSOT must not default to confirmedFare + modStored"
fi

if [[ "$fail" -ne 0 ]]; then
  exit 1
fi

echo "OK: Admin modified-fare SSOT guard passed"
