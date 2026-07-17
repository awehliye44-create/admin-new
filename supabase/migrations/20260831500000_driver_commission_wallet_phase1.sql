-- P0 Phase 1 — Africa Driver Commission Wallet (schema only).
-- Feature DISABLED everywhere: defaults keep PLATFORM_COLLECTED workflow unchanged.
-- Do NOT wire dispatch, booking, deduction, or UI in this migration.

-- ── Enums ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.service_area_financial_model AS ENUM (
    'PLATFORM_COLLECTED',
    'DRIVER_COLLECTED_COMMISSION_WALLET'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.customer_payment_policy AS ENUM (
    'PLATFORM_PREPAID',
    'DRIVER_COLLECTS_UPFRONT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.commission_wallet_entry_type AS ENUM (
    'TOP_UP_CREDIT',
    'WELCOME_CREDIT',
    'PROMOTIONAL_CREDIT',
    'ADMIN_CREDIT',
    'COMMISSION_RESERVE',
    'COMMISSION_RESERVE_RELEASE',
    'COMMISSION_DEDUCTION',
    'COMMISSION_DEDUCTION_REVERSAL',
    'TOP_UP_REVERSAL',
    'ADMIN_CORRECTION'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.commission_wallet_campaign_type AS ENUM (
    'WELCOME_CREDIT',
    'TOP_UP_PERCENT_BONUS',
    'FIXED_TOP_UP_BONUS',
    'MANUAL_PROMOTIONAL_CREDIT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.commission_topup_status AS ENUM (
    'PENDING',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'EXPIRED',
    'REVERSED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Service Area configuration (SSOT assignment — never infer from country) ──
ALTER TABLE public.service_areas
  ADD COLUMN IF NOT EXISTS financial_model public.service_area_financial_model
    NOT NULL DEFAULT 'PLATFORM_COLLECTED',
  ADD COLUMN IF NOT EXISTS commission_wallet_enabled boolean
    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS commission_wallet_currency text,
  ADD COLUMN IF NOT EXISTS commission_topup_provider text,
  ADD COLUMN IF NOT EXISTS commission_wallet_minimum_balance_minor integer
    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_reserve_enabled boolean
    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS customer_payment_policy public.customer_payment_policy
    NOT NULL DEFAULT 'PLATFORM_PREPAID',
  ADD COLUMN IF NOT EXISTS cash_upfront_policy_notice text,
  ADD COLUMN IF NOT EXISTS welcome_credit_enabled boolean
    NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS welcome_credit_amount_minor integer
    NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS welcome_credit_max_drivers integer
    NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.service_areas.financial_model IS
  'PLATFORM_COLLECTED (UK/EU default) | DRIVER_COLLECTED_COMMISSION_WALLET (Africa opt-in only).';
COMMENT ON COLUMN public.service_areas.commission_wallet_enabled IS
  'Must be true AND financial_model=DRIVER_COLLECTED_COMMISSION_WALLET to use Commission Wallet.';

-- Isolation invariant: wallet cannot be "enabled" under PLATFORM_COLLECTED.
ALTER TABLE public.service_areas
  DROP CONSTRAINT IF EXISTS service_areas_commission_wallet_model_consistency;
ALTER TABLE public.service_areas
  ADD CONSTRAINT service_areas_commission_wallet_model_consistency
  CHECK (
    (
      financial_model = 'PLATFORM_COLLECTED'
      AND commission_wallet_enabled = false
      AND commission_reserve_enabled = false
    )
    OR (
      financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
    )
  );

-- ── Trip financial model snapshot (written only when Africa booking path is enabled later) ──
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS financial_model public.service_area_financial_model,
  ADD COLUMN IF NOT EXISTS payment_collection_model public.customer_payment_policy,
  ADD COLUMN IF NOT EXISTS commission_wallet_enabled boolean,
  ADD COLUMN IF NOT EXISTS snapshotted_commission_rate_bps integer,
  ADD COLUMN IF NOT EXISTS snapshotted_commission_currency text;

COMMENT ON COLUMN public.trips.financial_model IS
  'Frozen at booking create. NULL = legacy PLATFORM_COLLECTED behaviour.';

-- ── Immutable Commission Wallet ledger (separate from driver_wallet_ledger) ──
CREATE TABLE IF NOT EXISTS public.driver_commission_wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  service_area_id uuid NOT NULL REFERENCES public.service_areas(id),
  region_id uuid REFERENCES public.regions(id),
  currency text NOT NULL,
  entry_type public.commission_wallet_entry_type NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  direction text NOT NULL CHECK (direction IN ('credit', 'debit')),
  trip_id uuid REFERENCES public.trips(id),
  topup_id uuid,
  campaign_id uuid,
  provider text,
  provider_transaction_id text,
  admin_user_id uuid,
  reason text,
  promotional_portion_minor integer NOT NULL DEFAULT 0 CHECK (promotional_portion_minor >= 0),
  purchased_portion_minor integer NOT NULL DEFAULT 0 CHECK (purchased_portion_minor >= 0),
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_commission_wallet_ledger_idempotency_uidx
  ON public.driver_commission_wallet_ledger (idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS driver_commission_wallet_ledger_provider_txn_uidx
  ON public.driver_commission_wallet_ledger (provider, provider_transaction_id)
  WHERE provider IS NOT NULL AND provider_transaction_id IS NOT NULL;

-- One COMMISSION_DEDUCTION per trip
CREATE UNIQUE INDEX IF NOT EXISTS driver_commission_wallet_ledger_trip_deduction_uidx
  ON public.driver_commission_wallet_ledger (trip_id)
  WHERE entry_type = 'COMMISSION_DEDUCTION' AND trip_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS driver_commission_wallet_ledger_driver_sa_idx
  ON public.driver_commission_wallet_ledger (driver_id, service_area_id, created_at DESC);

-- Append-only: no UPDATE/DELETE
CREATE OR REPLACE FUNCTION public.prevent_commission_wallet_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'driver_commission_wallet_ledger is append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_commission_wallet_ledger_update
  ON public.driver_commission_wallet_ledger;
CREATE TRIGGER trg_prevent_commission_wallet_ledger_update
  BEFORE UPDATE ON public.driver_commission_wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION public.prevent_commission_wallet_ledger_mutation();

DROP TRIGGER IF EXISTS trg_prevent_commission_wallet_ledger_delete
  ON public.driver_commission_wallet_ledger;
CREATE TRIGGER trg_prevent_commission_wallet_ledger_delete
  BEFORE DELETE ON public.driver_commission_wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION public.prevent_commission_wallet_ledger_mutation();

-- ── Top-up requests (credited only by backend on provider confirmation — Phase 4+) ──
CREATE TABLE IF NOT EXISTS public.driver_commission_wallet_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  service_area_id uuid NOT NULL REFERENCES public.service_areas(id),
  region_id uuid REFERENCES public.regions(id),
  currency text NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  provider text NOT NULL,
  provider_transaction_id text,
  status public.commission_topup_status NOT NULL DEFAULT 'PENDING',
  idempotency_key text NOT NULL,
  credited_ledger_entry_id uuid REFERENCES public.driver_commission_wallet_ledger(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_commission_wallet_topups_idempotency_uidx
  ON public.driver_commission_wallet_topups (idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS driver_commission_wallet_topups_provider_txn_uidx
  ON public.driver_commission_wallet_topups (provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

ALTER TABLE public.driver_commission_wallet_ledger
  DROP CONSTRAINT IF EXISTS driver_commission_wallet_ledger_topup_fk;
ALTER TABLE public.driver_commission_wallet_ledger
  ADD CONSTRAINT driver_commission_wallet_ledger_topup_fk
  FOREIGN KEY (topup_id) REFERENCES public.driver_commission_wallet_topups(id);

-- Unique topup_id + entry_type (e.g. one TOP_UP_CREDIT per topup)
CREATE UNIQUE INDEX IF NOT EXISTS driver_commission_wallet_ledger_topup_entry_uidx
  ON public.driver_commission_wallet_ledger (topup_id, entry_type)
  WHERE topup_id IS NOT NULL;

-- ── Campaigns (Phase 5; table only) ──
CREATE TABLE IF NOT EXISTS public.commission_wallet_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_name text NOT NULL,
  service_area_id uuid NOT NULL REFERENCES public.service_areas(id),
  currency text NOT NULL,
  campaign_type public.commission_wallet_campaign_type NOT NULL,
  credit_amount_minor integer NOT NULL DEFAULT 0,
  bonus_percent numeric(8, 4),
  minimum_topup_amount_minor integer NOT NULL DEFAULT 0,
  maximum_bonus_amount_minor integer,
  maximum_claims integer,
  maximum_claims_per_driver integer NOT NULL DEFAULT 1,
  eligible_driver_status text,
  start_at timestamptz,
  end_at timestamptz,
  active boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.driver_commission_wallet_ledger
  DROP CONSTRAINT IF EXISTS driver_commission_wallet_ledger_campaign_fk;
ALTER TABLE public.driver_commission_wallet_ledger
  ADD CONSTRAINT driver_commission_wallet_ledger_campaign_fk
  FOREIGN KEY (campaign_id) REFERENCES public.commission_wallet_campaigns(id);

-- ── Active reserves (Phase 6; table only — no writers yet) ──
CREATE TABLE IF NOT EXISTS public.driver_commission_wallet_reserves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  service_area_id uuid NOT NULL REFERENCES public.service_areas(id),
  trip_id uuid NOT NULL REFERENCES public.trips(id),
  currency text NOT NULL,
  reserved_amount_minor integer NOT NULL CHECK (reserved_amount_minor > 0),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'released', 'converted_to_deduction')),
  reserve_ledger_entry_id uuid REFERENCES public.driver_commission_wallet_ledger(id),
  release_ledger_entry_id uuid REFERENCES public.driver_commission_wallet_ledger(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (driver_id, trip_id)
);

-- ── Isolation helper: workflow active only when explicitly assigned ──
CREATE OR REPLACE FUNCTION public.is_commission_wallet_workflow_enabled(p_service_area_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.service_areas sa
    WHERE sa.id = p_service_area_id
      AND sa.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET'
      AND sa.commission_wallet_enabled = true
  );
$$;

COMMENT ON FUNCTION public.is_commission_wallet_workflow_enabled(uuid) IS
  'SSOT gate: never infer from country/currency. Requires explicit SA assignment.';

-- RLS: service role / authenticated read patterns — Phase 2+ expands; lock down writes.
ALTER TABLE public.driver_commission_wallet_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_commission_wallet_topups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_wallet_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_commission_wallet_reserves ENABLE ROW LEVEL SECURITY;

-- Drivers can read their own ledger/topups/reserves (no write policies = service role only writes)
DROP POLICY IF EXISTS commission_wallet_ledger_driver_read ON public.driver_commission_wallet_ledger;
CREATE POLICY commission_wallet_ledger_driver_read
  ON public.driver_commission_wallet_ledger
  FOR SELECT
  TO authenticated
  USING (
    driver_id IN (SELECT id FROM public.drivers WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS commission_wallet_topups_driver_read ON public.driver_commission_wallet_topups;
CREATE POLICY commission_wallet_topups_driver_read
  ON public.driver_commission_wallet_topups
  FOR SELECT
  TO authenticated
  USING (
    driver_id IN (SELECT id FROM public.drivers WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS commission_wallet_reserves_driver_read ON public.driver_commission_wallet_reserves;
CREATE POLICY commission_wallet_reserves_driver_read
  ON public.driver_commission_wallet_reserves
  FOR SELECT
  TO authenticated
  USING (
    driver_id IN (SELECT id FROM public.drivers WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS commission_wallet_campaigns_auth_read ON public.commission_wallet_campaigns;
CREATE POLICY commission_wallet_campaigns_auth_read
  ON public.commission_wallet_campaigns
  FOR SELECT
  TO authenticated
  USING (true);

-- Prove Phase 1 defaults: every existing SA stays PLATFORM_COLLECTED + wallet disabled.
-- (DEFAULT handles new rows; backfill any nulls if columns were added without NOT NULL in older attempts)
UPDATE public.service_areas
SET
  financial_model = COALESCE(financial_model, 'PLATFORM_COLLECTED'),
  commission_wallet_enabled = COALESCE(commission_wallet_enabled, false),
  commission_reserve_enabled = COALESCE(commission_reserve_enabled, false),
  customer_payment_policy = COALESCE(customer_payment_policy, 'PLATFORM_PREPAID')
WHERE true;
