-- Phase 0d rollback SQL (functions/views only — never financial rows).
-- Reverse order of 20260901120000 → 20260901130000 → 20260901140000.

BEGIN;

DROP VIEW IF EXISTS public.commission_wallet_driver_financial_summary;
DROP VIEW IF EXISTS public.platform_collected_driver_financial_summary;

-- Restore pre-hardening finalize_driver_payout_completion would require prior definition snapshot.
-- For deploy rollback, re-apply 20260814140000 driver_withdraw_completion_reconcile_rls function body.
DROP FUNCTION IF EXISTS public.finalize_manual_external_payout_completion(
  uuid, text, uuid, integer, timestamptz, uuid, text, jsonb
);

-- payout_ledger_type_is_payout_eligible: revert to pre-DRIVER_COMPENSATION_CREDIT if needed
CREATE OR REPLACE FUNCTION public.payout_ledger_type_is_payout_eligible(p_type text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(btrim(coalesce(p_type, ''))) IN (
    'TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT', 'TIP_CREDIT'
  );
$$;

COMMIT;
