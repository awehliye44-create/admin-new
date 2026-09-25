-- Rollback for 20261201120000_certification_non_payable_financial_outcome.sql
-- Refuses destructive rollback once CERTIFICATION_NON_PAYABLE repair evidence exists.
-- Never deletes applied repair requests or audit rows.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.driver_financial_repair_audit
    WHERE event_type = 'CERTIFICATION_NON_PAYABLE_MARKED'
    LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM public.driver_financial_repair_requests
    WHERE classification = 'CERTIFICATION_NON_PAYABLE'
      AND status = 'APPLIED'
    LIMIT 1
  ) OR EXISTS (
    SELECT 1 FROM public.trips
    WHERE financial_outcome = 'CERTIFICATION_NON_PAYABLE'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION
      'ROLLBACK_REFUSED_LIVE_EVIDENCE: CERTIFICATION_NON_PAYABLE repair evidence exists — refuse destructive rollback; do not delete audit/request rows';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.admin_apply_certification_non_payable_repair(
  uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, jsonb, text
);

DROP FUNCTION IF EXISTS public.admin_apply_certification_non_payable_repair(
  uuid, uuid, uuid, uuid, text, text, text, uuid, uuid, text
);

ALTER TABLE public.driver_financial_repair_audit
  DROP CONSTRAINT IF EXISTS driver_financial_repair_audit_event_type_check;

ALTER TABLE public.driver_financial_repair_audit
  ADD CONSTRAINT driver_financial_repair_audit_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'DRIVER_FINANCIAL_REPAIR_PREVIEWED'::text,
    'EXPECTED_STAMP_RESTORED'::text,
    'WALLET_CORRECTION_APPENDED'::text,
    'RECONCILIATION_RECOMPUTED'::text,
    'FALSE_FREEZE_CLEARED'::text,
    'FINANCIAL_REPAIR_BLOCKED'::text
  ]));

COMMENT ON COLUMN public.trips.financial_outcome IS NULL;

COMMIT;
