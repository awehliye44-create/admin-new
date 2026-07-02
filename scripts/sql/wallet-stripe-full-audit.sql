-- Phase 3 full-system read-only audit (all drivers/payouts)
-- Run via: bash scripts/audit-wallet-stripe-repair.sh --full-audit

\echo '=== 1_stripe_without_ledger ==='
SELECT
  'stripe_without_ledger' AS check_type,
  scp.payout_id,
  scp.connected_account_id,
  scp.driver_id,
  TRIM(CONCAT(d.first_name, ' ', d.last_name)) AS driver_name,
  d.driver_code,
  scp.amount_pence,
  scp.status,
  scp.initiated_at,
  scp.arrival_date
FROM stripe_connect_payouts scp
LEFT JOIN drivers d ON d.id = scp.driver_id
LEFT JOIN driver_wallet_ledger l
  ON l.stripe_payout_id = scp.payout_id AND l.driver_id = scp.driver_id
WHERE scp.status = 'paid' AND l.id IS NULL
ORDER BY scp.initiated_at DESC NULLS LAST;

\echo '=== 2_ledger_without_stripe_sync ==='
SELECT
  'ledger_without_stripe_sync' AS check_type,
  l.id AS ledger_row_id,
  l.stripe_payout_id,
  l.driver_id,
  TRIM(CONCAT(d.first_name, ' ', d.last_name)) AS driver_name,
  d.driver_code,
  ABS(l.amount_pence) AS amount_pence,
  l.type,
  l.created_at
FROM driver_wallet_ledger l
LEFT JOIN drivers d ON d.id = l.driver_id
LEFT JOIN stripe_connect_payouts scp ON scp.payout_id = l.stripe_payout_id
WHERE l.stripe_payout_id IS NOT NULL
  AND l.amount_pence < 0
  AND scp.payout_id IS NULL
ORDER BY l.created_at DESC;

\echo '=== 3_local_only_failed ==='
SELECT
  'local_only_failed' AS check_type,
  pi.id AS payout_item_id,
  pi.driver_id,
  TRIM(CONCAT(d.first_name, ' ', d.last_name)) AS driver_name,
  d.driver_code,
  pi.net_driver_payout_pence,
  pi.status,
  pi.settlement_status,
  pi.failure_reason,
  pi.created_at
FROM payout_items pi
LEFT JOIN drivers d ON d.id = pi.driver_id
WHERE pi.status IN ('failed', 'ledger_sync_failed')
  AND pi.stripe_transfer_id IS NULL
  AND pi.stripe_payout_id IS NULL
ORDER BY pi.created_at DESC;

\echo '=== 4_failed_stuck_settlement ==='
SELECT
  'failed_stuck_settlement' AS check_type,
  pi.id AS payout_item_id,
  pi.driver_id,
  TRIM(CONCAT(d.first_name, ' ', d.last_name)) AS driver_name,
  d.driver_code,
  pi.status,
  pi.settlement_status,
  pi.net_driver_payout_pence,
  pi.failure_reason,
  pi.created_at
FROM payout_items pi
LEFT JOIN drivers d ON d.id = pi.driver_id
WHERE pi.status IN ('failed', 'ledger_sync_failed')
  AND pi.settlement_status IN ('PROCESSING', 'READY', 'PENDING', 'AVAILABLE')
ORDER BY pi.created_at DESC;

\echo '=== 5_duplicate_connect ==='
SELECT
  'duplicate_connect' AS check_type,
  dr.stripe_account_id AS connected_account_id,
  COUNT(*) AS driver_count,
  json_agg(json_build_object(
    'driver_id', dr.id,
    'driver_code', dr.driver_code,
    'driver_name', TRIM(CONCAT(dr.first_name, ' ', dr.last_name))
  ) ORDER BY dr.driver_code) AS drivers
FROM drivers dr
WHERE dr.stripe_account_id IS NOT NULL
GROUP BY dr.stripe_account_id
HAVING COUNT(*) > 1
ORDER BY driver_count DESC;

\echo '=== 6_settlement_paid_without_stripe_evidence ==='
SELECT
  'settlement_paid_without_stripe' AS check_type,
  des.id AS settlement_id,
  des.driver_id,
  TRIM(CONCAT(d.first_name, ' ', d.last_name)) AS driver_name,
  d.driver_code,
  des.trip_id,
  des.settlement_status,
  des.settlement_lifecycle_status,
  des.paid_in_payout_item_id,
  pi.status AS payout_item_status,
  pi.stripe_transfer_id,
  pi.stripe_payout_id,
  pi.net_driver_payout_pence
FROM driver_earning_settlement des
JOIN payout_items pi ON pi.id = des.paid_in_payout_item_id
LEFT JOIN drivers d ON d.id = des.driver_id
WHERE des.settlement_lifecycle_status = 'PAID'
  AND pi.stripe_payout_id IS NULL
  AND pi.stripe_transfer_id IS NULL
ORDER BY des.id;

\echo '=== audit_summary_counts ==='
SELECT check_type, COUNT(*) AS row_count
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
  SELECT 'duplicate_connect'
  FROM drivers dr
  WHERE dr.stripe_account_id IS NOT NULL
  GROUP BY dr.stripe_account_id HAVING COUNT(*) > 1
  UNION ALL
  SELECT 'settlement_paid_without_stripe'
  FROM driver_earning_settlement des
  JOIN payout_items pi ON pi.id = des.paid_in_payout_item_id
  WHERE des.settlement_lifecycle_status = 'PAID'
    AND pi.stripe_payout_id IS NULL AND pi.stripe_transfer_id IS NULL
) s
GROUP BY check_type
ORDER BY check_type;
