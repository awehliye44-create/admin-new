#!/usr/bin/env bash
# #92H controlled deploy of financial workers that embed the integrity fixes.
# Stage C must remain active. No Stage D. Fail-closed per-slug via wrapper.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${PROJECT_REF:-$(awk -F'"' '/project_id/ {print $2; exit}' "$ROOT/supabase/config.toml")}"
WRAPPER="$ROOT/scripts/step82b31-deploy-wrapper.sh"
SLUGS=(
  finalize-trip-and-capture
  process-trip-capture-jobs
  accept-offer
  create-trip-after-payment
  customer-fare-decision
  driver-fare-final
  admin-capture-trip-payment
  admin-trip-action
  request-trip-modification
  confirm-trip-modification-payment
  admin-increment-revolut-authorisation
  sweep-revolut-stale-holds
  stop-workflow
  capture-expired-tip-windows
)

echo "PROJECT_REF=$REF"
echo "Canonical SHA=$(git -C "$ROOT" rev-parse HEAD)"
for slug in "${SLUGS[@]}"; do
  echo "=== deploy $slug ==="
  bash "$WRAPPER" --slug "$slug" --project-ref "$REF" --workdir "$ROOT"
done
echo "ALL #92H financial worker deploys attempted"
