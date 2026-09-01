-- Phase 0d read-only production compatibility (no mutations, no RPC execution).

-- Financial model distribution (duplicate of fr-financial-model-counts for gate)
SELECT
  COUNT(*) FILTER (WHERE financial_model::text = 'PLATFORM_COLLECTED') AS platform_collected,
  COUNT(*) FILTER (WHERE financial_model::text = 'DRIVER_COLLECTED_COMMISSION_WALLET') AS driver_collected_commission_wallet,
  COUNT(*) FILTER (WHERE financial_model IS NULL) AS null_financial_model,
  COUNT(*) FILTER (
    WHERE financial_model IS NOT NULL
      AND financial_model::text NOT IN ('PLATFORM_COLLECTED', 'DRIVER_COLLECTED_COMMISSION_WALLET')
  ) AS unknown_values
FROM public.trips;

-- Payout items by status (active pipeline)
SELECT lower(btrim(COALESCE(status, ''))) AS item_status, COUNT(*) AS cnt
FROM public.payout_items
GROUP BY 1
ORDER BY cnt DESC;

-- Missing reservations on in-flight items
SELECT COUNT(*) AS missing_reservation_count
FROM public.payout_items pi
WHERE lower(btrim(COALESCE(pi.status, ''))) IN (
  'validated', 'reserved', 'submitting', 'submitted', 'processing'
)
AND NOT EXISTS (
  SELECT 1 FROM public.driver_payout_reservations r
  WHERE r.payout_item_id = pi.id AND r.status IN ('ACTIVE', 'CONSUMED', 'PENDING')
);

-- Missing intents on submitted items
SELECT COUNT(*) AS missing_intent_count
FROM public.payout_items pi
WHERE lower(btrim(COALESCE(pi.status, ''))) IN ('submitting', 'submitted', 'processing')
AND NOT EXISTS (
  SELECT 1 FROM public.driver_payout_payment_intents i WHERE i.payout_item_id = pi.id
);

-- Missing allocations on validated+ items
SELECT COUNT(*) AS missing_allocation_count
FROM public.payout_items pi
WHERE upper(btrim(COALESCE(pi.status, ''))) IN (
  'VALIDATED', 'RESERVED', 'SUBMITTING', 'SUBMITTED', 'COMPLETED', 'PROCESSING'
)
AND NOT EXISTS (
  SELECT 1 FROM public.payout_item_ledger_allocations a WHERE a.payout_item_id = pi.id
);

-- Allocation sum mismatch vs item amount
SELECT pi.id AS payout_item_id, pi.amount_pence, COALESCE(SUM(a.amount_pence), 0) AS alloc_sum
FROM public.payout_items pi
LEFT JOIN public.payout_item_ledger_allocations a ON a.payout_item_id = pi.id
WHERE upper(btrim(COALESCE(pi.status, ''))) NOT IN (
  'CANCELLED', 'RELEASED', 'INELIGIBLE', 'FAILED', 'REVERSED', 'FAILED_PERMANENT'
)
GROUP BY pi.id, pi.amount_pence
HAVING COALESCE(SUM(a.amount_pence), 0) IS DISTINCT FROM pi.amount_pence
LIMIT 50;

-- Completed without provider reference on intent
SELECT COUNT(*) AS completed_missing_provider_ref
FROM public.payout_items pi
JOIN public.driver_payout_payment_intents i ON i.payout_item_id = pi.id
WHERE lower(btrim(COALESCE(pi.status, ''))) IN ('completed', 'paid')
AND (i.provider_payment_id IS NULL OR btrim(i.provider_payment_id) = '');

-- Historical manual payouts (MANUAL_ADMIN batches)
SELECT COUNT(*) AS manual_admin_items,
       COUNT(*) FILTER (WHERE lower(btrim(COALESCE(pi.status, ''))) IN ('completed', 'paid')) AS manual_completed
FROM public.payout_items pi
JOIN public.payout_batches pb ON pb.id = pi.batch_id
WHERE pb.kind IN ('MANUAL_ADMIN', 'CONNECT_MANUAL');

-- Eligible ledger types currently allocated
SELECT upper(btrim(dwl.type)) AS ledger_type, COUNT(*) AS allocation_rows
FROM public.payout_item_ledger_allocations a
JOIN public.driver_wallet_ledger dwl ON dwl.id = a.ledger_entry_id
GROUP BY 1
ORDER BY allocation_rows DESC;

-- Items that would fail hardened lineage (DRIVER_COLLECTED trip-linked)
SELECT pi.id AS payout_item_id
FROM public.payout_items pi
JOIN public.payout_item_ledger_allocations a ON a.payout_item_id = pi.id
JOIN public.driver_wallet_ledger dwl ON dwl.id = a.ledger_entry_id
JOIN public.trips t ON t.id = dwl.related_trip_id
WHERE upper(btrim(COALESCE(pi.status, ''))) NOT IN (
  'CANCELLED', 'RELEASED', 'INELIGIBLE', 'FAILED', 'REVERSED', 'FAILED_PERMANENT', 'COMPLETED', 'PAID'
)
AND t.financial_model IS DISTINCT FROM 'PLATFORM_COLLECTED'
LIMIT 50;

-- Items allocated ineligible ledger types (pre-DRIVER_COMPENSATION_CREDIT hardening)
SELECT pi.id AS payout_item_id, upper(btrim(dwl.type)) AS ledger_type
FROM public.payout_items pi
JOIN public.payout_item_ledger_allocations a ON a.payout_item_id = pi.id
JOIN public.driver_wallet_ledger dwl ON dwl.id = a.ledger_entry_id
WHERE upper(btrim(COALESCE(pi.status, ''))) NOT IN (
  'CANCELLED', 'RELEASED', 'INELIGIBLE', 'FAILED', 'REVERSED', 'FAILED_PERMANENT', 'COMPLETED', 'PAID'
)
AND upper(btrim(dwl.type)) NOT IN (
  'TRIP_EARNING_NET', 'DRIVER_COMPENSATION_CREDIT', 'DRIVER_TIP_CREDIT', 'TIP_CREDIT'
)
LIMIT 50;

-- Current RPC grants snapshot
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       array_agg(DISTINCT grantee.rolname ORDER BY grantee.rolname) AS grantees
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN LATERAL aclexplode(p.proacl) acl ON true
LEFT JOIN pg_roles grantee ON grantee.oid = acl.grantee
WHERE n.nspname = 'public'
  AND p.proname IN (
    'finalize_driver_payout_completion',
    'finalize_manual_external_payout_completion',
    'assert_payout_item_ledger_lineage'
  )
GROUP BY p.oid, p.proname
ORDER BY p.proname;
