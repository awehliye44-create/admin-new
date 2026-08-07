-- =============================================================================
-- DEPLOYMENT C — Stripe schema drop (GATED)
-- =============================================================================
-- DO NOT APPLY until:
--   1) Deployment A (Revolut lifecycle repair) is production-proven
--   2) Explicit owner approval for schema drop
--   3) Repo-wide + deployed-bundle search proves zero readers/writers
--
-- This migration aborts unless the session GUC is set:
--   SET app.allow_stripe_schema_drop = 'true';
--
-- Secrets (STRIPE_*) are NOT deleted here — see
-- docs/STRIPE_SECRET_DELETION_DEPLOYMENT_D.md (separate approval).
-- =============================================================================

DO $$
BEGIN
  IF current_setting('app.allow_stripe_schema_drop', true) IS DISTINCT FROM 'true' then
    RAISE EXCEPTION
      'GATED: Stripe schema drop blocked. Set app.allow_stripe_schema_drop=true after Deployment A proven + explicit approval.';
  END IF;
END $$;

-- Drop Stripe-only tables (order: dependents first)
DROP TABLE IF EXISTS public.processed_stripe_events CASCADE;
DROP TABLE IF EXISTS public.stripe_connect_payouts CASCADE;

-- Drop Stripe Connect / audit cache tables if present (names may vary by env)
DROP TABLE IF EXISTS public.stripe_connect_account_cache CASCADE;
DROP TABLE IF EXISTS public.stripe_connect_balance_cache CASCADE;
DROP TABLE IF EXISTS public.stripe_connect_audit_events CASCADE;

-- trips.stripe_* columns
ALTER TABLE IF EXISTS public.trips
  DROP COLUMN IF EXISTS stripe_payment_intent_id,
  DROP COLUMN IF EXISTS stripe_charge_id,
  DROP COLUMN IF EXISTS stripe_refund_id,
  DROP COLUMN IF EXISTS stripe_application_fee_id,
  DROP COLUMN IF EXISTS stripe_application_fee_amount_pence,
  DROP COLUMN IF EXISTS stripe_destination_account_id,
  DROP COLUMN IF EXISTS stripe_transfer_id,
  DROP COLUMN IF EXISTS stripe_transfer_amount_pence,
  DROP COLUMN IF EXISTS stripe_processing_fee_pence,
  DROP COLUMN IF EXISTS stripe_settlement_verified,
  DROP COLUMN IF EXISTS stripe_settlement_warning;

-- payments.stripe_*
ALTER TABLE IF EXISTS public.payments
  DROP COLUMN IF EXISTS stripe_payment_intent_id,
  DROP COLUMN IF EXISTS stripe_charge_id,
  DROP COLUMN IF EXISTS stripe_refund_id,
  DROP COLUMN IF EXISTS stripe_fee_pence;

-- drivers.stripe_account_id
ALTER TABLE IF EXISTS public.drivers
  DROP COLUMN IF EXISTS stripe_account_id;

-- driver_wallet_ledger / payout_items stripe_*
ALTER TABLE IF EXISTS public.driver_wallet_ledger
  DROP COLUMN IF EXISTS stripe_payout_id,
  DROP COLUMN IF EXISTS stripe_transfer_id,
  DROP COLUMN IF EXISTS stripe_balance_transaction_id;

ALTER TABLE IF EXISTS public.payout_items
  DROP COLUMN IF EXISTS stripe_payout_id,
  DROP COLUMN IF EXISTS stripe_transfer_id;

-- Disable Stripe-named cron / RPCs if they still exist (safe IF EXISTS)
DROP FUNCTION IF EXISTS public.sync_stripe_connect_payouts() CASCADE;
DROP FUNCTION IF EXISTS public.process_stripe_webhook_event(jsonb) CASCADE;
