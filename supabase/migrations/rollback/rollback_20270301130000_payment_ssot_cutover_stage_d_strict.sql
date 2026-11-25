-- Rollback Stage D → Stage C (flags only). Schema retained.
-- Exact Edge rollback target for #92 programme: git commit 871c73ac
--   ("fix(payments): #91A reconcile PENDING increment rows from provider evidence")
-- That commit preserves #89/#90/#91/#91A safeguards without #92 claim/snapshot enforcement.
-- Do NOT use an unspecified "previous Edge version".
-- NEVER drop payment_financial_operations / snapshots / events here.
-- Before deploying Edge 871c73ac: require zero provider_post_inflight ops
-- (mixed-version: old Edge bypasses claim and must not race inflight new workers).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.payment_financial_operations
    WHERE provider_post_inflight = true
    LIMIT 1
  ) THEN
    RAISE EXCEPTION
      'REFUSING Stage D→C while provider_post_inflight=true; reconcile-only until clear, then roll Edge.';
  END IF;
END $$;

UPDATE public.payment_ssot_cutover
SET
  stage = 'C',
  require_financial_op_claim = false,
  strict_trip_capture_mirror = false,
  updated_at = now()
WHERE id = 1;
