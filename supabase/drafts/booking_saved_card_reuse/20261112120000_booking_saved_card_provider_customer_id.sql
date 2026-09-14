-- CANONICAL — NOT APPLIED. Do not copy into supabase/migrations until deploy approval.
-- Latest applied production migration at audit: 20261109460000.
-- Latest local migration file at audit: 20261109600000. This version is after both.
--
-- Purpose: let Edge persist Revolut customer id on an explicit save.
-- Uniqueness already exists in production as
--   idx_customer_saved_pm_tokens_provider_pm_unique
--   (user_id, payment_provider, provider_payment_method_id)
--   WHERE provider_payment_method_id IS NOT NULL AND btrim(...) <> ''.
-- Do not create a second unique index. A fingerprint column is not required.
--
-- Rollback (only after the new Edge upsert is reverted):
--   ALTER TABLE public.customer_saved_payment_method_tokens
--     DROP COLUMN IF EXISTS provider_customer_id;
-- Do not drop idx_customer_saved_pm_tokens_provider_pm_unique. It predates this change.

ALTER TABLE public.customer_saved_payment_method_tokens
  ADD COLUMN IF NOT EXISTS provider_customer_id text;

COMMENT ON COLUMN public.customer_saved_payment_method_tokens.provider_customer_id IS
  'Revolut customer id used when this method was saved. Not a PAN or token secret.';

-- Fresh databases that lack the production unique index get the same index.
-- Production already has this name, so this is a no-op there.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_saved_pm_tokens_provider_pm_unique
  ON public.customer_saved_payment_method_tokens (user_id, payment_provider, provider_payment_method_id)
  WHERE provider_payment_method_id IS NOT NULL
    AND btrim(provider_payment_method_id) <> '';
