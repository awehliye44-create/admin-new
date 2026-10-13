-- Rollback for 20261216140000_early_cashout_financial_invariant.
-- Removes the guards, the failure-release RPC and the audit view. Ledger rows,
-- item statuses and audit rows written while it was active are kept.
DROP VIEW IF EXISTS public.early_cashout_invariant_audit;
DROP FUNCTION IF EXISTS public.fail_submitted_early_cashout(uuid, text, text, jsonb);
DROP TRIGGER IF EXISTS trg_assert_early_cashout_completion_invariant ON public.payout_items;
DROP FUNCTION IF EXISTS public.assert_early_cashout_completion_invariant();
DROP TRIGGER IF EXISTS trg_enforce_early_cashout_amount_invariant ON public.payout_items;
DROP FUNCTION IF EXISTS public.enforce_early_cashout_amount_invariant();
DROP FUNCTION IF EXISTS public.payout_item_early_cashout_fee_pence(jsonb);
