-- ============================================================
-- A8B28F Stage A — payout operational pause foundation
-- 20261109430000_phase_a8b28f_payout_operational_pause_foundation.sql
--
-- Additive compatibility ONLY.
-- Does NOT change wallet balances, clearing, withdrawal, payout,
-- destination verification, scheduler, provider, ledger, payment,
-- trip, cron, or Edge behavior.
--
-- Explicitly OMITTED from this Stage A apply:
--   authorised Admin operational-pause dual-write RPC
-- Reason: that RPC requires a complete authz fixture matrix
-- (spoofed actor, inactive staff, customer/driver/corporate/no-role,
-- PUBLIC/anon) before it is safe to ship. Deferred to Stage B redesign.
-- Do not apply a partially safe RPC.
--
-- Stage B (Edge/Admin/Driver) and Stage C eligibility cutover
-- are NOT approved and must not be applied here.
-- Paused SECDEF A8B28 remains untouched.
-- ============================================================

BEGIN;

-- 1) Additive column
ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS payout_operational_paused boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.drivers.payout_operational_paused IS
  'A8B28F Stage A: intentional Admin/compliance operational pause. Independent of provider destination verification. Legacy drivers.payouts_enabled remains the live reader gate until Stage C cutover.';

-- 2) Conservative backfill — ONLY verified-active + legacy payouts_enabled false.
-- Expected count: 1 (the known verified-but-disabled driver).
-- MK0006 (failed/pending, legacy false) must NOT match.
UPDATE public.drivers d
SET payout_operational_paused = true
WHERE coalesce(d.payouts_enabled, false) IS NOT TRUE
  AND EXISTS (
    SELECT 1
    FROM public.driver_payout_destinations p
    WHERE p.driver_id = d.id
      AND p.is_active IS TRUE
      AND p.archived_at IS NULL
      AND upper(coalesce(p.provider_link_status, '')) = 'PROVIDER_VERIFIED'
      AND p.provider_counterparty_id IS NOT NULL
  );

-- 3) Additive helpers — NOT wired into wallet/withdrawal/scheduler readers.
-- Stage A preserves legacy payouts_enabled as a required conjunct in effective helper.
CREATE OR REPLACE FUNCTION public.driver_has_provider_verified_payout_destination(p_driver_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  -- Provider authority only. MANUAL_VERIFIED is intentionally excluded.
  SELECT EXISTS (
    SELECT 1
    FROM public.driver_payout_destinations p
    WHERE p.driver_id = p_driver_id
      AND p.is_active IS TRUE
      AND p.archived_at IS NULL
      AND upper(coalesce(p.provider_link_status, '')) = 'PROVIDER_VERIFIED'
      AND upper(coalesce(p.verification_status, '')) IS DISTINCT FROM 'MANUAL_VERIFIED'
      AND p.provider_counterparty_id IS NOT NULL
      AND p.provider_recipient_account_id IS NOT NULL
  );
$$;

COMMENT ON FUNCTION public.driver_has_provider_verified_payout_destination(uuid) IS
  'A8B28F Stage A additive helper. True only for active PROVIDER_VERIFIED destinations with counterparty+recipient refs. Rejects MANUAL_VERIFIED. Not wired into live eligibility readers until Stage C.';

CREATE OR REPLACE FUNCTION public.driver_effective_payout_allowed(p_driver_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_global boolean := true;
  v_paused boolean := false;
  v_legacy boolean := false;
  v_approved boolean := false;
  v_suspended boolean := false;
  v_provider boolean := false;
  v_setting text;
BEGIN
  IF p_driver_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT setting_value::text
  INTO v_setting
  FROM public.admin_settings
  WHERE setting_key = 'payouts_enabled'
  LIMIT 1;
  v_global := lower(coalesce(v_setting, 'true')) IS DISTINCT FROM 'false';

  SELECT
    coalesce(d.payout_operational_paused, false),
    coalesce(d.payouts_enabled, false),
    lower(coalesce(d.approval_status, '')) IN ('approved', 'active'),
    lower(d.driver_status::text) IN ('suspended', 'banned', 'blocked', 'inactive')
  INTO v_paused, v_legacy, v_approved, v_suspended
  FROM public.drivers d
  WHERE d.id = p_driver_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_provider := public.driver_has_provider_verified_payout_destination(p_driver_id);

  -- Stage A fail-closed: ALL conjuncts required, including legacy payouts_enabled.
  -- Stage C will drop the legacy conjunct only after Stage B cutover is live.
  IF NOT v_global THEN RETURN false; END IF;
  IF v_suspended THEN RETURN false; END IF;
  IF NOT v_approved THEN RETURN false; END IF;
  IF v_paused THEN RETURN false; END IF;
  IF v_legacy IS NOT TRUE THEN RETURN false; END IF;
  IF NOT v_provider THEN RETURN false; END IF;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.driver_effective_payout_allowed(uuid) IS
  'A8B28F Stage A additive helper. effective = global AND provider_verified_active AND NOT operational_paused AND approved/not suspended AND legacy payouts_enabled. Not wired into production readers until Stage C.';

REVOKE ALL ON FUNCTION public.driver_has_provider_verified_payout_destination(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_has_provider_verified_payout_destination(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.driver_has_provider_verified_payout_destination(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_has_provider_verified_payout_destination(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.driver_effective_payout_allowed(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_effective_payout_allowed(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.driver_effective_payout_allowed(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_effective_payout_allowed(uuid) TO service_role;

COMMIT;
