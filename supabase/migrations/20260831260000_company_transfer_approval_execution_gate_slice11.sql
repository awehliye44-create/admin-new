-- Slice 11 — Company transfer approval, funding snapshot & execution gate.
-- Extends company_outgoing_transfers. Does NOT move money.
-- LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED stays false (edge env).

-- Expand status CHECK to include BLOCKED + READY_FOR_EXECUTION.
ALTER TABLE public.company_outgoing_transfers
  DROP CONSTRAINT IF EXISTS company_outgoing_transfers_status_check;

ALTER TABLE public.company_outgoing_transfers
  ADD CONSTRAINT company_outgoing_transfers_status_check
  CHECK (status IN (
    'DRAFT',
    'AWAITING_APPROVAL',
    'APPROVED',
    'REJECTED',
    'BLOCKED',
    'READY_FOR_EXECUTION',
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

-- Funding evidence snapshots (approval + pre-execution). Evidence only — revalidate live before exec.
ALTER TABLE public.company_outgoing_transfers
  ADD COLUMN IF NOT EXISTS approval_funding_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS pre_execution_funding_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS blocked_reason_codes text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS ready_for_execution_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_for_approval_at timestamptz,
  ADD COLUMN IF NOT EXISTS reserve_policy_id uuid,
  ADD COLUMN IF NOT EXISTS source_account_id text,
  ADD COLUMN IF NOT EXISTS transfer_type text NOT NULL DEFAULT 'COMPANY_OUTGOING'
    CHECK (transfer_type IN ('COMPANY_OUTGOING', 'COMPANY_INTERNAL', 'COMPANY_PAYABLE'));

COMMENT ON COLUMN public.company_outgoing_transfers.approval_funding_snapshot IS
  'Slice 11 canonical funding snapshot at approval/submit gate. Evidence only — never debit source from this.';
COMMENT ON COLUMN public.company_outgoing_transfers.pre_execution_funding_snapshot IS
  'Slice 11 pre-execution funding snapshot. Must revalidate live before any future provider submit.';
COMMENT ON COLUMN public.company_outgoing_transfers.blocked_reason_codes IS
  'Fail-closed gate reason codes (e.g. OPERATIONAL_RESERVE_NOT_CONFIGURED, FINAL_COMPANY_FUNDS_UNAVAILABLE, UNCLASSIFIED_COMPANY_CASH_PRESENT).';

-- Safety setting: self-approval remains disabled unless explicitly enabled later.
INSERT INTO public.admin_settings (setting_key, setting_value, description)
VALUES (
  'company_transfer_allow_self_approval',
  'false',
  'Slice 11: requester self-approval disabled by default. Explicit future policy only — never silent bypass.'
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO public.admin_settings (setting_key, setting_value, description)
VALUES (
  'live_company_transfer_execution_enabled',
  'false',
  'Slice 11 safety: company transfer live Revolut/pay execution. Edge also reads LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED env (default false).'
)
ON CONFLICT (setting_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_company_outgoing_transfers_blocked
  ON public.company_outgoing_transfers (status, blocked_at DESC)
  WHERE status = 'BLOCKED';

CREATE INDEX IF NOT EXISTS idx_company_outgoing_transfers_ready
  ON public.company_outgoing_transfers (status, ready_for_execution_at DESC)
  WHERE status = 'READY_FOR_EXECUTION';
