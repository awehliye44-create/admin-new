-- Classify Slice11 cancelled proof transfers as CERTIFICATION / HISTORY_ONLY.
-- Preserves audit evidence; excludes from operational Company Transfers lists.

ALTER TABLE public.company_outgoing_transfers
  DROP CONSTRAINT IF EXISTS company_outgoing_transfers_transfer_type_check;

ALTER TABLE public.company_outgoing_transfers
  ADD CONSTRAINT company_outgoing_transfers_transfer_type_check
  CHECK (transfer_type IN (
    'COMPANY_OUTGOING',
    'COMPANY_INTERNAL',
    'COMPANY_PAYABLE',
    'CERTIFICATION'
  ));

UPDATE public.company_outgoing_transfers
SET
  transfer_type = 'CERTIFICATION',
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'slice11', true,
    'transfer_type', 'CERTIFICATION',
    'environment_record', 'TEST_PROOF',
    'operational_visibility', 'HISTORY_ONLY',
    'money_moved', false
  ),
  updated_at = now()
WHERE id IN (
  '4d350ba2-93e6-4e45-80c9-e02bfcf2796b',
  '37a31ff0-e854-4ac1-8454-a1549eece704',
  '7f4dc4ce-717c-43d2-a9df-789bbd9c4d23'
)
AND status = 'CANCELLED';
