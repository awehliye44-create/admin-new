-- Phase 3D.1 — Cancel orphan weekly settlement artifacts from pre-gate verification run.
-- Batch 8819ebee / item 0c12e3dc: no Stripe transfer, no ledger debit; zero future execution risk.

UPDATE payout_items
SET
  status = 'FAILED_DUPLICATE',
  settlement_status = 'FAILED',
  amount_pence = 0,
  gross_payable_pence = 0,
  net_driver_payout_pence = 0,
  cash_commission_recovered_pence = 0,
  failure_code = 'ORPHAN_CANCELLED_3D1',
  failure_reason = 'Phase 3D.1 — orphan weekly item from pre-gate verification; cancelled before any Stripe transfer',
  provider_response = COALESCE(provider_response, '{}'::jsonb) || jsonb_build_object(
    'cancelled_by', 'phase_3d1_orphan_weekly_cancel',
    'cancelled_at', now()::text,
    'original_amount_pence', 307
  ),
  updated_at = now()
WHERE id = '0c12e3dc-a8e9-4331-8080-2a5c713d4e9a'
  AND batch_id = '8819ebee-cb96-406f-9f30-035baac119c5'
  AND stripe_transfer_id IS NULL
  AND stripe_payout_id IS NULL;

UPDATE payout_batches
SET
  status = 'failed',
  total_amount_pence = 0,
  total_drivers = 0,
  successful_payouts = 0,
  failed_payouts = 1,
  failure_code = 'ORPHAN_CANCELLED_3D1',
  failure_reason = 'Phase 3D.1 — orphan weekly batch from pre-gate verification; cancelled (no Stripe execution)',
  notes = COALESCE(notes, '') || ' [3D.1 orphan cancel]',
  updated_at = now(),
  completed_at = now()
WHERE id = '8819ebee-cb96-406f-9f30-035baac119c5'
  AND kind = 'WEEKLY_MONDAY';
