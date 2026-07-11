-- Payout Ledger company outgoing transfers (SSOT).
-- Separate from driver payout_items / driver_wallet_ledger. Never consume driver wallet.

CREATE TABLE IF NOT EXISTS public.company_outgoing_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_ref text NOT NULL UNIQUE,
  recipient_name text NOT NULL,
  recipient_type text NOT NULL,
  category text NOT NULL,
  money_source text NOT NULL
    CHECK (money_source IN ('COMPANY_BALANCE', 'APPROVED_COMPANY_PAYABLE')),
  source_account text,
  destination_account text,
  amount_pence integer NOT NULL CHECK (amount_pence > 0),
  currency text NOT NULL DEFAULT 'GBP',
  purpose text NOT NULL,
  service_area_id uuid REFERENCES public.service_areas(id) ON DELETE SET NULL,
  cost_centre text,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approval_count integer NOT NULL DEFAULT 0,
  approvals_required integer NOT NULL DEFAULT 1,
  provider text,
  provider_reference text,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN (
      'DRAFT',
      'AWAITING_APPROVAL',
      'APPROVED',
      'REJECTED',
      'SCHEDULED',
      'PROCESSING',
      'PAID',
      'FAILED',
      'CANCELLED'
    )),
  execution_at timestamptz,
  failure_reason text,
  provider_error text,
  retry_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  notes text,
  attachment_url text,
  batch_id uuid,
  idempotency_key text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_outgoing_transfers_status_created
  ON public.company_outgoing_transfers (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_outgoing_transfers_category
  ON public.company_outgoing_transfers (category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_outgoing_transfers_batch
  ON public.company_outgoing_transfers (batch_id)
  WHERE batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.company_outgoing_transfer_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES public.company_outgoing_transfers(id) ON DELETE CASCADE,
  approver_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, approver_id)
);

CREATE TABLE IF NOT EXISTS public.company_outgoing_transfer_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES public.company_outgoing_transfers(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  old_status text,
  new_status text,
  provider text,
  provider_reference text,
  amount_pence integer,
  currency text,
  reason text,
  attachment_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_outgoing_transfer_audit_transfer
  ON public.company_outgoing_transfer_audit (transfer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.company_outgoing_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_ref text NOT NULL UNIQUE,
  batch_type text NOT NULL DEFAULT 'COMPANY',
  provider text,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN (
      'DRAFT',
      'SCHEDULED',
      'PROCESSING',
      'PARTIALLY_COMPLETED',
      'COMPLETED',
      'FAILED',
      'CANCELLED'
    )),
  transfer_count integer NOT NULL DEFAULT 0,
  success_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms integer,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.company_outgoing_transfers
  DROP CONSTRAINT IF EXISTS company_outgoing_transfers_batch_id_fkey;
ALTER TABLE public.company_outgoing_transfers
  ADD CONSTRAINT company_outgoing_transfers_batch_id_fkey
  FOREIGN KEY (batch_id) REFERENCES public.company_outgoing_batches(id) ON DELETE SET NULL;

ALTER TABLE public.company_outgoing_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_outgoing_transfer_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_outgoing_transfer_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_outgoing_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_outgoing_transfers_service_role
  ON public.company_outgoing_transfers FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY company_outgoing_transfers_admin_all
  ON public.company_outgoing_transfers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY company_outgoing_approvals_service_role
  ON public.company_outgoing_transfer_approvals FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY company_outgoing_approvals_admin_all
  ON public.company_outgoing_transfer_approvals FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY company_outgoing_audit_service_role
  ON public.company_outgoing_transfer_audit FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY company_outgoing_audit_admin_select
  ON public.company_outgoing_transfer_audit FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));
-- Append-only: no UPDATE/DELETE policies for authenticated.

CREATE POLICY company_outgoing_batches_service_role
  ON public.company_outgoing_batches FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY company_outgoing_batches_admin_all
  ON public.company_outgoing_batches FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

COMMENT ON TABLE public.company_outgoing_transfers IS
  'Payout Ledger SSOT — company outgoing money only. Never driver wallet or payment sessions.';
COMMENT ON TABLE public.company_outgoing_transfer_audit IS
  'Append-only audit for company outgoing transfers. Never delete.';

INSERT INTO public.admin_settings (setting_key, setting_value, description)
VALUES
  ('company_transfer_approval_single_max_pence', '25000', 'Single approval max (inclusive) for company transfers'),
  ('company_transfer_approval_dual_max_pence', '250000', 'Two-approval max (inclusive); above requires owner'),
  ('company_transfer_default_account', '""', 'Default company source account label'),
  ('company_transfer_retry_max', '3', 'Max automatic retries for failed company transfers')
ON CONFLICT (setting_key) DO NOTHING;
