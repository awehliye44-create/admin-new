-- Distinct requester / approver on company outgoing transfer audit (append-only).

ALTER TABLE public.company_outgoing_transfer_audit
  ADD COLUMN IF NOT EXISTS requester_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.company_outgoing_transfer_audit.requester_id IS
  'Original transfer requester (denormalised for audit history display).';
COMMENT ON COLUMN public.company_outgoing_transfer_audit.approver_id IS
  'Approver for this event when applicable; null for create/pay/retry by non-approver actors.';
