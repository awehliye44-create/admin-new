
-- 1. Wipe all test ledger entries (SSOT for finance)
DELETE FROM driver_wallet_ledger;

-- 2. Reset cached wallet balances to zero
UPDATE driver_wallets SET available_pence = 0, updated_at = now();

-- 3. Reset financial_outcome on trips so they can be re-recorded
UPDATE trips SET financial_outcome = NULL WHERE financial_outcome IS NOT NULL;
