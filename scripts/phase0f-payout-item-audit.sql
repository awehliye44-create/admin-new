-- Phase 0f read-only predeploy payout item audit (no mutations, no RPC execution).

-- Step 1: Identify the 11 predeploy items (missing allocations + sum mismatches on non-terminal statuses)
WITH missing_alloc AS (
  SELECT pi.id
  FROM public.payout_items pi
  WHERE upper(btrim(COALESCE(pi.status, ''))) IN (
    'VALIDATED', 'RESERVED', 'SUBMITTING', 'SUBMITTED', 'COMPLETED', 'PROCESSING', 'FAILED', 'BLOCKED'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.payout_item_ledger_allocations a WHERE a.payout_item_id = pi.id
  )
),
sum_mismatch AS (
  SELECT pi.id
  FROM public.payout_items pi
  LEFT JOIN public.payout_item_ledger_allocations a ON a.payout_item_id = pi.id
  WHERE upper(btrim(COALESCE(pi.status, ''))) NOT IN (
    'CANCELLED', 'RELEASED', 'INELIGIBLE', 'FAILED_PERMANENT', 'REVERSED'
  )
  GROUP BY pi.id, pi.amount_pence, pi.net_driver_payout_pence
  HAVING COALESCE(SUM(a.amount_pence), 0) IS DISTINCT FROM COALESCE(pi.net_driver_payout_pence, pi.amount_pence)
),
target_items AS (
  SELECT id FROM missing_alloc
  UNION
  SELECT id FROM sum_mismatch
)
SELECT COUNT(*) AS target_count FROM target_items;

-- Step 2: Full detail for each target item
WITH missing_alloc AS (
  SELECT pi.id
  FROM public.payout_items pi
  WHERE upper(btrim(COALESCE(pi.status, ''))) IN (
    'VALIDATED', 'RESERVED', 'SUBMITTING', 'SUBMITTED', 'COMPLETED', 'PROCESSING', 'FAILED', 'BLOCKED'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.payout_item_ledger_allocations a WHERE a.payout_item_id = pi.id
  )
),
sum_mismatch AS (
  SELECT pi.id
  FROM public.payout_items pi
  LEFT JOIN public.payout_item_ledger_allocations a ON a.payout_item_id = pi.id
  WHERE upper(btrim(COALESCE(pi.status, ''))) NOT IN (
    'CANCELLED', 'RELEASED', 'INELIGIBLE', 'FAILED_PERMANENT', 'REVERSED'
  )
  GROUP BY pi.id, pi.amount_pence, pi.net_driver_payout_pence
  HAVING COALESCE(SUM(a.amount_pence), 0) IS DISTINCT FROM COALESCE(pi.net_driver_payout_pence, pi.amount_pence)
),
target_items AS (
  SELECT id FROM missing_alloc
  UNION
  SELECT id FROM sum_mismatch
)
SELECT
  pi.id AS payout_item_id,
  pi.status,
  pi.driver_id,
  dr.driver_code,
  COALESCE(pi.net_driver_payout_pence, pi.amount_pence) AS amount_pence,
  pi.amount_pence AS raw_amount_pence,
  pi.batch_id,
  pb.kind AS batch_kind,
  pb.schedule_occurrence_key,
  pb.status AS batch_status,
  pi.payout_type,
  pi.provider_status,
  pi.provider_reference,
  pi.completed_at,
  pi.created_at,
  pi.updated_at,
  pi.failure_reason,
  pi.manual_review_required,
  (SELECT r.status FROM public.driver_payout_reservations r
   WHERE r.payout_item_id = pi.id
   ORDER BY r.created_at DESC NULLS LAST LIMIT 1) AS reservation_status,
  (SELECT r.id FROM public.driver_payout_reservations r
   WHERE r.payout_item_id = pi.id
   ORDER BY r.created_at DESC NULLS LAST LIMIT 1) AS reservation_id,
  (SELECT r.debit_ledger_entry_id FROM public.driver_payout_reservations r
   WHERE r.payout_item_id = pi.id
   ORDER BY r.created_at DESC NULLS LAST LIMIT 1) AS reservation_debit_ledger_id,
  (SELECT i.execution_status FROM public.driver_payout_payment_intents i
   WHERE i.payout_item_id = pi.id
   ORDER BY i.created_at DESC NULLS LAST LIMIT 1) AS intent_execution_status,
  (SELECT i.provider_state FROM public.driver_payout_payment_intents i
   WHERE i.payout_item_id = pi.id
   ORDER BY i.created_at DESC NULLS LAST LIMIT 1) AS intent_provider_state,
  (SELECT i.provider_payment_id FROM public.driver_payout_payment_intents i
   WHERE i.payout_item_id = pi.id
   ORDER BY i.created_at DESC NULLS LAST LIMIT 1) AS intent_provider_payment_id,
  (SELECT COUNT(*) FROM public.payout_item_ledger_allocations a WHERE a.payout_item_id = pi.id) AS allocation_row_count,
  (SELECT COALESCE(SUM(a.amount_pence), 0) FROM public.payout_item_ledger_allocations a WHERE a.payout_item_id = pi.id) AS allocation_sum_pence,
  EXISTS (
    SELECT 1 FROM public.driver_wallet_ledger dwl
    WHERE dwl.driver_id = pi.driver_id
      AND upper(btrim(dwl.type)) IN ('PAYOUT_DEBIT', 'WITHDRAWAL_DEBIT', 'EARLY_CASHOUT_DEBIT', 'DRIVER_PAYOUT_DEBIT')
      AND (
        pi.ledger_entry_id = dwl.id
        OR EXISTS (
          SELECT 1 FROM public.driver_payout_reservations r2
          WHERE r2.payout_item_id = pi.id
            AND (r2.debit_ledger_entry_id = dwl.id OR r2.hold_ledger_entry_id = dwl.id)
        )
      )
  ) AS wallet_debit_exists,
  pi.ledger_entry_id IS NOT NULL AS item_ledger_entry_id_populated,
  (SELECT COUNT(*) FROM public.payout_item_ledger_allocations a
   WHERE a.payout_item_id = pi.id AND a.ledger_entry_id IS NULL) AS allocations_missing_ledger_entry_id,
  (SELECT COUNT(*) FROM public.payout_item_ledger_allocations a
   WHERE a.payout_item_id = pi.id AND a.ledger_entry_id IS NOT NULL) AS allocations_with_ledger_entry_id,
  CASE WHEN ma.id IS NOT NULL THEN 'missing_allocation' ELSE 'sum_mismatch' END AS phase0d_flag
