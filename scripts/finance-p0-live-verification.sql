-- ONECAB Finance P0 — live production verification queries
-- Run after each phase. Financial Reconciliation is SSOT.

-- =============================================================================
-- PHASE 1 — Live card capture proof (MK0002)
-- Run immediately after a successful post-deploy card trip completes.
-- =============================================================================

-- 1a. Ledger entries for capture + recovery
SELECT type, amount_pence, description, created_at
FROM driver_wallet_ledger
WHERE driver_id = 'cd8bae4c-3827-4b90-98c6-10be70eb0e52'
  AND type IN ('DEBT_RECOVERY','COMMISSION_RECOVERED','TRIP_EARNING_NET','DRIVER_TIP_CREDIT')
ORDER BY created_at DESC
LIMIT 20;

-- 1b. Pass criteria:
--   - Exactly one TRIP_EARNING_NET for the new trip_id
--   - DRIVER_TIP_CREDIT only if tip > 0
--   - DEBT_RECOVERY negative if cash commission debt existed before capture
--   - COMMISSION_RECOVERED positive, same abs amount as DEBT_RECOVERY
--   - No duplicate rows per (trip_id, type)

-- 1c. Owed to ONECAB must reduce by DEBT_RECOVERY only (not double-count COMMISSION_RECOVERED)
SELECT
  COALESCE(SUM(CASE WHEN type = 'CASH_COMMISSION_DEBT' THEN ABS(amount_pence) END), 0) AS cash_debt,
  COALESCE(SUM(CASE WHEN type = 'DEBT_RECOVERY' THEN ABS(amount_pence) END), 0) AS debt_recovery,
  GREATEST(
    COALESCE(SUM(CASE WHEN type = 'CASH_COMMISSION_DEBT' THEN ABS(amount_pence) END), 0)
    - COALESCE(SUM(CASE WHEN type = 'DEBT_RECOVERY' THEN ABS(amount_pence) END), 0),
    0
  ) AS owed_ssot
FROM driver_wallet_ledger
WHERE driver_id = 'cd8bae4c-3827-4b90-98c6-10be70eb0e52';

-- 1d. Compare admin view
SELECT driver_code, amount_owed_to_onecab, wallet_balance, cash_commission_debits
FROM driver_financial_summary dfs
JOIN drivers d ON d.id = dfs.driver_id
WHERE d.driver_code = 'MK0002';

-- 1e. Global: any post-deploy DEBT_RECOVERY?
SELECT COUNT(*) AS debt_recovery_since_deploy
FROM driver_wallet_ledger
WHERE type = 'DEBT_RECOVERY'
  AND created_at >= '2026-06-15';

-- =============================================================================
-- PHASE 2 — Manual payout audit
-- =============================================================================

SELECT pb.id, pb.kind, pb.status, pb.total_amount_pence, pb.failure_code, pb.failure_reason,
  (SELECT COUNT(*) FROM payout_items pi WHERE pi.batch_id = pb.id) AS item_count
FROM payout_batches pb
WHERE pb.kind = 'MANUAL_ADMIN'
ORDER BY pb.created_at DESC
LIMIT 5;

SELECT pi.id, pi.status, pi.settlement_status, pi.failure_code, pi.failure_reason,
  pi.amount_pence, pi.stripe_transfer_id
FROM payout_items pi
JOIN payout_batches pb ON pb.id = pi.batch_id
WHERE pb.kind = 'MANUAL_ADMIN'
ORDER BY pi.created_at DESC
LIMIT 5;

SELECT id, type, amount_pence, description, created_at
FROM driver_wallet_ledger
WHERE type = 'PAYOUT_CREATED'
ORDER BY created_at DESC
LIMIT 5;

-- =============================================================================
-- PHASE 3 — Monday settlement dry-run audit
-- =============================================================================

SELECT pb.id, pb.kind, pb.status, pb.total_amount_pence, pb.failure_reason,
  (SELECT COUNT(*) FROM payout_items pi WHERE pi.batch_id = pb.id) AS item_count,
  (SELECT COALESCE(SUM(pi.amount_pence), 0) FROM payout_items pi WHERE pi.batch_id = pb.id) AS items_sum
FROM payout_batches pb
WHERE pb.kind = 'WEEKLY_MONDAY'
ORDER BY pb.created_at DESC
LIMIT 5;

-- =============================================================================
-- INVARIANTS (always)
-- =============================================================================

-- No unreversed phantom credits on capture_failed card trips
SELECT COUNT(*) AS unreversed_phantom_count
FROM driver_wallet_ledger l
INNER JOIN trips t ON t.id = l.related_trip_id
WHERE l.type IN ('TRIP_EARNING_NET','DRIVER_TIP_CREDIT')
  AND l.amount_pence > 0
  AND UPPER(COALESCE(t.payment_method,'')) <> 'CASH'
  AND (t.payment_status = 'capture_failed' OR EXISTS (
    SELECT 1 FROM payments p WHERE p.trip_id = t.id AND p.status = 'capture_failed'
  ))
  AND NOT EXISTS (
    SELECT 1 FROM driver_wallet_ledger rev
    WHERE rev.related_trip_id = t.id AND rev.type = 'LEDGER_REVERSAL'
  );

-- No silent orphan batches
SELECT pb.id, pb.status, pb.total_amount_pence, pb.failure_code
FROM payout_batches pb
WHERE pb.total_amount_pence > 0
  AND NOT EXISTS (SELECT 1 FROM payout_items pi WHERE pi.batch_id = pb.id)
  AND pb.status <> 'INVALID_ORPHANED';
