-- Step 8.2A.4 — READ-ONLY production catalog audit for driver_wallet_ledger
-- No writes. Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/step82a4-production-ledger-catalog-readonly.sql

\echo '=== CONSTRAINTS on public.driver_wallet_ledger ==='
SELECT
  c.conname AS constraint_name,
  pg_get_constraintdef(c.oid, true) AS constraint_def
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'driver_wallet_ledger'
ORDER BY c.contype, c.conname;

\echo '=== UNIQUE INDEXES on public.driver_wallet_ledger ==='
SELECT
  i.relname AS index_name,
  ix.indisunique AS is_unique,
  pg_get_indexdef(i.oid) AS index_def
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'driver_wallet_ledger'
  AND ix.indisunique
ORDER BY i.relname;

\echo '=== ALL INDEXES on public.driver_wallet_ledger ==='
SELECT
  i.relname AS index_name,
  ix.indisunique AS is_unique,
  pg_get_indexdef(i.oid) AS index_def
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'driver_wallet_ledger'
ORDER BY i.relname;

\echo '=== TRIGGERS on public.driver_wallet_ledger ==='
SELECT
  tg.tgname AS trigger_name,
  pg_get_triggerdef(tg.oid, true) AS trigger_def
FROM pg_trigger tg
JOIN pg_class t ON t.oid = tg.tgrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'driver_wallet_ledger'
  AND NOT tg.tgisinternal
ORDER BY tg.tgname;

\echo '=== TRIGGER FUNCTION DEFINITIONS ==='
SELECT DISTINCT
  p.proname AS function_name,
  pg_get_functiondef(p.oid) AS function_def
FROM pg_trigger tg
JOIN pg_class t ON t.oid = tg.tgrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_proc p ON p.oid = tg.tgfoid
WHERE n.nspname = 'public'
  AND t.relname = 'driver_wallet_ledger'
  AND NOT tg.tgisinternal
ORDER BY p.proname;

\echo '=== REFUND_DEBIT cardinality (production rows) ==='
SELECT
  count(*) AS refund_debit_rows,
  count(DISTINCT related_trip_id) AS distinct_trips,
  count(*) FILTER (WHERE related_trip_id IS NOT NULL) AS with_trip,
  count(*) - count(DISTINCT (related_trip_id, type)) FILTER (WHERE related_trip_id IS NOT NULL) AS duplicate_trip_type_pairs
FROM public.driver_wallet_ledger
WHERE type = 'REFUND_DEBIT';

\echo '=== trips with multiple REFUND_DEBIT rows ==='
SELECT related_trip_id, count(*) AS debit_count
FROM public.driver_wallet_ledger
WHERE type = 'REFUND_DEBIT'
  AND related_trip_id IS NOT NULL
GROUP BY related_trip_id
HAVING count(*) > 1
ORDER BY count(*) DESC
LIMIT 20;

\echo '=== DISTINCT ledger types in production ==='
SELECT type, count(*) AS row_count,
  count(DISTINCT related_trip_id) FILTER (WHERE related_trip_id IS NOT NULL) AS distinct_trips
FROM public.driver_wallet_ledger
GROUP BY type
ORDER BY type;

\echo '=== duplicate (related_trip_id, type) pairs (any type) ==='
SELECT type, count(*) AS dup_trips
FROM (
  SELECT related_trip_id, type
  FROM public.driver_wallet_ledger
  WHERE related_trip_id IS NOT NULL
  GROUP BY related_trip_id, type
  HAVING count(*) > 1
) d
GROUP BY type
ORDER BY dup_trips DESC;
