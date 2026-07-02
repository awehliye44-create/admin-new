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
  PAYOUT_ID_SQL="${PAYOUT_ID//\'/\'\'}"
  echo "--- Phase 3 evidence (read-only): $PAYOUT_ID ---"
  supabase db query --linked "
SELECT
  scp.payout_id,
  scp.connected_account_id,
  scp.driver_id,
  TRIM(CONCAT(d.first_name, ' ', d.last_name)) AS driver_name,
  scp.amount_pence AS stripe_payout_amount_pence,
  scp.status AS stripe_payout_status,
  scp.initiated_at AS stripe_payout_created_at,
  scp.arrival_date AS stripe_payout_arrival_date,
  (l.id IS NOT NULL) AS backend_wallet_debit_exists,
  COALESCE(
    (SELECT json_agg(pi.id ORDER BY pi.created_at)
     FROM payout_items pi WHERE pi.stripe_payout_id = scp.payout_id),
    '[]'::json
  ) AS payout_item_ids,
  COALESCE(
    (SELECT json_agg(des.id ORDER BY des.created_at)
     FROM driver_earning_settlement des
     JOIN payout_items pi ON pi.id = des.paid_in_payout_item_id
     WHERE pi.stripe_payout_id = scp.payout_id),
    '[]'::json
  ) AS settlement_ids,
  COALESCE(
    (SELECT json_agg(l2.id ORDER BY l2.created_at)
     FROM driver_wallet_ledger l2 WHERE l2.stripe_payout_id = scp.payout_id),
    '[]'::json
  ) AS ledger_row_ids,
  CASE WHEN scp.status = 'paid' AND l.id IS NULL THEN scp.amount_pence ELSE 0 END AS amount_needing_repair_pence
FROM stripe_connect_payouts scp
LEFT JOIN drivers d ON d.id = scp.driver_id
LEFT JOIN driver_wallet_ledger l ON l.stripe_payout_id = scp.payout_id AND l.driver_id = scp.driver_id
WHERE scp.payout_id = '$PAYOUT_ID_SQL';
"
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
