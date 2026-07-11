-- Provider fee configuration + immutable fee snapshots for commission control.
-- Provider fees are external costs — never ONECAB revenue.

CREATE TABLE IF NOT EXISTS public.provider_fee_configurations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_area_id uuid REFERENCES public.service_areas(id) ON DELETE CASCADE,
  currency_code text NOT NULL DEFAULT 'GBP',
  collection_provider text NOT NULL,
  payment_method text NOT NULL DEFAULT 'card',
  card_origin text,
  card_type text,
  fee_type text NOT NULL DEFAULT 'percentage_plus_fixed',
  percentage_fee_bps integer NOT NULL DEFAULT 0 CHECK (percentage_fee_bps >= 0),
  fixed_fee_pence integer NOT NULL DEFAULT 0 CHECK (fixed_fee_pence >= 0),
  vat_treatment text,
  version text NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  notes text,
  UNIQUE (service_area_id, currency_code, collection_provider, payment_method, version)
);

CREATE INDEX IF NOT EXISTS provider_fee_configurations_active_idx
  ON public.provider_fee_configurations (service_area_id, collection_provider, payment_method, is_active, effective_from DESC);

COMMENT ON TABLE public.provider_fee_configurations IS
  'Versioned payment-provider acquiring fee schedules. Historical payment snapshots must never be rewritten when config changes.';

-- Immutable fee snapshot columns on Payment Sessions (SSOT for customer payment fees).
ALTER TABLE public.payment_sessions
  ADD COLUMN IF NOT EXISTS provider_fee_percentage_snapshot_pence integer,
  ADD COLUMN IF NOT EXISTS provider_fixed_fee_snapshot_pence integer,
  ADD COLUMN IF NOT EXISTS provider_fee_total_snapshot_pence integer,
  ADD COLUMN IF NOT EXISTS provider_fee_currency_snapshot text,
  ADD COLUMN IF NOT EXISTS provider_fee_version_snapshot text,
  ADD COLUMN IF NOT EXISTS provider_fee_source text,
  ADD COLUMN IF NOT EXISTS provider_fee_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_name_snapshot text;

COMMENT ON COLUMN public.payment_sessions.provider_fee_total_snapshot_pence IS
  'Immutable provider fee total (pence) captured at process/reconcile time. Never recalculate from later config.';

-- Append-only fee adjustments (estimated → confirmed delta). Never overwrite history.
CREATE TABLE IF NOT EXISTS public.provider_fee_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_session_id uuid NOT NULL REFERENCES public.payment_sessions(id) ON DELETE CASCADE,
  trip_id uuid REFERENCES public.trips(id) ON DELETE SET NULL,
  previous_fee_pence integer NOT NULL,
  confirmed_fee_pence integer NOT NULL,
  adjustment_pence integer NOT NULL,
  previous_status text,
  new_status text NOT NULL DEFAULT 'CONFIRMED',
  provider_transaction_id text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE INDEX IF NOT EXISTS provider_fee_adjustments_session_idx
  ON public.provider_fee_adjustments (payment_session_id, created_at DESC);

COMMENT ON TABLE public.provider_fee_adjustments IS
  'Append-only provider fee corrections. Do not silently overwrite payment_sessions fee history.';

-- Expand wallet ledger allowed types for commission/fee separation (future writers).
-- Keep existing PLATFORM_COMMISSION for backward compatibility (gross mirror).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'driver_wallet_ledger_type_check'
  ) THEN
    ALTER TABLE public.driver_wallet_ledger DROP CONSTRAINT driver_wallet_ledger_type_check;
  END IF;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.driver_wallet_ledger
    ADD CONSTRAINT driver_wallet_ledger_type_check CHECK (
      type = ANY (ARRAY[
        'TRIP_EARNING_NET'::text,
        'TRIP_CREDIT'::text,
        'CASH_TRIP_EARNING'::text,
        'PLATFORM_COMMISSION'::text,
        'PLATFORM_COMMISSION_GROSS'::text,
        'PLATFORM_COMMISSION_NET'::text,
        'PAYMENT_PROVIDER_FEE'::text,
        'PAYMENT_PROVIDER_FEE_ADJUSTMENT'::text,
        'COMMISSION_REVERSAL'::text,
        'PROVIDER_FEE_REVERSAL'::text,
        'COMPANY_COMMISSION'::text,
        'CASH_COMMISSION_DEBT'::text,
        'DEBT_RECOVERY'::text,
        'COMMISSION_RECOVERED'::text,
        'BONUS'::text,
        'PROMOTION'::text,
        'INCENTIVE'::text,
        'ADJUSTMENT'::text,
        'MANUAL_CREDIT'::text,
        'MANUAL_DEBIT'::text,
        'MANUAL_ADJUSTMENT'::text,
        'CORRECTION'::text,
        'ADMIN_CORRECTION'::text,
        'REFUND_DEBIT'::text,
        'CHARGEBACK_DEBIT'::text,
        'WEEKLY_PAYOUT'::text,
        'EARLY_CASHOUT'::text,
        'MANUAL_PAYOUT'::text,
        'PAYOUT'::text,
        'PAYOUT_CREATED'::text,
        'CASHOUT_FEE'::text,
        'PAYOUT_FAILED_RETURN'::text,
        'PAYOUT_REVERSAL'::text,
        'LEDGER_REVERSAL'::text,
        'DRIVER_TIP_CREDIT'::text,
        'TIP_CREDIT'::text
      ])
    );
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.provider_fee_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_fee_adjustments ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  CREATE POLICY provider_fee_configurations_admin_all
    ON public.provider_fee_configurations
    FOR ALL
    TO authenticated
    USING (
      EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
      )
      OR EXISTS (
        SELECT 1 FROM public.staff_profiles sp
        WHERE sp.user_id = auth.uid() AND sp.is_active = true
      )
    )
    WITH CHECK (
      EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
      )
      OR EXISTS (
        SELECT 1 FROM public.staff_profiles sp
        WHERE sp.user_id = auth.uid() AND sp.is_active = true
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE POLICY provider_fee_adjustments_admin_all
    ON public.provider_fee_adjustments
    FOR ALL
    TO authenticated
    USING (
      EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
      )
      OR EXISTS (
        SELECT 1 FROM public.staff_profiles sp
        WHERE sp.user_id = auth.uid() AND sp.is_active = true
      )
    )
    WITH CHECK (
      EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = auth.uid() AND ur.role = 'admin'
      )
      OR EXISTS (
        SELECT 1 FROM public.staff_profiles sp
        WHERE sp.user_id = auth.uid() AND sp.is_active = true
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Seed a default Revolut GB card fee version if none exists (1.00% + £0.20).
INSERT INTO public.provider_fee_configurations (
  service_area_id,
  currency_code,
  collection_provider,
  payment_method,
  fee_type,
  percentage_fee_bps,
  fixed_fee_pence,
  version,
  effective_from,
  is_active,
  notes
)
SELECT
  sa.id,
  COALESCE(sa.currency_code, 'GBP'),
  'revolut',
  'card',
  'percentage_plus_fixed',
  100,
  20,
  'REVOLUT_GB_V1',
  now(),
  true,
  'Default Revolut acquiring fee seed — replace with confirmed commercial terms'
FROM public.service_areas sa
WHERE sa.is_active = true
  AND NOT EXISTS (
    SELECT 1 FROM public.provider_fee_configurations c
    WHERE c.service_area_id = sa.id
      AND c.collection_provider = 'revolut'
      AND c.payment_method = 'card'
      AND c.version = 'REVOLUT_GB_V1'
  );
