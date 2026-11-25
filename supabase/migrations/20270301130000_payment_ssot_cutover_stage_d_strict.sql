-- Stage D — Enable strict fencing AFTER Stage A–C validation.
-- Local/dev only until production cutover approval. Do NOT apply blindly.
-- Sets require_financial_op_claim + strict_trip_capture_mirror.
-- Prerequisite: ALL Edge workers must be fence-aware (#92+). Mixed-version with
-- pre-fence workers can bypass claimFinancialOperationForPost.
-- Refuse enablement while provider POSTs are inflight.
-- Rollback: rollback_20270301130000_payment_ssot_cutover_stage_d_strict.sql
--   (flags → C only; never drop evidence). Edge rollback SHA: 871c73ac after quiescence.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'payment_financial_operations'
  ) AND EXISTS (
    SELECT 1 FROM public.payment_financial_operations
    WHERE provider_post_inflight = true
    LIMIT 1
  ) THEN
    RAISE EXCEPTION
      'REFUSING Stage D enablement: provider_post_inflight ops exist. Quiesce, confirm all Edge workers are fence-aware, then retry.';
  END IF;
END $$;

UPDATE public.payment_ssot_cutover
SET
  stage = 'D',
  require_financial_op_claim = true,
  strict_trip_capture_mirror = true,
  updated_at = now()
WHERE id = 1;
