-- Step 8.2B1 — POST-APPLY read-only compatibility (no money-writing RPCs)

SELECT count(*)::integer AS dup_non_refund_debit_pairs
FROM (
  SELECT related_trip_id, type
  FROM public.driver_wallet_ledger
  WHERE related_trip_id IS NOT NULL AND type <> 'REFUND_DEBIT'
  GROUP BY related_trip_id, type
  HAVING count(*) > 1
) d;

SELECT count(*)::integer AS dup_null_lineage_refund_debit_trips
FROM (
  SELECT related_trip_id
  FROM public.driver_wallet_ledger
  WHERE type = 'REFUND_DEBIT' AND related_trip_id IS NOT NULL AND provider_refund_id IS NULL
  GROUP BY related_trip_id
  HAVING count(*) > 1
) d;

SELECT count(*)::integer AS dup_provider_refund_lineage
FROM (
  SELECT payment_provider, provider_refund_id, driver_id
  FROM public.driver_wallet_ledger
  WHERE type = 'REFUND_DEBIT' AND provider_refund_id IS NOT NULL
  GROUP BY payment_provider, provider_refund_id, driver_id
  HAVING count(*) > 1
) d;

SELECT count(*)::integer AS dup_payment_session_refunds_provider
FROM (
  SELECT payment_provider, provider_refund_id
  FROM public.payment_session_refunds
  WHERE provider_refund_id IS NOT NULL
  GROUP BY payment_provider, provider_refund_id
  HAVING count(*) > 1
) d;

SELECT count(*)::bigint AS historical_null_lineage_refund_debit_rows
FROM public.driver_wallet_ledger
WHERE type = 'REFUND_DEBIT' AND provider_refund_id IS NULL;

SELECT pg_get_function_result(p.oid) AS wallet_summary_return_type
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'get_driver_own_wallet_summary';

SELECT count(*)::integer AS withdrawal_rpc_executed_rows
FROM public.get_driver_own_withdrawals(NULL) w;

SELECT pg_get_function_result(p.oid) AS earning_rows_return_type
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'get_driver_own_wallet_earning_rows';
