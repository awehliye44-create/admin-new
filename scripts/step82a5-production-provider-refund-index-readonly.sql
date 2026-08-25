-- READ-ONLY production catalog audit: payment_session_refunds_provider_refund_unique
-- No writes.

\echo '=== payment_session_refunds_provider_refund_unique (pg_indexes) ==='
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'payment_session_refunds_provider_refund_unique';

\echo '=== constraint backing (pg_constraint) ==='
SELECT c.conname, c.contype, pg_get_constraintdef(c.oid) AS constraint_def
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'payment_session_refunds'
  AND c.conname = 'payment_session_refunds_provider_refund_unique';

\echo '=== duplicate (payment_provider, provider_refund_id) groups ==='
SELECT payment_provider, provider_refund_id, count(*) AS row_count
FROM public.payment_session_refunds
WHERE provider_refund_id IS NOT NULL
GROUP BY payment_provider, provider_refund_id
HAVING count(*) > 1;

\echo '=== NULL provider_refund_id row count ==='
SELECT count(*) AS null_provider_refund_rows
FROM public.payment_session_refunds
WHERE provider_refund_id IS NULL;

\echo '=== total payment_session_refunds rows ==='
SELECT count(*) AS total_rows FROM public.payment_session_refunds;
