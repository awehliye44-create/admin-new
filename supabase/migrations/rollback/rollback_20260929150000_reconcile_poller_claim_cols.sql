-- ROLLBACK: 20260929150000_reconcile_poller_claim_cols.sql
-- Run this if migration must be reversed.
-- Safe to run multiple times (IF EXISTS guards throughout).

-- 1. Drop RPCs
DROP FUNCTION IF EXISTS public.claim_reconcile_payout_items(uuid, integer, interval, integer);
DROP FUNCTION IF EXISTS public.update_reconcile_attempt_meta(uuid, uuid, integer, text, text, timestamptz, boolean);

-- 2. Drop index
DROP INDEX IF EXISTS public.idx_dppi_poller_candidates;

-- 3. Drop columns (individual to avoid lock on unrelated columns)
ALTER TABLE driver_payout_payment_intents DROP COLUMN IF EXISTS reconcile_claim_token;
ALTER TABLE driver_payout_payment_intents DROP COLUMN IF EXISTS reconcile_claimed_at;
ALTER TABLE driver_payout_payment_intents DROP COLUMN IF EXISTS reconcile_claim_expires_at;
ALTER TABLE driver_payout_payment_intents DROP COLUMN IF EXISTS reconcile_attempt_count;
ALTER TABLE driver_payout_payment_intents DROP COLUMN IF EXISTS next_reconcile_at;
ALTER TABLE driver_payout_payment_intents DROP COLUMN IF EXISTS last_reconcile_at;
ALTER TABLE driver_payout_payment_intents DROP COLUMN IF EXISTS last_reconcile_provider_state;
ALTER TABLE driver_payout_payment_intents DROP COLUMN IF EXISTS last_reconcile_error;

-- 4. Remove from migration registry
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260929150000';

-- Verify rollback complete
SELECT 'claim_rpc_absent' AS check,
  (NOT EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_schema='public' AND routine_name='claim_reconcile_payout_items'))::text AS ok;
SELECT 'cols_absent' AS check,
  (NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='driver_payout_payment_intents' AND column_name='reconcile_claim_token'))::text AS ok;
