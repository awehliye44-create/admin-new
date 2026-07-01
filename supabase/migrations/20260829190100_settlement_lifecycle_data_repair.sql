-- One-time repair: align settlement lifecycle with payout_item_ledger_allocations evidence.

UPDATE public.driver_earning_settlement des
SET
  allocated_amount_pence = 0,
  allocated_to_payout = false,
  allocated_at = NULL,
  settlement_lifecycle_status = CASE
    WHEN des.stripe_transfer_id IS NOT NULL THEN 'TRANSFERRED_TO_CONNECT'
    ELSE 'CREATED'
  END,
  updated_at = now()
WHERE des.allocated_amount_pence > 0
  AND des.paid_in_payout_item_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.payout_item_ledger_allocations pila
    WHERE pila.ledger_entry_id = des.ledger_entry_id
  );

UPDATE public.driver_earning_settlement des
SET
  paid_in_payout_item_id = sub.payout_item_id,
  paid_at = COALESCE(des.paid_at, sub.last_allocated_at),
  allocated_amount_pence = sub.total_allocated,
  allocated_to_payout = true,
  allocated_at = COALESCE(des.allocated_at, sub.last_allocated_at),
  paid_in_batch_id = COALESCE(des.paid_in_batch_id, sub.batch_id),
  settlement_lifecycle_status = 'PAID',
  updated_at = now()
FROM (
  SELECT
    des2.id,
    (array_agg(pila.payout_item_id ORDER BY pila.allocated_at DESC))[1] AS payout_item_id,
    max(pila.allocated_at) AS last_allocated_at,
    sum(pila.amount_pence)::int AS total_allocated,
    (array_agg(pi.batch_id ORDER BY pila.allocated_at DESC))[1] AS batch_id,
    dwl.amount_pence AS ledger_amount
  FROM public.driver_earning_settlement des2
  JOIN public.driver_wallet_ledger dwl ON dwl.id = des2.ledger_entry_id
  JOIN public.payout_item_ledger_allocations pila ON pila.ledger_entry_id = des2.ledger_entry_id
  JOIN public.payout_items pi ON pi.id = pila.payout_item_id AND pi.status = 'completed'
  GROUP BY des2.id, dwl.amount_pence
  HAVING sum(pila.amount_pence) >= dwl.amount_pence
) sub
WHERE des.id = sub.id
  AND des.settlement_lifecycle_status <> 'PAID';

UPDATE public.driver_earning_settlement des
SET
  allocated_amount_pence = sub.total_allocated,
  allocated_to_payout = false,
  settlement_lifecycle_status = 'INCLUDED_IN_PAYOUT',
  updated_at = now()
FROM (
  SELECT des2.id, sum(pila.amount_pence)::int AS total_allocated, dwl.amount_pence AS ledger_amount
  FROM public.driver_earning_settlement des2
  JOIN public.driver_wallet_ledger dwl ON dwl.id = des2.ledger_entry_id
  JOIN public.payout_item_ledger_allocations pila ON pila.ledger_entry_id = des2.ledger_entry_id
  JOIN public.payout_items pi ON pi.id = pila.payout_item_id AND pi.status = 'completed'
  WHERE des2.settlement_lifecycle_status <> 'PAID'
  GROUP BY des2.id, dwl.amount_pence
  HAVING sum(pila.amount_pence) > 0 AND sum(pila.amount_pence) < dwl.amount_pence
) sub
WHERE des.id = sub.id;
