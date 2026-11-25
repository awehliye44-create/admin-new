-- #92H — Publish driver wallet tables to supabase_realtime so clients can
-- receive automatic earnings updates after settlement (no manual refresh).
-- Does not change clearing period, commission, or payout eligibility rules.
-- Client subscription / React Query invalidation remains registered under #94.

BEGIN;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.driver_wallet_ledger;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN
    RAISE NOTICE 'supabase_realtime publication missing — skip ledger add';
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.driver_wallets;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN
    RAISE NOTICE 'supabase_realtime publication missing — skip wallets add';
END $$;

-- FULL replica identity so filtered UPDATE payloads include driver_id.
ALTER TABLE public.driver_wallet_ledger REPLICA IDENTITY FULL;
ALTER TABLE public.driver_wallets REPLICA IDENTITY FULL;

COMMENT ON TABLE public.driver_wallet_ledger IS
  'Driver platform wallet ledger. Realtime-published (#92H). Clearing/eligibility unchanged.';

COMMIT;
