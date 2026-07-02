#!/usr/bin/env bash
# Wallet ↔ Stripe audit and optional repair for Stripe-only payouts (missing ledger debit).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPAIR=false
DRY_RUN=false
PAYOUT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repair) REPAIR=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --payout-id) PAYOUT_ID="${2:-}"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ "$REPAIR" == "true" && "$DRY_RUN" == "true" ]]; then
  echo "ERROR: --repair and --dry-run are mutually exclusive"
  exit 1
fi

echo "=== Driver Wallet / Stripe reconciliation audit ==="
echo "Repair mode: $REPAIR"
echo "Dry-run mode: $DRY_RUN"
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  if [[ -z "$PAYOUT_ID" ]]; then
    echo "ERROR: --dry-run requires --payout-id po_xxx"
    exit 1
  fi
  if ! command -v supabase >/dev/null 2>&1; then
    echo "ERROR: supabase CLI required for dry-run evidence"
    exit 1
  fi
  echo "--- Phase 3 evidence (read-only): $PAYOUT_ID ---"
  supabase db query --linked -v payout_id="$PAYOUT_ID" < "$ROOT/scripts/sql/wallet-stripe-evidence-payout.sql"
  echo ""
  echo "Dry-run complete — no repair applied."
  exit 0
fi

if command -v supabase >/dev/null 2>&1; then
  echo "--- Read-only audit (linked project) ---"
  supabase db query --linked < "$ROOT/scripts/sql/wallet-stripe-audit.sql" || true
else
  echo "supabase CLI not found — run scripts/sql/wallet-stripe-audit.sql manually"
fi

if [[ "$REPAIR" == "true" ]]; then
  if [[ -z "$PAYOUT_ID" ]]; then
    echo "ERROR: --repair requires --payout-id po_xxx (single payout, evidence required)"
    exit 1
  fi
  if ! command -v supabase >/dev/null 2>&1; then
    echo "ERROR: supabase CLI required for repair"
    exit 1
  fi
  echo ""
  echo "--- Repair Stripe-only payout: $PAYOUT_ID ---"
  supabase db query --linked -v payout_id="$PAYOUT_ID" < "$ROOT/scripts/sql/wallet-stripe-repair-stripe-only.sql"
  echo "Repair SQL applied for payout_id=$PAYOUT_ID"
fi

echo ""
echo "Live compare: deploy admin-continuous-reconciliation edge function"