FROM target_items ti
JOIN public.payout_items pi ON pi.id = ti.id
LEFT JOIN public.payout_batches pb ON pb.id = pi.batch_id
LEFT JOIN public.drivers dr ON dr.id = pi.driver_id
LEFT JOIN missing_alloc ma ON ma.id = pi.id
ORDER BY pi.created_at;

-- Step 3: Allocation detail per target item
WITH missing_alloc AS (
  SELECT pi.id
  FROM public.payout_items pi
  WHERE upper(btrim(COALESCE(pi.status, ''))) IN (
    'VALIDATED', 'RESERVED', 'SUBMITTING', 'SUBMITTED', 'COMPLETED', 'PROCESSING', 'FAILED', 'BLOCKED'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.payout_item_ledger_allocations a WHERE a.payout_item_id = pi.id
  )
),
sum_mismatch AS (
  SELECT pi.id
  FROM public.payout_items pi
  LEFT JOIN public.payout_item_ledger_allocations a ON a.payout_item_id = pi.id
  WHERE upper(btrim(COALESCE(pi.status, ''))) NOT IN (
    'CANCELLED', 'RELEASED', 'INELIGIBLE', 'FAILED_PERMANENT', 'REVERSED'
  )
  GROUP BY pi.id, pi.amount_pence, pi.net_driver_payout_pence
  HAVING COALESCE(SUM(a.amount_pence), 0) IS DISTINCT FROM COALESCE(pi.net_driver_payout_pence, pi.amount_pence)
),
target_items AS (
  SELECT id FROM missing_alloc
  UNION
  SELECT id FROM sum_mismatch
)
SELECT
  a.payout_item_id,
  a.id AS allocation_id,
  a.ledger_entry_id,
  a.amount_pence,
  upper(btrim(dwl.type)) AS ledger_type,
  dwl.related_trip_id,
  t.financial_model AS trip_financial_model
FROM target_items ti
JOIN public.payout_item_ledger_allocations a ON a.payout_item_id = ti.id
LEFT JOIN public.driver_wallet_ledger dwl ON dwl.id = a.ledger_entry_id
LEFT JOIN public.trips t ON t.id = dwl.related_trip_id
ORDER BY a.payout_item_id, a.amount_pence DESC;

-- Step 4: Active validated/submitted items NOT in target set (must be clean for hardening proof)
SELECT pi.id, pi.status, pi.driver_id, COALESCE(pi.net_driver_payout_pence, pi.amount_pence) AS amount_pence,
  (SELECT COALESCE(SUM(a.amount_pence), 0) FROM public.payout_item_ledger_allocations a WHERE a.payout_item_id = pi.id) AS alloc_sum,
  (SELECT COUNT(*) FROM public.payout_item_ledger_allocations a WHERE a.payout_item_id = pi.id) AS alloc_rows
FROM public.payout_items pi
WHERE upper(btrim(COALESCE(pi.status, ''))) IN ('VALIDATED', 'RESERVED', 'SUBMITTING', 'SUBMITTED', 'PROCESSING')
AND pi.id NOT IN (
  SELECT pi2.id FROM public.payout_items pi2
  WHERE NOT EXISTS (SELECT 1 FROM public.payout_item_ledger_allocations a WHERE a.payout_item_id = pi2.id)
     OR (
       SELECT COALESCE(SUM(a2.amount_pence), 0) FROM public.payout_item_ledger_allocations a2 WHERE a2.payout_item_id = pi2.id
     ) IS DISTINCT FROM COALESCE(pi2.net_driver_payout_pence, pi2.amount_pence)
)
ORDER BY pi.created_at;

-- Step 5: Completed historical payouts (History display proof)
SELECT COUNT(*) AS completed_historical_count,
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM public.payout_item_ledger_allocations a WHERE a.payout_item_id = pi.id
       )) AS with_allocations,
       COUNT(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM public.payout_item_ledger_allocations a WHERE a.payout_item_id = pi.id
       )) AS without_allocations
FROM public.payout_items pi
WHERE lower(btrim(COALESCE(pi.status, ''))) IN ('completed', 'paid');
