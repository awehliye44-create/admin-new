-- Repair: backfill WEEKLY_PAYOUT ledger debit for a paid Stripe Connect payout missing from ledger.
-- Usage: pass payout_id as psql variable, e.g. psql -v payout_id=po_xxx -f wallet-stripe-repair-stripe-only.sql
\set ON_ERROR_STOP on

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
  AND scp.payout_id = :'payout_id'
  AND l.id IS NULL
  AND scp.driver_id IS NOT NULL;
