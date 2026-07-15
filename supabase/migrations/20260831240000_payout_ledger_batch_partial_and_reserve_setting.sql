-- Payout Ledger SSOT extension (post–Slice 8)
-- 1) Batch aggregate PARTIALLY_COMPLETED when some items COMPLETED and some unfinished
-- 2) Trigger keeps batch aggregate in sync after item status changes
-- 3) Operational / refund reserve: absence of admin_settings row = NOT_CONFIGURED (never invent £0)
-- Metadata only — NO wallet, reservation, or provider payment mutation.
--
-- IMPORTANT: expand status check (never narrow) — prod already has legacy + slice statuses.

ALTER TABLE public.payout_batches
  DROP CONSTRAINT IF EXISTS payout_batches_status_check;

ALTER TABLE public.payout_batches
  ADD CONSTRAINT payout_batches_status_check
  CHECK (
    status = ANY (ARRAY[
      -- legacy lowercase / mixed
      'pending', 'processing', 'completed', 'failed', 'partial',
      'PARTIAL_SETTLEMENT', 'INVALID_ORPHANED',
      'CREATED', 'READY', 'BLOCKED', 'SENT', 'PAID', 'RETURNED',
      -- canonical workflow
      'DRAFT', 'SCHEDULED', 'VALIDATING', 'PROCESSING',
      'PARTIALLY_COMPLETED', 'COMPLETED', 'FAILED', 'CANCELLED',
      'ELIGIBILITY_SNAPSHOTTED', 'ITEMS_CREATED',
      'BLOCKED_EXECUTION_DISABLED', 'FUNDS_RESERVED_EXECUTION_DISABLED',
      'RESERVING', 'RESERVED',
      'PROVIDER_SUBMISSION_IN_PROGRESS', 'PROVIDER_SUBMISSION_PARTIAL'
    ]::text[])
  );

-- Correct existing mixed batches (e.g. Bosteyo COMPLETED + Ahmed RESERVED).
-- Display-layer SSOT also derives PARTIALLY_COMPLETED; this persists canonical aggregate.
UPDATE public.payout_batches b
SET
  status = 'PARTIALLY_COMPLETED',
  successful_payouts = (
    SELECT COUNT(*)::integer
    FROM public.payout_items i
    WHERE i.batch_id = b.id
      AND lower(i.status) IN ('completed', 'paid', 'succeeded')
  ),
  updated_at = now()
WHERE EXISTS (
  SELECT 1
  FROM public.payout_items i
  WHERE i.batch_id = b.id
)
AND (
  SELECT COUNT(*) FILTER (WHERE lower(status) IN ('completed', 'paid', 'succeeded'))
  FROM public.payout_items i WHERE i.batch_id = b.id
) > 0
AND (
  SELECT COUNT(*) FILTER (WHERE lower(status) NOT IN ('completed', 'paid', 'succeeded'))
  FROM public.payout_items i WHERE i.batch_id = b.id
) > 0
AND b.status IN (
  'PROVIDER_SUBMISSION_PARTIAL',
  'PROVIDER_SUBMISSION_IN_PROGRESS',
  'FUNDS_RESERVED_EXECUTION_DISABLED',
  'RESERVING',
  'RESERVED',
  'PROCESSING',
  'processing',
  'partial',
  'PARTIAL_SETTLEMENT'
);

CREATE OR REPLACE FUNCTION public.refresh_driver_payout_batch_aggregate_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch uuid := COALESCE(NEW.batch_id, OLD.batch_id);
  v_completed integer;
  v_unfinished integer;
BEGIN
  IF v_batch IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE lower(status) IN ('completed', 'paid', 'succeeded')),
    COUNT(*) FILTER (WHERE lower(status) NOT IN ('completed', 'paid', 'succeeded'))
  INTO v_completed, v_unfinished
  FROM public.payout_items
  WHERE batch_id = v_batch;

  IF v_completed > 0 AND v_unfinished > 0 THEN
    UPDATE public.payout_batches
    SET
      status = 'PARTIALLY_COMPLETED',
      successful_payouts = v_completed,
      updated_at = now()
    WHERE id = v_batch
      AND status IS DISTINCT FROM 'COMPLETED'
      AND status IS DISTINCT FROM 'CANCELLED'
      AND status IS DISTINCT FROM 'FAILED';
  ELSIF v_completed > 0 AND v_unfinished = 0 THEN
    UPDATE public.payout_batches
    SET
      status = 'COMPLETED',
      successful_payouts = v_completed,
      completed_at = COALESCE(completed_at, now()),
      updated_at = now()
    WHERE id = v_batch
      AND status IS DISTINCT FROM 'CANCELLED'
      AND status IS DISTINCT FROM 'FAILED';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_refresh_driver_payout_batch_aggregate_status ON public.payout_items;
CREATE TRIGGER trg_refresh_driver_payout_batch_aggregate_status
AFTER INSERT OR UPDATE OF status, execution_status ON public.payout_items
FOR EACH ROW
EXECUTE FUNCTION public.refresh_driver_payout_batch_aggregate_status();

COMMENT ON TABLE public.admin_settings IS
  'Admin configuration. company_operational_refund_reserve JSON (configured/amount_pence/currency/service_area_id/effective_from) enables final ONECAB available funds. Absence of reserve row = OPERATIONAL_RESERVE_NOT_CONFIGURED (fail-closed; never invent £0).';
