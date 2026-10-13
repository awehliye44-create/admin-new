-- ============================================================
-- DRAFT / REVIEW ONLY — DO NOT APPLY WITHOUT WRITTEN APPROVAL
-- Early cash-out fee: make admin_settings match the fee actually charged.
--
-- Owner decision (2026-10-13): the intended early cash-out fee is 50p.
-- Production driver_wallet_summary_ssot hard-codes 50p and ignores this
-- setting (0 since 2026-07-18). Migration 20261216120000 makes this setting
-- the only fee source, so it must read 50 BEFORE that migration is applied,
-- otherwise the live fee silently drops to 0.
--
-- Run order: this script -> 20261216120000 -> 20261216140000 -> corrections.
-- Behaviour-neutral until 20261216120000 lands: drivers are already charged 50p.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_old jsonb;
BEGIN
  SELECT setting_value INTO v_old
  FROM public.admin_settings
  WHERE setting_key = 'early_cashout_fee_pence'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'fee_setting_aborted: early_cashout_fee_pence row missing';
  END IF;

  IF v_old = to_jsonb(50) THEN
    RAISE NOTICE 'early_cashout_fee_pence already 50; nothing to do';
    RETURN;
  END IF;

  IF v_old IS DISTINCT FROM to_jsonb(0) THEN
    RAISE EXCEPTION 'fee_setting_aborted: expected 0, found %', v_old;
  END IF;

  UPDATE public.admin_settings
  SET setting_value = to_jsonb(50)
  WHERE setting_key = 'early_cashout_fee_pence';

  INSERT INTO public.payout_audit_log (
    driver_id, payout_type, event_type, requested_amount_pence, metadata
  ) VALUES (
    NULL,
    'EARLY_CASHOUT',
    'EARLY_CASHOUT_FEE_SETTING_ALIGNED',
    50,
    jsonb_build_object(
      'setting_key', 'early_cashout_fee_pence',
      'old_value', v_old,
      'new_value', 50,
      'reason', 'Align admin setting with the 50p fee charged since 2026-07-18; owner approved 2026-10-13',
      'runtime_fee_before_change_pence', 50
    )
  );
END $$;

SELECT setting_key, setting_value, updated_at
FROM public.admin_settings
WHERE setting_key IN ('early_cashout_fee_pence', 'early_cashout_min_pence');

COMMIT;
