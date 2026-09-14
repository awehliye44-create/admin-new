-- A8B28F Stage A — DRAFT / NOT APPLIED
-- 20261109430000_phase_a8b28f_stage_a_additive_operational_pause.sql
-- Additive ONLY. Does NOT change driver_wallet_eligibility_balances behavior.
-- Does NOT mutate MK0006 destination/ledger. Does NOT enable payouts.

BEGIN;

ALTER TABLE public.drivers
  ADD COLUMN IF NOT EXISTS payout_operational_paused boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.drivers.payout_operational_paused IS
  'A8B28F Option B: intentional Admin/compliance pause. Independent of provider destination verification. Stage A additive; eligibility still uses legacy payouts_enabled until Stage C.';

-- Conservative backfill: ONLY proven intentional-pause cohort.
-- verified active dest + refs + legacy payouts_enabled false → paused.
-- All other cohorts remain paused=false (blocked later by provider capability / legacy flag).
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

-- Read-only helper (not wired into eligibility until Stage C).
CREATE OR REPLACE FUNCTION public.driver_has_provider_verified_payout_destination(p_driver_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.driver_payout_destinations p
    WHERE p.driver_id = p_driver_id
      AND p.is_active IS TRUE
      AND p.archived_at IS NULL
      AND upper(coalesce(p.provider_link_status, '')) = 'PROVIDER_VERIFIED'
      AND p.provider_counterparty_id IS NOT NULL
      AND p.provider_recipient_account_id IS NOT NULL
  );
$$;

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
  v_legacy boolean := true;
  v_approved boolean := false;
  v_suspended boolean := false;
  v_provider boolean := false;
  v_setting text;
BEGIN
  SELECT setting_value::text INTO v_setting
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

  -- Stage A/B compatibility: still require legacy payouts_enabled OR (after Stage B writers)
  -- operational pause field. Fail closed if either pause signal is set.
  IF NOT v_global THEN RETURN false; END IF;
  IF v_suspended THEN RETURN false; END IF;
  IF NOT v_approved THEN RETURN false; END IF;
  IF v_paused THEN RETURN false; END IF;
  IF coalesce(v_legacy, false) IS NOT TRUE THEN RETURN false; END IF;
  IF NOT v_provider THEN RETURN false; END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.driver_has_provider_verified_payout_destination(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_effective_payout_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.driver_has_provider_verified_payout_destination(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.driver_effective_payout_allowed(uuid) TO authenticated, service_role;

-- Dual-write Admin pause RPC (optional path). Old direct-table Admin writes remain valid in Stage A.
CREATE OR REPLACE FUNCTION public.admin_set_driver_payout_operational_pause(
  p_driver_id uuid,
  p_paused boolean,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_before_paused boolean;
  v_before_legacy boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.has_role(v_uid, 'admin'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role)
    OR public.staff_has_company_funds_read_access('payout-ledger')
  ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT payout_operational_paused, coalesce(payouts_enabled, false)
  INTO v_before_paused, v_before_legacy
  FROM public.drivers
  WHERE id = p_driver_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'driver_not_found');
  END IF;

  UPDATE public.drivers
  SET
    payout_operational_paused = coalesce(p_paused, false),
    -- Dual-write legacy flag for Stage A/B mixed deployments:
    -- paused => payouts_enabled false; resume => payouts_enabled true.
    payouts_enabled = CASE WHEN coalesce(p_paused, false) THEN false ELSE true END,
    updated_at = now()
  WHERE id = p_driver_id;

  INSERT INTO public.driver_payout_destination_audit (
    driver_id,
    provider,
    action,
    previous_payload,
    new_payload,
    changed_by_user_id,
    changed_by_role,
    metadata
  ) VALUES (
    p_driver_id,
    'system',
    CASE WHEN coalesce(p_paused, false) THEN 'operational_pause' ELSE 'operational_resume' END,
    jsonb_build_object(
      'payout_operational_paused', v_before_paused,
      'payouts_enabled', v_before_legacy
    ),
    jsonb_build_object(
      'payout_operational_paused', coalesce(p_paused, false),
      'payouts_enabled', CASE WHEN coalesce(p_paused, false) THEN false ELSE true END,
      'reason', left(coalesce(p_reason, ''), 200)
    ),
    v_uid,
    'admin',
    jsonb_build_object('wallet_mutated', false, 'destination_mutated', false)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'driver_id', p_driver_id,
    'payout_operational_paused', coalesce(p_paused, false),
    'payouts_enabled', CASE WHEN coalesce(p_paused, false) THEN false ELSE true END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) TO service_role;

COMMIT;
