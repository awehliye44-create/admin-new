-- A8B28F Stage C VERIFY — post-apply verify (safe read-only)
-- phase_a8b28f_stage_c_wallet_payout_eligibility_cutover_verify.sql
--
-- Does not mutate ledger, destinations, or driver pause flags.

DO $$
DECLARE
  v_elig text := pg_get_functiondef('public.driver_wallet_eligibility_balances(uuid)'::regprocedure);
  v_eff text := pg_get_functiondef('public.driver_effective_payout_allowed(uuid)'::regprocedure);
  v_sum text := pg_get_functiondef('public.driver_wallet_summary_ssot(uuid,uuid)'::regprocedure);
  v_res text := pg_get_functiondef('public.reserve_driver_payout_item(uuid)'::regprocedure);
  v_mk uuid;
  v_live bigint;
  v_avail bigint;
  v_pend bigint;
  v_eff_ok boolean;
  v_provider boolean;
  v_paused boolean;
  v_legacy boolean;
  v_early_block text;
  v_early_elig boolean;
  v_summary jsonb;
BEGIN
  -- 1) Function body locks
  IF v_elig LIKE '%v_payouts_enabled%' OR v_elig LIKE '%COALESCE(payouts_enabled, true)%' THEN
    RAISE EXCEPTION 'VERIFY_FAIL: eligibility still short-circuits on legacy payouts_enabled';
  END IF;
  IF v_elig NOT LIKE '%payout_operational_paused%' OR v_elig NOT LIKE '%v_operational_paused%' THEN
    RAISE EXCEPTION 'VERIFY_FAIL: eligibility missing operational pause short-circuit';
  END IF;
  IF v_elig NOT LIKE '%DRIVER_COLLECTED%' THEN
    RAISE EXCEPTION 'VERIFY_FAIL: DRIVER_COLLECTED clearing exclusion missing';
  END IF;

  IF v_eff LIKE '%v_legacy%' OR v_eff LIKE '%payouts_enabled, false)%' THEN
    RAISE EXCEPTION 'VERIFY_FAIL: effective helper still requires legacy payouts_enabled';
  END IF;
  IF v_eff NOT LIKE '%payout_operational_paused%' OR v_eff NOT LIKE '%driver_has_provider_verified_payout_destination%' THEN
    RAISE EXCEPTION 'VERIFY_FAIL: effective helper missing OP/provider gates';
  END IF;
  -- Global setting key must remain (admin_settings.payouts_enabled), not drivers.payouts_enabled conjunct.
  IF v_eff NOT LIKE '%setting_key = ''payouts_enabled''%' THEN
    RAISE EXCEPTION 'VERIFY_FAIL: effective helper missing global payouts_enabled setting read';
  END IF;

  IF v_sum LIKE '%v_driver.payouts_enabled%' THEN
    RAISE EXCEPTION 'VERIFY_FAIL: summary still maps legacy payouts_enabled → DRIVER_SUSPENDED';
  END IF;
  IF v_sum NOT LIKE '%ADMIN_HOLD%' OR v_sum NOT LIKE '%payout_operational_paused%' THEN
    RAISE EXCEPTION 'VERIFY_FAIL: summary missing operational pause → ADMIN_HOLD mapping';
  END IF;
  IF v_sum NOT LIKE '%PAYOUT_ACCOUNT_NOT_VERIFIED%' THEN
    RAISE EXCEPTION 'VERIFY_FAIL: summary missing provider verification block reason';
  END IF;
  IF v_sum NOT LIKE '%v5_a8b28f_stage_c%' THEN
    RAISE EXCEPTION 'VERIFY_FAIL: summary source_version not bumped to Stage C';
  END IF;

  IF v_res LIKE '%v_driver.payouts_enabled%' THEN
    RAISE EXCEPTION 'VERIFY_FAIL: reserve still gates on legacy payouts_enabled';
  END IF;
  IF v_res NOT LIKE '%driver_effective_payout_allowed%' THEN
    RAISE EXCEPTION 'VERIFY_FAIL: reserve missing effective helper gate';
  END IF;

  -- 2) MK0006 expected post-cutover (read-only)
  SELECT id, payout_operational_paused, payouts_enabled
  INTO v_mk, v_paused, v_legacy
  FROM public.drivers
  WHERE upper(driver_code) = 'MK0006'
  LIMIT 1;

  IF v_mk IS NULL THEN
    RAISE EXCEPTION 'VERIFY_FAIL: MK0006 not found';
  END IF;

  v_provider := public.driver_has_provider_verified_payout_destination(v_mk);
  v_eff_ok := public.driver_effective_payout_allowed(v_mk);

  SELECT b.live_balance_pence, b.available_balance_pence, b.pending_balance_pence
  INTO v_live, v_avail, v_pend
  FROM public.driver_wallet_eligibility_balances(v_mk) b;

  v_summary := public.driver_wallet_summary_ssot(v_mk, NULL);
  v_early_block := v_summary->>'early_cash_out_block_reason';
  v_early_elig := coalesce((v_summary->>'early_cash_out_eligible')::boolean, false);

  RAISE NOTICE 'MK0006 live=% avail=% pend=% provider=% paused=% legacy=% effective=% early_block=% early_elig=%',
    v_live, v_avail, v_pend, v_provider, v_paused, v_legacy, v_eff_ok, v_early_block, v_early_elig;

  IF v_provider IS NOT TRUE THEN
    RAISE EXCEPTION 'VERIFY_FAIL: MK0006 expected provider verified';
  END IF;
  IF coalesce(v_paused, false) IS TRUE THEN
    RAISE EXCEPTION 'VERIFY_FAIL: MK0006 unexpectedly operationally paused';
  END IF;
  -- Legacy may still be false; Stage C must ignore it for balances/effective.
  IF v_live IS DISTINCT FROM 425 THEN
    RAISE EXCEPTION 'VERIFY_FAIL: MK0006 live expected 425, got %', v_live;
  END IF;
  IF v_avail IS DISTINCT FROM 425 THEN
    RAISE EXCEPTION 'VERIFY_FAIL: MK0006 available expected 425, got %', v_avail;
  END IF;
  IF v_pend IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'VERIFY_FAIL: MK0006 pending expected 0, got %', v_pend;
  END IF;
  IF v_eff_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'VERIFY_FAIL: MK0006 effective_payout_allowed expected true';
  END IF;
  IF v_early_elig IS NOT TRUE THEN
    RAISE EXCEPTION 'VERIFY_FAIL: MK0006 early_cash_out_eligible expected true (no min/reservation block)';
  END IF;
  IF v_early_block IS NOT NULL AND length(trim(v_early_block)) > 0 THEN
    RAISE EXCEPTION 'VERIFY_FAIL: MK0006 early block expected null, got %', v_early_block;
  END IF;

  -- 3) Ledger unchanged probe (count only)
  IF (SELECT count(*) FROM public.driver_wallet_ledger WHERE driver_id = v_mk) <> 1 THEN
    RAISE EXCEPTION 'VERIFY_FAIL: MK0006 ledger row count changed';
  END IF;

  RAISE NOTICE 'A8B28F_STAGE_C_VERIFY_OK';
END $$;
