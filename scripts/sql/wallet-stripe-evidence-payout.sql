-- Phase 3 dry-run evidence for a single Stripe Connect payout (read-only).
-- Variable: payout_id (psql -v payout_id=po_xxx)

\set ON_ERROR_STOP on

\echo '=== payout_evidence ==='
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
     FROM payout_items pi
     WHERE pi.stripe_payout_id = scp.payout_id),
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
     FROM driver_wallet_ledger l2
     WHERE l2.stripe_payout_id = scp.payout_id),
    '[]'::json
  ) AS ledger_row_ids,
  CASE
    WHEN scp.status = 'paid' AND l.id IS NULL THEN scp.amount_pence
    ELSE 0
  END AS amount_needing_repair_pence
FROM stripe_connect_payouts scp
LEFT JOIN drivers d ON d.id = scp.driver_id
LEFT JOIN driver_wallet_ledger l
  ON l.stripe_payout_id = scp.payout_id
  AND l.driver_id = scp.driver_id
WHERE scp.payout_id = :'payout_id';

\echo '=== ledger_rows_detail ==='
SELECT id, driver_id, type, amount_pence, stripe_payout_id, description, created_at
FROM driver_wallet_ledger
WHERE stripe_payout_id = :'payout_id'
ORDER BY created_at;

\echo '=== payout_items_detail ==='
SELECT id, driver_id, status, settlement_status, net_driver_payout_pence, stripe_payout_id, batch_id, created_at
FROM payout_items
WHERE stripe_payout_id = :'payout_id'
ORDER BY created_at;

\echo '=== settlements_detail ==='
SELECT des.id, des.trip_id, des.settlement_status, des.allocated_to_payout, des.paid_in_payout_item_id
FROM driver_earning_settlement des
JOIN payout_items pi ON pi.id = des.paid_in_payout_item_id
WHERE pi.stripe_payout_id = :'payout_id'
ORDER BY des.created_at;
