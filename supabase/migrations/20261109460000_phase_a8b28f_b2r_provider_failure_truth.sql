-- ============================================================
-- A8B28F-B2R Stage 1: provider failure truth (DB only)
-- Additive columns + expanded audit action CHECK.
-- Does NOT fabricate provider verification.
-- Does NOT mutate wallet ledger / balances.
-- Does NOT call Revolut / retry destinations.
-- ============================================================

-- 1) First-class failure truth columns (nullable; existing rows unchanged).
ALTER TABLE public.driver_payout_destinations
  ADD COLUMN IF NOT EXISTS provider_link_failure_class text,
  ADD COLUMN IF NOT EXISTS provider_http_status integer;

COMMENT ON COLUMN public.driver_payout_destinations.provider_link_failure_class IS
  'A8B28F-B2R normalized provider link failure class (e.g. PROVIDER_CONFIGURATION_REQUIRED).';
COMMENT ON COLUMN public.driver_payout_destinations.provider_http_status IS
  'A8B28F-B2R provider HTTP status from counterparty create (e.g. 403).';

-- 2) Expand audit action allowlist so provider auto-link failure/success audits can land.
ALTER TABLE public.driver_payout_destination_audit
  DROP CONSTRAINT IF EXISTS driver_payout_destination_audit_action_check;

ALTER TABLE public.driver_payout_destination_audit
  ADD CONSTRAINT driver_payout_destination_audit_action_check
  CHECK (action = ANY (ARRAY[
    'created'::text,
    'updated'::text,
    'deactivated'::text,
    'provider_link_blocked'::text,
    'provider_link_synced'::text,
    'provider_auto_link_failed'::text,
    'provider_auto_linked'::text,
    'reject'::text,
    'disable'::text
  ]));

-- 3) System actor may omit JWT subject (Edge still supplies initiating driver user id today).
ALTER TABLE public.driver_payout_destination_audit
  ALTER COLUMN changed_by_user_id DROP NOT NULL;
