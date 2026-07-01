-- Settlement lifecycle tracking (additive). Completes payout allocation visibility without changing wallet math.

ALTER TABLE public.driver_earning_settlement
  ADD COLUMN IF NOT EXISTS settlement_lifecycle_status text NOT NULL DEFAULT 'CREATED'
    CHECK (settlement_lifecycle_status IN (
      'CREATED',
      'TRANSFERRED_TO_CONNECT',
      'INCLUDED_IN_PAYOUT',
      'PAID'
    ));

COMMENT ON COLUMN public.driver_earning_settlement.settlement_lifecycle_status IS
  'Lifecycle: CREATED → TRANSFERRED_TO_CONNECT → INCLUDED_IN_PAYOUT → PAID. Does not alter wallet balance SSOT.';

CREATE INDEX IF NOT EXISTS idx_des_lifecycle_unpaid
  ON public.driver_earning_settlement (driver_id, settlement_lifecycle_status)
  WHERE settlement_lifecycle_status <> 'PAID';

-- Backfill PAID from existing paid flags
UPDATE public.driver_earning_settlement
SET settlement_lifecycle_status = 'PAID'
WHERE paid_in_payout_item_id IS NOT NULL
  AND paid_at IS NOT NULL;

-- Backfill PAID from completed payout_item_ledger_allocations (full row allocation)
UPDATE public.driver_earning_settlement des
SET
  paid_in_payout_item_id = pila.payout_item_id,
  paid_at = COALESCE(des.paid_at, pila.allocated_at, pi.completed_at, pi.created_at),
  allocated_amount_pence = GREATEST(des.allocated_amount_pence, pila.amount_pence),
  allocated_to_payout = true,
  allocated_at = COALESCE(des.allocated_at, pila.allocated_at, pi.completed_at),
  paid_in_batch_id = COALESCE(des.paid_in_batch_id, pi.batch_id),
  settlement_lifecycle_status = 'PAID',
  updated_at = now()
FROM public.payout_item_ledger_allocations pila
JOIN public.payout_items pi ON pi.id = pila.payout_item_id
JOIN public.driver_wallet_ledger dwl ON dwl.id = pila.ledger_entry_id
WHERE des.ledger_entry_id = pila.ledger_entry_id
  AND pi.status = 'completed'
  AND pila.payout_item_id IS NOT NULL
  AND pila.amount_pence >= dwl.amount_pence
  AND des.settlement_lifecycle_status <> 'PAID';

-- Partial allocations → INCLUDED_IN_PAYOUT
UPDATE public.driver_earning_settlement des
SET
  settlement_lifecycle_status = 'INCLUDED_IN_PAYOUT',
  allocated_to_payout = false,
  updated_at = now()
FROM public.driver_wallet_ledger dwl
WHERE des.ledger_entry_id = dwl.id
  AND des.settlement_lifecycle_status NOT IN ('PAID', 'INCLUDED_IN_PAYOUT')
  AND des.allocated_amount_pence > 0
  AND des.allocated_amount_pence < dwl.amount_pence;

UPDATE public.driver_earning_settlement des
SET
  settlement_lifecycle_status = 'INCLUDED_IN_PAYOUT',
  updated_at = now()
WHERE settlement_lifecycle_status = 'CREATED'
  AND (allocated_to_payout = true OR allocated_amount_pence > 0)
  AND paid_in_payout_item_id IS NULL;

-- SCT on Connect
UPDATE public.driver_earning_settlement
SET settlement_lifecycle_status = 'TRANSFERRED_TO_CONNECT',
    updated_at = now()
WHERE settlement_lifecycle_status = 'CREATED'
  AND stripe_transfer_id IS NOT NULL;
