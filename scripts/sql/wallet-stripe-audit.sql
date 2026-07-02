-- Read-only wallet ↔ Stripe audit queries (Phase 3)
-- Stripe payout without ledger debit
SELECT 'stripe_without_ledger' AS check_type, scp.payout_id, scp.driver_id, scp.amount_pence, scp.initiated_at
FROM stripe_connect_payouts scp
LEFT JOIN driver_wallet_ledger l ON l.stripe_payout_id = scp.payout_id AND l.driver_id = scp.driver_id
WHERE scp.status = 'paid' AND l.id IS NULL;

-- Ledger debit without stripe_connect_payouts
SELECT 'ledger_without_stripe_sync' AS check_type, l.stripe_payout_id, l.driver_id, ABS(l.amount_pence) AS amount_pence
FROM driver_wallet_ledger l
LEFT JOIN stripe_connect_payouts scp ON scp.payout_id = l.stripe_payout_id
WHERE l.stripe_payout_id IS NOT NULL AND l.amount_pence < 0 AND scp.payout_id IS NULL;

-- Failed payouts stuck in processing/ready
SELECT 'failed_stuck_settlement' AS check_type, id, driver_id, status, settlement_status, net_driver_payout_pence
FROM payout_items
WHERE status IN ('failed', 'ledger_sync_failed')
  AND settlement_status IN ('PROCESSING', 'READY', 'PENDING', 'AVAILABLE');

-- Local-only failed payouts
SELECT 'local_only_failed' AS check_type, id, driver_id, net_driver_payout_pence, failure_reason
FROM payout_items
WHERE status IN ('failed', 'ledger_sync_failed')
  AND stripe_transfer_id IS NULL AND stripe_payout_id IS NULL;

-- Duplicate Connect accounts
SELECT 'duplicate_connect' AS check_type, stripe_account_id, COUNT(*) AS driver_count
FROM drivers WHERE stripe_account_id IS NOT NULL
GROUP BY stripe_account_id HAVING COUNT(*) > 1;
