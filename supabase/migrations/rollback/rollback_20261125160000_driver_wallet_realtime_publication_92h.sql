BEGIN;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.driver_wallet_ledger;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.driver_wallets;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE public.driver_wallet_ledger REPLICA IDENTITY DEFAULT;
ALTER TABLE public.driver_wallets REPLICA IDENTITY DEFAULT;

COMMIT;
