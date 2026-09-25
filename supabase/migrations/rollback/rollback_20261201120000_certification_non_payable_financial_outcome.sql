-- Rollback for 20261201120000_certification_non_payable_financial_outcome.sql
BEGIN;

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
