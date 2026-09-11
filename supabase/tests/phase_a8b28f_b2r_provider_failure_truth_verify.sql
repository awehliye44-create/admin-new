-- A8B28F-B2R Stage 1 post-apply verification (read-only counts + schema proof).
-- Safe to run repeatedly. No PII dump of encrypted bank fields.

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'driver_payout_destinations'
      AND column_name = 'provider_link_failure_class'
  ) AS has_failure_class_col,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'driver_payout_destinations'
      AND column_name = 'provider_http_status'
  ) AS has_http_status_col,
  (
    SELECT is_nullable = 'YES'
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'driver_payout_destination_audit'
      AND column_name = 'changed_by_user_id'
  ) AS audit_actor_nullable,
  pg_get_constraintdef(c.oid) AS audit_action_check,
  (SELECT count(*)::int FROM public.driver_payout_destinations) AS dest_total,
  (SELECT count(*)::int FROM public.driver_payout_destinations
     WHERE is_active IS TRUE AND archived_at IS NULL) AS dest_active,
  (SELECT count(*)::int FROM public.driver_payout_destination_audit) AS audit_total,
  (SELECT count(*)::int
     FROM public.driver_payout_destinations pd
     JOIN public.drivers d ON d.id = pd.driver_id
     WHERE d.driver_code = 'MK0006'
       AND pd.is_active IS TRUE
       AND pd.archived_at IS NULL
       AND upper(coalesce(pd.provider_link_status, '')) = 'FAILED'
       AND upper(coalesce(pd.verification_status, '')) = 'PENDING_VERIFICATION'
       AND pd.provider_counterparty_id IS NULL
       AND pd.verified_at IS NULL) AS mk_failed_pending_active,
  EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20261109460000'
  ) AS migration_recorded
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'driver_payout_destination_audit'
  AND c.conname = 'driver_payout_destination_audit_action_check';
