-- Add unique partial index on driver_wallet_ledger to prevent duplicate CASH_COMMISSION_DEBT entries per trip
CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_wallet_ledger_cash_debt_unique 
ON public.driver_wallet_ledger (related_trip_id) 
WHERE type = 'CASH_COMMISSION_DEBT';

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_driver_wallet_ledger_type ON public.driver_wallet_ledger (type);
CREATE INDEX IF NOT EXISTS idx_driver_wallet_ledger_driver_type ON public.driver_wallet_ledger (driver_id, type);