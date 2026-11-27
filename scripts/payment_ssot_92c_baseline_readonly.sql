-- #92C read-only PLATFORM_COLLECTED financial integrity baseline.
-- No mutations. Do not invent evidence.

SELECT 'baseline_at' AS section, jsonb_build_object('now', now()) AS payload

UNION ALL
SELECT 'migration_head', jsonb_build_object(
  'latest_recorded', (SELECT max(version) FROM supabase_migrations.schema_migrations),
  'has_120000', EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20270301120000'),
  'has_125000', EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20270301125000'),
  'has_126000', EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20270301126000'),
  'has_130000_stage_d', EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20270301130000'),
  'has_140000', EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20270301140000')
)

UNION ALL
SELECT 'cutover_table', jsonb_build_object(
  'exists', to_regclass('public.payment_ssot_cutover') IS NOT NULL,
  'ops_table_exists', to_regclass('public.payment_financial_operations') IS NOT NULL,
  'snapshots_table_exists', to_regclass('public.payment_payable_snapshots') IS NOT NULL
)

UNION ALL
SELECT 'active_trips', jsonb_build_object(
  'count', count(*),
  'authorised_pence', COALESCE(sum(COALESCE(authorised_amount_pence, 0)), 0)
)
FROM public.trips
WHERE lower(COALESCE(status::text, '')) IN (
  'searching','offered','accepted','confirmed','arrived','in_progress','started','driver_assigned'
)
AND upper(COALESCE(financial_model::text, '')) = 'PLATFORM_COLLECTED'

UNION ALL
SELECT 'scheduled_trips', jsonb_build_object(
  'count', count(*),
  'authorised_pence', COALESCE(sum(COALESCE(authorised_amount_pence, 0)), 0)
)
FROM public.trips
WHERE COALESCE(is_scheduled, false) = true
  AND lower(COALESCE(status::text, '')) NOT IN ('completed','cancelled','no_show','expired')
  AND upper(COALESCE(financial_model::text, '')) = 'PLATFORM_COLLECTED'

UNION ALL
SELECT 'authorised_sessions', jsonb_build_object(
  'count', count(*),
  'authorised_pence', COALESCE(sum(GREATEST(
    COALESCE(total_authorised_amount_pence, 0),
    COALESCE(authorised_amount_pence, 0)
  )), 0)
)
FROM public.payment_sessions
WHERE upper(COALESCE(provider_state::text, '')) IN ('AUTHORISED', 'AUTHORIZED')
   OR lower(COALESCE(status::text, '')) LIKE '%authoris%'

UNION ALL
SELECT 'financial_op_locks', jsonb_build_object(
  'capturing', count(*) FILTER (WHERE upper(COALESCE(financial_operation_state::text, '')) = 'CAPTURING'),
  'incrementing', count(*) FILTER (WHERE upper(COALESCE(financial_operation_state::text, '')) = 'INCREMENTING'),
  'reconciling', count(*) FILTER (WHERE upper(COALESCE(financial_operation_state::text, '')) = 'RECONCILING')
)
FROM public.payment_sessions

UNION ALL
SELECT 'pending_increments', jsonb_build_object(
  'count', count(*),
  'amount_pence', COALESCE(sum(COALESCE(amount_pence, 0)), 0)
)
FROM public.payment_authorization_ledger
WHERE lower(COALESCE(status::text, '')) IN ('pending', 'processing', 'requested')

UNION ALL
SELECT 'completed_uncaptured', jsonb_build_object(
  'count', count(*),
  'fare_pence', COALESCE(sum(COALESCE(final_customer_fare_pence, estimated_total_pence, 0)), 0)
)
FROM public.trips
WHERE lower(COALESCE(status::text, '')) = 'completed'
  AND upper(COALESCE(financial_model::text, '')) = 'PLATFORM_COLLECTED'
  AND lower(COALESCE(payment_status::text, '')) IS DISTINCT FROM 'captured'
  AND lower(COALESCE(payment_status::text, '')) IS DISTINCT FROM 'paid'
  AND COALESCE(capture_amount_pence, 0) = 0

UNION ALL
SELECT 'missing_ten', jsonb_build_object(
  'count', count(*)
)
FROM public.trips t
WHERE lower(COALESCE(t.status::text, '')) = 'completed'
  AND upper(COALESCE(t.financial_model::text, '')) = 'PLATFORM_COLLECTED'
  AND COALESCE(t.driver_id, t.confirmed_driver_id) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.driver_wallet_ledger l
    WHERE l.related_trip_id = t.id AND l.type = 'TRIP_EARNING_NET'
  )

UNION ALL
SELECT 'open_receivables', jsonb_build_object(
  'count', count(*),
  'outstanding_pence', COALESCE(sum(COALESCE(outstanding_amount_pence, original_amount_pence, 0)), 0)
)
FROM public.customer_receivables
WHERE lower(COALESCE(status::text, '')) NOT IN ('settled', 'cancelled', 'void', 'released', 'waived')

UNION ALL
SELECT 'cron_payment_related', COALESCE(
  (SELECT jsonb_agg(jsonb_build_object(
    'jobname', jobname, 'schedule', schedule, 'active', active
  ) ORDER BY jobname)
   FROM cron.job
   WHERE jobname ILIKE '%revolut%'
      OR jobname ILIKE '%capture%'
      OR jobname ILIKE '%payment%'
      OR jobname ILIKE '%preauth%'
      OR jobname ILIKE '%hold%'
      OR jobname ILIKE '%increment%'),
  '[]'::jsonb
);
