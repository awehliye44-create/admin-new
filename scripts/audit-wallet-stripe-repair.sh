#!/usr/bin/env bash
# Wallet ↔ Stripe audit and optional repair for Stripe-only payouts (missing ledger debit).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPAIR=false
DRY_RUN=false
FULL_AUDIT=false
PAYOUT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repair) REPAIR=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --full-audit) FULL_AUDIT=true; shift ;;
    --payout-id) PAYOUT_ID="${2:-}"; shift 2 ;;
    *) echo "ERROR: Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ "$REPAIR" == "true" && "$DRY_RUN" == "true" ]]; then
  echo "ERROR: --repair and --dry-run are mutually exclusive"
  exit 1
fi

if [[ "$FULL_AUDIT" == "true" && ( "$REPAIR" == "true" || "$DRY_RUN" == "true" ) ]]; then
  echo "ERROR: --full-audit cannot combine with --repair or --dry-run"
  exit 1
fi

echo "=== Driver Wallet / Stripe reconciliation audit ==="
echo "Repair mode: $REPAIR"
echo "Dry-run mode: $DRY_RUN"
echo "Full audit: $FULL_AUDIT"
echo ""

run_query() {
  local title="$1"
  local sql="$2"
  echo "--- $title ---"
  supabase db query --linked "$sql"
  echo ""
}

if [[ "$FULL_AUDIT" == "true" ]]; then
  if ! command -v supabase >/dev/null 2>&1; then
    echo "ERROR: supabase CLI required for full audit"
    exit 1
  fi
  echo "=== Phase 3 FULL SYSTEM AUDIT (read-only, no repair) ==="
  echo ""

  run_query "audit_summary_counts" "
SELECT check_type, COUNT(*)::int AS row_count
FROM (
  SELECT 'stripe_without_ledger' AS check_type
  FROM stripe_connect_payouts scp
  LEFT JOIN driver_wallet_ledger l ON l.stripe_payout_id = scp.payout_id AND l.driver_id = scp.driver_id
  WHERE scp.status = 'paid' AND l.id IS NULL
  UNION ALL
  SELECT 'ledger_without_stripe_sync'
  FROM driver_wallet_ledger l
  LEFT JOIN stripe_connect_payouts scp ON scp.payout_id = l.stripe_payout_id
  WHERE l.stripe_payout_id IS NOT NULL AND l.amount_pence < 0 AND scp.payout_id IS NULL
  UNION ALL
  SELECT 'local_only_failed'
  FROM payout_items pi
  WHERE pi.status IN ('failed', 'ledger_sync_failed')
    AND pi.stripe_transfer_id IS NULL AND pi.stripe_payout_id IS NULL
  UNION ALL
  SELECT 'failed_stuck_settlement'
  FROM payout_items pi
  WHERE pi.status IN ('failed', 'ledger_sync_failed')
    AND pi.settlement_status IN ('PROCESSING', 'READY', 'PENDING', 'AVAILABLE')
  UNION ALL
  SELECT 'settlement_paid_without_stripe'
  FROM driver_earning_settlement des
  JOIN payout_items pi ON pi.id = des.paid_in_payout_item_id
  WHERE des.settlement_lifecycle_status = 'PAID'
    AND pi.stripe_payout_id IS NULL AND pi.stripe_transfer_id IS NULL
) s
GROUP BY check_type
ORDER BY check_type;
"

  run_query "1_stripe_without_ledger" "
SELECT scp.payout_id, scp.connected_account_id, scp.driver_id,
  TRIM(CONCAT(d.first_name, ' ', d.last_name)) AS driver_name, d.driver_code,
  scp.amount_pence, scp.status, scp.initiated_at, scp.arrival_date
FROM stripe_connect_payouts scp
LEFT JOIN drivers d ON d.id = scp.driver_id
LEFT JOIN driver_wallet_ledger l ON l.stripe_payout_id = scp.payout_id AND l.driver_id = scp.driver_id
WHERE scp.status = 'paid' AND l.id IS NULL
ORDER BY scp.initiated_at DESC NULLS LAST;
"

  run_query "2_ledger_without_stripe_sync" "
SELECT l.id AS ledger_row_id, l.stripe_payout_id, l.driver_id,
  TRIM(CONCAT(d.first_name, ' ', d.last_name)) AS driver_name, d.driver_code,
  ABS(l.amount_pence) AS amount_pence, l.type, l.created_at
