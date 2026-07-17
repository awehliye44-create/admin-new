-- P0 Phase 3 — Driver Commission Wallet read-only page (internal test drivers only).
-- Default false: UK/EU and production Africa drivers never see the page until explicitly flagged.

ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS commission_wallet_test_access boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.drivers.commission_wallet_test_access IS
  'Phase 3: when true AND service-area Commission Wallet workflow is enabled, driver may open the read-only Commission Wallet page. Never infer from country.';
