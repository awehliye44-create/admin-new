-- Step 8.2B1 — READ-ONLY pre-apply catalog / preflight mirror (no writes)

SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 3;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'driver_wallet_ledger'
  AND column_name IN ('provider_refund_id', 'payment_provider')
ORDER BY column_name;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'driver_wallet_ledger' AND indexdef LIKE '%UNIQUE%'
ORDER BY indexname;

SELECT tgname, pg_get_triggerdef(oid, true) AS trigger_def
FROM pg_trigger
WHERE tgrelid = 'public.driver_wallet_ledger'::regclass AND NOT tgisinternal
ORDER BY tgname;

SELECT conname, pg_get_constraintdef(oid, true) AS constraint_def
FROM pg_constraint
WHERE conrelid = 'public.driver_wallet_ledger'::regclass AND contype = 'c'
ORDER BY conname;

SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'payment_session_refunds'
  AND indexname = 'payment_session_refunds_provider_refund_unique';

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
  WHERE type = 'REFUND_DEBIT' AND related_trip_id IS NOT NULL
  GROUP BY related_trip_id
  HAVING count(*) > 1
) d;

SELECT count(*)::integer AS dup_provider_refund_groups
FROM (
  SELECT payment_provider, provider_refund_id
  FROM public.payment_session_refunds
  WHERE provider_refund_id IS NOT NULL
  GROUP BY payment_provider, provider_refund_id
  HAVING count(*) > 1
) d;

SELECT EXISTS (
  SELECT 1 FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'apply_confirmed_provider_refund_atomic'
) AS rpc_exists_pre_apply;

SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.driver_wallet_ledger'::regclass
  AND NOT tgisinternal
  AND tgname = 'trg_enforce_commission_wallet_ledger_financial_model';