FROM driver_wallet_ledger l
LEFT JOIN drivers d ON d.id = l.driver_id
LEFT JOIN stripe_connect_payouts scp ON scp.payout_id = l.stripe_payout_id
WHERE l.stripe_payout_id IS NOT NULL AND l.amount_pence < 0 AND scp.payout_id IS NULL
ORDER BY l.created_at DESC;
"

  run_query "3_local_only_failed" "
SELECT pi.id AS payout_item_id, pi.driver_id,
  TRIM(CONCAT(d.first_name, ' ', d.last_name)) AS driver_name, d.driver_code,
  pi.net_driver_payout_pence, pi.status, pi.settlement_status, pi.failure_reason, pi.created_at
FROM payout_items pi
LEFT JOIN drivers d ON d.id = pi.driver_id
WHERE pi.status IN ('failed', 'ledger_sync_failed')
  AND pi.stripe_transfer_id IS NULL AND pi.stripe_payout_id IS NULL
ORDER BY pi.created_at DESC;
"

  run_query "4_failed_stuck_settlement" "
SELECT pi.id AS payout_item_id, pi.driver_id,
  TRIM(CONCAT(d.first_name, ' ', d.last_name)) AS driver_name, d.driver_code,
  pi.status, pi.settlement_status, pi.net_driver_payout_pence, pi.failure_reason, pi.created_at
FROM payout_items pi
LEFT JOIN drivers d ON d.id = pi.driver_id
WHERE pi.status IN ('failed', 'ledger_sync_failed')
  AND pi.settlement_status IN ('PROCESSING', 'READY', 'PENDING', 'AVAILABLE')
ORDER BY pi.created_at DESC;
"

  run_query "5_duplicate_connect" "
SELECT dr.stripe_account_id AS connected_account_id, COUNT(*)::int AS driver_count,
  json_agg(json_build_object('driver_id', dr.id, 'driver_code', dr.driver_code,
    'driver_name', TRIM(CONCAT(dr.first_name, ' ', dr.last_name))) ORDER BY dr.driver_code) AS drivers
FROM drivers dr
WHERE dr.stripe_account_id IS NOT NULL
GROUP BY dr.stripe_account_id
HAVING COUNT(*) > 1
ORDER BY driver_count DESC;
"

  run_query "6_settlement_paid_without_stripe_evidence" "
SELECT des.id AS settlement_id, des.driver_id,
  TRIM(CONCAT(d.first_name, ' ', d.last_name)) AS driver_name, d.driver_code,
  des.trip_id, des.settlement_status, des.settlement_lifecycle_status,
  des.paid_in_payout_item_id, pi.status AS payout_item_status,
  pi.stripe_transfer_id, pi.stripe_payout_id, pi.net_driver_payout_pence
FROM driver_earning_settlement des
JOIN payout_items pi ON pi.id = des.paid_in_payout_item_id
LEFT JOIN drivers d ON d.id = des.driver_id
WHERE des.settlement_lifecycle_status = 'PAID'
  AND pi.stripe_payout_id IS NULL AND pi.stripe_transfer_id IS NULL
ORDER BY des.id;
"

  echo "Full audit complete — no repair applied."
  exit 0
fi

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
  PAYOUT_ID_SQL="${PAYOUT_ID//\'/\'\'}"
  echo ""
  echo "--- Repair Stripe-only payout: $PAYOUT_ID ---"
  supabase db query --linked "
INSERT INTO driver_wallet_ledger (
  driver_id,
  type,
  amount_pence,
  stripe_payout_id,
  description,
  created_at
)
SELECT
  scp.driver_id,
  'WEEKLY_PAYOUT',
  -ABS(scp.amount_pence),
  scp.payout_id,
  'Repair: Stripe Connect payout missing ledger debit',
  COALESCE(scp.initiated_at, NOW())
FROM stripe_connect_payouts scp
LEFT JOIN driver_wallet_ledger l
  ON l.stripe_payout_id = scp.payout_id
  AND l.driver_id = scp.driver_id
WHERE scp.status = 'paid'
  AND scp.payout_id = '$PAYOUT_ID_SQL'
  AND l.id IS NULL
  AND scp.driver_id IS NOT NULL
RETURNING id, driver_id, type, amount_pence, stripe_payout_id;
"
  echo "Repair SQL applied for payout_id=$PAYOUT_ID"
fi

echo ""
echo "Live compare: deploy admin-continuous-reconciliation edge function"
