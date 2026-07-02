#!/usr/bin/env bash
# Read-only audit: wallet ↔ Stripe linkage gaps. Run repair only with --repair flag.
set -euo pipefail

REPAIR=false
if [[ "${1:-}" == "--repair" ]]; then
  REPAIR=true
  echo "REPAIR MODE — will only apply when evidence is unambiguous (not implemented in CI)."
fi

echo "=== Driver Wallet / Stripe reconciliation audit (read-only) ==="
echo "Repair mode: $REPAIR"
echo ""
echo "Checks:"
echo "  1. Stripe payout in stripe_connect_payouts without ledger WEEKLY_PAYOUT/MANUAL_PAYOUT debit"
echo "  2. Ledger stripe_payout_id without stripe_connect_payouts row"
echo "  3. Failed payout_items with PROCESSING/READY settlement_status"
echo "  4. Failed payout_items without stripe_transfer_id or stripe_payout_id (local_only)"
echo "  5. Duplicate stripe_account_id on drivers"
echo ""
echo "Run against production with: supabase db query --linked < scripts/sql/wallet-stripe-audit.sql"
echo "See: supabase/functions/admin-continuous-reconciliation for live Stripe compare."
