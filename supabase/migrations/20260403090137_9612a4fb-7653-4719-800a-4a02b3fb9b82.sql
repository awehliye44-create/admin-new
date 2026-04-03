
-- Force recalculate all driver wallets to sync cached balances
-- This runs recalculate_driver_wallet for every driver that has ledger entries
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT driver_id FROM driver_wallet_ledger
  LOOP
    PERFORM recalculate_driver_wallet(r.driver_id);
  END LOOP;
END;
$$;
