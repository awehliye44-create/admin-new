-- Admin Add Credit: persist credit_type on immutable ledger row.
-- Spec: entry_type = ADMIN_CREDIT with credit_type distinguishing
-- WELCOME_CREDIT | PROMOTIONAL_CREDIT | GOODWILL_CREDIT | SUPPORT_CORRECTION | OTHER.
-- Ledger remains append-only (UPDATE/DELETE still blocked by existing triggers).

ALTER TABLE public.driver_commission_wallet_ledger
  ADD COLUMN IF NOT EXISTS credit_type text;

COMMENT ON COLUMN public.driver_commission_wallet_ledger.credit_type IS
  'Admin Add Credit subtype. Used when entry_type = ADMIN_CREDIT. Legacy WELCOME_CREDIT / PROMOTIONAL_CREDIT rows may leave this null.';

CREATE INDEX IF NOT EXISTS driver_commission_wallet_ledger_credit_type_idx
  ON public.driver_commission_wallet_ledger (service_area_id, credit_type, created_at DESC)
  WHERE credit_type IS NOT NULL;
