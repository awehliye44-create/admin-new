-- Step 8.2B1 — POST-APPLY schema verification (read-only)

SELECT count(*)::integer AS applied_count,
  max(version) AS remote_head
FROM supabase_migrations.schema_migrations
WHERE version = '20260930150000';

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'driver_wallet_ledger'
  AND column_name IN ('provider_refund_id', 'payment_provider')
ORDER BY column_name;

SELECT count(*)::integer AS broad_unique_present
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'driver_wallet_ledger'
  AND indexname = 'unique_trip_ledger_entry';

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'driver_wallet_ledger'
  AND indexname IN (
    'driver_wallet_ledger_cash_trip_earning_unique',
    'driver_wallet_ledger_platform_commission_unique',
    'driver_wallet_ledger_driver_tip_credit_unique',
    'driver_wallet_ledger_tip_credit_unique',
    'driver_wallet_ledger_ledger_reversal_unique',
    'driver_wallet_ledger_commission_recovered_unique',
    'driver_wallet_ledger_ops_driver_compensation_unique',
    'driver_wallet_ledger_trip_adjustment_unique',
    'driver_wallet_ledger_debt_recovery_trip_unique',
    'driver_wallet_ledger_refund_debit_null_lineage_trip_unique',
    'driver_wallet_ledger_refund_debit_provider_refund_unique',
    'driver_wallet_ledger_trip_earning_net_unique',
    'idx_driver_wallet_ledger_cash_debt_unique'
  )
ORDER BY indexname;

SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'payment_session_refunds'
  AND indexname = 'payment_session_refunds_provider_refund_unique';

SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'public.driver_wallet_ledger'::regclass AND NOT tgisinternal
ORDER BY tgname;

SELECT conname, pg_get_constraintdef(oid, true) AS constraint_def
FROM pg_constraint
WHERE conrelid = 'public.driver_wallet_ledger'::regclass AND contype = 'c'
ORDER BY conname;

SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.driver_wallet_ledger'::regclass
  AND NOT tgisinternal
  AND tgname = 'trg_enforce_commission_wallet_ledger_financial_model';
