
-- Repair stale wallet cache by recalculating from ledger SSOT
UPDATE driver_wallets
SET available_pence = sub.available,
    lifetime_earned_pence = sub.lifetime,
    updated_at = now()
FROM (
  SELECT
    driver_id,
    COALESCE(SUM(amount_pence) FILTER (WHERE type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING')), 0) AS available,
    COALESCE(SUM(amount_pence) FILTER (WHERE amount_pence > 0 AND type NOT IN ('PLATFORM_COMMISSION', 'CASH_TRIP_EARNING')), 0) AS lifetime
  FROM driver_wallet_ledger
  GROUP BY driver_id
) sub
WHERE driver_wallets.driver_id = sub.driver_id
AND driver_wallets.available_pence != sub.available;
