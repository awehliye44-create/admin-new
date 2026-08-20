-- Step 8.2A.4 throwaway harness bootstrap (production-shaped subset).
-- Simulates live driver_wallet_ledger uniqueness before migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.payment_session_purpose AS ENUM ('RIDE_BOOKING', 'PAYMENT_RECOVERY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.payment_session_status AS ENUM ('authorised', 'captured', 'released', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.service_area_financial_model AS ENUM (
    'PLATFORM_COLLECTED', 'DRIVER_COLLECTED_COMMISSION_WALLET'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS public.trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid REFERENCES public.drivers(id),
  status text NOT NULL DEFAULT 'completed',
  payment_status text,
  financial_model public.service_area_financial_model NOT NULL DEFAULT 'PLATFORM_COLLECTED',
  capture_amount_pence integer,
  commission_pence integer,
  driver_net_pence integer,
  final_fare_pence integer,
  final_customer_fare_pence integer,
  refund_amount_pence integer DEFAULT 0,
  refund_reason text,
  refunded_at timestamptz,
  currency text DEFAULT 'GBP',
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payment_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid REFERENCES public.trips(id),
  purpose public.payment_session_purpose NOT NULL DEFAULT 'RIDE_BOOKING',
  payment_provider text NOT NULL DEFAULT 'revolut',
  status public.payment_session_status NOT NULL DEFAULT 'captured',
  captured_amount_pence integer,
  authorised_amount_pence integer,
  refunded_amount_pence integer DEFAULT 0,
  provider_order_id text,
  provider_refund_id text,
  currency text NOT NULL DEFAULT 'gbp',
  updated_at timestamptz DEFAULT now(),
  refunded_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.payment_session_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_session_id uuid NOT NULL REFERENCES public.payment_sessions(id) ON DELETE CASCADE,
  payment_provider text NOT NULL,
  provider_refund_id text NOT NULL,
  provider_payment_id text,
  amount_pence integer NOT NULL CHECK (amount_pence > 0),
  currency text NOT NULL DEFAULT 'gbp',
  status text NOT NULL DEFAULT 'confirmed',
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id),
  driver_id uuid,
  amount_pence integer NOT NULL DEFAULT 0,
  captured_amount_pence integer,
  refunded_amount_pence integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'GBP',
  status text,
  refund_status text,
  provider_refund_id text,
  last_error text,
  refunded_at timestamptz,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.trip_finance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL UNIQUE REFERENCES public.trips(id),
  driver_id uuid,
  refund_amount_pence integer NOT NULL DEFAULT 0,
  refund_status text,
  net_card_revenue_after_refund_pence integer,
  driver_wallet_reversal_pence integer,
  commission_reversal_pence integer,
  financial_status text,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.driver_wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  type text NOT NULL,
  amount_pence integer NOT NULL,
  currency text NOT NULL DEFAULT 'GBP',
  related_trip_id uuid REFERENCES public.trips(id),
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  service_area_id uuid,
  provider_payout_id text,
  provider_transfer_id text,
  CONSTRAINT driver_wallet_ledger_type_check CHECK (type = ANY (ARRAY[
    'TRIP_EARNING_NET', 'CASH_TRIP_EARNING', 'CASH_COMMISSION_DEBT',
    'DRIVER_TIP_CREDIT', 'TIP_CREDIT', 'PLATFORM_COMMISSION',
    'REFUND_DEBIT', 'LEDGER_REVERSAL', 'ADJUSTMENT', 'COMMISSION_RECOVERED',
    'DEBT_RECOVERY', 'OPS_DRIVER_COMPENSATION'
  ]))
);

-- Production-equivalent broad uniqueness (blocks multi REFUND_DEBIT per trip pre-migration).
CREATE UNIQUE INDEX IF NOT EXISTS unique_trip_ledger_entry
  ON public.driver_wallet_ledger (related_trip_id, type);

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_trip_earning_net_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'TRIP_EARNING_NET' AND related_trip_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_wallet_ledger_cash_debt_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'CASH_COMMISSION_DEBT';

CREATE OR REPLACE FUNCTION public.prevent_driver_wallet_ledger_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'driver_wallet_ledger is append-only';
END; $$;

DROP TRIGGER IF EXISTS trg_prevent_driver_wallet_ledger_delete ON public.driver_wallet_ledger;
CREATE TRIGGER trg_prevent_driver_wallet_ledger_delete
  BEFORE DELETE ON public.driver_wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION public.prevent_driver_wallet_ledger_delete();
