-- Phase 0d local bootstrap — minimal schema for payout RPC integration tests.
-- Apply on isolated Postgres (not production). Includes roles + stub helpers.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO service_role;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

CREATE TABLE IF NOT EXISTS public.drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id),
  first_name text,
  last_name text,
  email text,
  region_id uuid,
  payouts_enabled boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid REFERENCES public.drivers(id),
  financial_model text,
  status text,
  financial_outcome text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.driver_wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  related_trip_id uuid REFERENCES public.trips(id),
  type text NOT NULL,
  amount_pence integer NOT NULL,
  currency text DEFAULT 'GBP',
  description text,
  provider_payout_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payout_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  run_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'ITEMS_CREATED',
  total_drivers integer DEFAULT 0,
  total_amount_pence integer DEFAULT 0,
  currency text DEFAULT 'GBP',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payout_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES public.payout_batches(id),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  amount_pence integer NOT NULL,
  net_driver_payout_pence integer,
  status text NOT NULL DEFAULT 'VALIDATED',
  execution_status text DEFAULT 'VALIDATED',
  currency text DEFAULT 'GBP',
  ledger_entry_id uuid,
  provider_reference text,
  provider_payout_id text,
  eligibility_snapshot jsonb DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  ledger_sync_error text,
  error_message text,
  wallet_recalculated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payout_item_ledger_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_item_id uuid NOT NULL REFERENCES public.payout_items(id),
  ledger_entry_id uuid NOT NULL REFERENCES public.driver_wallet_ledger(id),
  amount_pence integer NOT NULL CHECK (amount_pence > 0),
  allocated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.driver_payout_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_item_id uuid NOT NULL REFERENCES public.payout_items(id),
  payout_batch_id uuid NOT NULL REFERENCES public.payout_batches(id),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  wallet_account_id uuid NOT NULL DEFAULT gen_random_uuid(),
  reservation_type text NOT NULL DEFAULT 'DRIVER_PAYOUT',
  amount_pence integer NOT NULL CHECK (amount_pence > 0),
  currency text NOT NULL DEFAULT 'GBP',
  status text NOT NULL DEFAULT 'ACTIVE',
  idempotency_key text NOT NULL,
  reservation_fingerprint text NOT NULL,
  debit_ledger_entry_id uuid,
  provider_payment_id text,
  completion_idempotency_key text,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.driver_payout_payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_item_id uuid NOT NULL REFERENCES public.payout_items(id),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  amount_pence integer NOT NULL,
  currency text NOT NULL DEFAULT 'GBP',
  execution_status text NOT NULL DEFAULT 'SUBMITTED',
  provider_payment_id text,
  provider_state text,
  provider_completed_at timestamptz,
  financially_applied_at timestamptz,
  financial_application_ledger_entry_id uuid,
  completion_evidence_redacted jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_payment_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL,
  provider text,
  provider_payment_id text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.commission_wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  trip_id uuid REFERENCES public.trips(id),
  entry_type text NOT NULL,
  amount_pence integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.driver_wallets (
  driver_id uuid PRIMARY KEY REFERENCES public.drivers(id),
  available_pence bigint DEFAULT 0,
  pending_pence bigint DEFAULT 0,
  lifetime_earned_pence bigint DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

-- Stub wallet recalc for RPC tests
CREATE OR REPLACE FUNCTION public.recalculate_driver_wallet(p_driver_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.driver_wallets (driver_id, available_pence, pending_pence, lifetime_earned_pence, updated_at)
  SELECT p_driver_id,
         COALESCE(SUM(amount_pence), 0),
         0,
         COALESCE(SUM(CASE WHEN amount_pence > 0 THEN amount_pence ELSE 0 END), 0),
         now()
  FROM public.driver_wallet_ledger WHERE driver_id = p_driver_id
  ON CONFLICT (driver_id) DO UPDATE SET
    available_pence = EXCLUDED.available_pence,
    lifetime_earned_pence = EXCLUDED.lifetime_earned_pence,
    updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.payout_batch_kind_to_ledger_type(p_kind text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_kind = 'EARLY_CASHOUT' THEN 'EARLY_CASHOUT'
    WHEN p_kind = 'WEEKLY_MONDAY' THEN 'WEEKLY_PAYOUT'
    WHEN p_kind = 'MANUAL_ADMIN' THEN 'MANUAL_PAYOUT'
    ELSE 'PAYOUT'
  END;
$$;

-- Minimal driver_financial_summary for model-scoped view migration
CREATE OR REPLACE VIEW public.driver_financial_summary AS
SELECT
  d.id AS driver_id,
  d.first_name,
  d.last_name,
  d.email,
  d.region_id,
  COALESCE(SUM(dwl.amount_pence), 0)::bigint AS wallet_balance_pence
FROM public.drivers d
LEFT JOIN public.driver_wallet_ledger dwl ON dwl.driver_id = d.id
GROUP BY d.id, d.first_name, d.last_name, d.email, d.region_id;

COMMIT;
