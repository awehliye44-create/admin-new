-- Company payees + automatic payment schedules (Payout Ledger Company Transfers SSOT).
-- Never stores plaintext bank details in API responses; encrypted columns only.
-- Never consumes driver_wallet_ledger.

-- ---------------------------------------------------------------------------
-- 1) Expand transfer statuses / categories support columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.company_outgoing_transfers
  DROP CONSTRAINT IF EXISTS company_outgoing_transfers_status_check;

ALTER TABLE public.company_outgoing_transfers
  ADD CONSTRAINT company_outgoing_transfers_status_check
  CHECK (status IN (
    'DRAFT',
    'AWAITING_APPROVAL',
    'APPROVED',
    'REJECTED',
    'DECLINED',
    'SCHEDULED',
    'PROCESSING',
    'PAID',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'REVERTED',
    'FUNDING_UNAVAILABLE'
  ));

ALTER TABLE public.company_outgoing_transfers
  ADD COLUMN IF NOT EXISTS payee_id uuid,
  ADD COLUMN IF NOT EXISTS approved_amount_pence integer,
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_reference text,
  ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'DRAFT_FOR_APPROVAL'
    CHECK (execution_mode IN ('DRAFT_FOR_APPROVAL', 'DIRECT_TRANSFER')),
  ADD COLUMN IF NOT EXISTS revolut_counterparty_id text,
  ADD COLUMN IF NOT EXISTS revolut_recipient_account_id text,
  ADD COLUMN IF NOT EXISTS provider_transaction_id text,
  ADD COLUMN IF NOT EXISTS provider_state text,
  ADD COLUMN IF NOT EXISTS provider_created_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_failure_code text,
  ADD COLUMN IF NOT EXISTS provider_failure_reason text,
  ADD COLUMN IF NOT EXISTS last_provider_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS execution_attempt integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS schedule_id uuid,
  ADD COLUMN IF NOT EXISTS schedule_period_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_company_outgoing_transfers_schedule_period
  ON public.company_outgoing_transfers (schedule_id, schedule_period_key)
  WHERE schedule_id IS NOT NULL AND schedule_period_key IS NOT NULL
    AND status NOT IN ('CANCELLED', 'DECLINED', 'REJECTED');

-- ---------------------------------------------------------------------------
-- 2) Company payees
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_payees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  payee_type text NOT NULL
    CHECK (payee_type IN (
      'STAFF',
      'DIRECTOR',
      'CONTRACTOR',
      'SUPPLIER',
      'EXPENSE_CLAIMANT',
      'OTHER'
    )),
  email text,
  phone text,
  currency text NOT NULL DEFAULT 'GBP',
  country text NOT NULL DEFAULT 'GB',
  payment_purpose text,
  default_reference text,
  revolut_counterparty_id text,
  revolut_recipient_account_id text,
  account_holder_name text,
  bank_name text,
  sort_code_encrypted text,
  account_number_encrypted text,
  iban_encrypted text,
  masked_account text NOT NULL DEFAULT '••••',
  account_fingerprint text NOT NULL,
  account_verification_status text NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (account_verification_status IN (
      'UNVERIFIED',
      'PENDING',
      'VERIFIED',
      'FAILED',
      'REVOKED'
    )),
  active boolean NOT NULL DEFAULT true,
  paused boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  service_area_id uuid REFERENCES public.service_areas(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_company_payees_fingerprint UNIQUE (account_fingerprint, currency)
);

CREATE INDEX IF NOT EXISTS idx_company_payees_type_active
  ON public.company_payees (payee_type, active, paused);
CREATE INDEX IF NOT EXISTS idx_company_payees_verification
  ON public.company_payees (account_verification_status);

ALTER TABLE public.company_outgoing_transfers
  DROP CONSTRAINT IF EXISTS company_outgoing_transfers_payee_id_fkey;
ALTER TABLE public.company_outgoing_transfers
  ADD CONSTRAINT company_outgoing_transfers_payee_id_fkey
  FOREIGN KEY (payee_id) REFERENCES public.company_payees(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 3) Automatic payment schedules per payee
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_payee_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payee_id uuid NOT NULL REFERENCES public.company_payees(id) ON DELETE CASCADE,
  automatic_enabled boolean NOT NULL DEFAULT false,
  frequency text NOT NULL
    CHECK (frequency IN ('WEEKLY', 'FORTNIGHTLY', 'MONTHLY', 'CUSTOM')),
  weekly_day text,
  monthly_day integer CHECK (monthly_day IS NULL OR (monthly_day >= 1 AND monthly_day <= 28)),
  local_processing_time text NOT NULL DEFAULT '12:00',
  timezone text NOT NULL DEFAULT 'Europe/London',
  fixed_amount_pence integer CHECK (fixed_amount_pence IS NULL OR fixed_amount_pence > 0),
  use_approved_payable_amount boolean NOT NULL DEFAULT false,
  maximum_amount_pence integer CHECK (maximum_amount_pence IS NULL OR maximum_amount_pence > 0),
  start_date date,
  end_date date,
  approval_required boolean NOT NULL DEFAULT true,
  insufficient_funds_action text NOT NULL DEFAULT 'SKIP'
    CHECK (insufficient_funds_action IN ('SKIP', 'RETRY_NEXT', 'ALERT_ONLY')),
  category text NOT NULL DEFAULT 'STAFF_SALARY',
  payment_reference_template text,
  execution_mode text NOT NULL DEFAULT 'DRAFT_FOR_APPROVAL'
    CHECK (execution_mode IN ('DRAFT_FOR_APPROVAL', 'DIRECT_TRANSFER')),
  next_run_at timestamptz,
  next_run_at_local text,
  last_run_at timestamptz,
  last_period_key text,
  paused boolean NOT NULL DEFAULT false,
  schedule_version text NOT NULL DEFAULT 'company_payee_schedule_v1',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_payee_schedules_next_run
  ON public.company_payee_schedules (automatic_enabled, paused, next_run_at)
  WHERE automatic_enabled = true AND paused = false;

ALTER TABLE public.company_outgoing_transfers
  DROP CONSTRAINT IF EXISTS company_outgoing_transfers_schedule_id_fkey;
ALTER TABLE public.company_outgoing_transfers
  ADD CONSTRAINT company_outgoing_transfers_schedule_id_fkey
  FOREIGN KEY (schedule_id) REFERENCES public.company_payee_schedules(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 4) RLS — service role / edge only (admin gate in edge functions)
-- ---------------------------------------------------------------------------
ALTER TABLE public.company_payees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_payee_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_payees_admin_select ON public.company_payees;
CREATE POLICY company_payees_admin_select ON public.company_payees
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('admin', 'moderator')
    )
  );

DROP POLICY IF EXISTS company_payee_schedules_admin_select ON public.company_payee_schedules;
CREATE POLICY company_payee_schedules_admin_select ON public.company_payee_schedules
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('admin', 'moderator')
    )
  );

-- Writes go through service-role edge functions only (no INSERT/UPDATE/DELETE policies for authenticated).

COMMENT ON TABLE public.company_payees IS
  'ONECAB company transfer beneficiaries. Bank details encrypted at rest; API returns masked_account only.';
COMMENT ON TABLE public.company_payee_schedules IS
  'Automatic company payment schedules. next_run_at computed in backend from timezone/day/time SSOT.';
