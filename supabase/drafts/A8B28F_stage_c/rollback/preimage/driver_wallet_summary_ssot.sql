CREATE OR REPLACE FUNCTION public.driver_wallet_summary_ssot(p_driver_id uuid, p_service_area_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_driver public.drivers%ROWTYPE;
  v_currency text := 'GBP';
  v_timezone text := 'Europe/London';
  v_cycle_start timestamptz := '1970-01-01 00:00:00+00'::timestamptz;
  v_cycle_end timestamptz := now();
  v_cycle_earnings bigint := 0;
  v_today_earnings bigint := 0;
  v_live bigint := 0;
  v_reserved bigint := 0;
  v_other_holds bigint := 0;
  v_available bigint := 0;
  v_pending bigint := 0;
  v_withdrawal bigint := 0;
  v_minimum bigint := 2000;
  v_amount_needed bigint := 0;
  v_eligibility text := 'NOT_CURRENTLY_ELIGIBLE';
  v_next_payout timestamptz := NULL;
  v_today_start timestamptz;
  v_today_end timestamptz;
  v_early_enabled boolean := false;
  v_early_fee bigint := 50;
  v_early_available bigint := 0;
  v_early_minimum bigint := 51;
  v_early_eligible boolean := false;
  v_early_block text := NULL;
  v_early_provider text := NULL;
  v_dest_verified boolean := false;
  v_cashout_processing boolean := false;
  v_payout_gateway text := NULL;
BEGIN
  SELECT * INTO v_driver
  FROM public.drivers
  WHERE id = p_driver_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'driver_not_found',
      'driver_id', p_driver_id
    );
  END IF;

  SELECT COALESCE(sa.currency_code, r.currency_code, 'GBP')
  INTO v_currency
  FROM public.drivers d
  LEFT JOIN public.service_areas sa ON sa.id = COALESCE(p_service_area_id, d.service_area_id)
  LEFT JOIN public.regions r ON r.id = d.region_id
  WHERE d.id = p_driver_id;

  SELECT COALESCE(
    (SELECT timezone FROM public.service_areas WHERE id = COALESCE(p_service_area_id, v_driver.service_area_id)),
    (SELECT r.timezone FROM public.regions r WHERE r.id = v_driver.region_id),
    'Europe/London'
  ) INTO v_timezone;

  SELECT COALESCE(sa.early_cashout_enabled, false)
  INTO v_early_enabled
  FROM public.drivers d
  LEFT JOIN public.service_areas sa ON sa.id = COALESCE(p_service_area_id, d.service_area_id)
  WHERE d.id = p_driver_id;

  SELECT MAX(created_at) INTO v_cycle_start
  FROM public.driver_wallet_ledger
  WHERE driver_id = p_driver_id
    AND type IN ('WEEKLY_PAYOUT', 'EARLY_CASHOUT', 'MANUAL_PAYOUT', 'PAYOUT')
    AND amount_pence < 0;

  v_cycle_start := COALESCE(v_cycle_start, '1970-01-01 00:00:00+00'::timestamptz);

  WITH deduped AS (
    SELECT DISTINCT ON (related_trip_id, type)
      amount_pence::bigint AS amount_pence,
      created_at
    FROM public.driver_wallet_ledger
    WHERE driver_id = p_driver_id
      AND type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT')
      AND related_trip_id IS NOT NULL
      AND created_at >= v_cycle_start
    ORDER BY related_trip_id, type, created_at DESC
  )
  SELECT COALESCE(SUM(amount_pence), 0)::bigint INTO v_cycle_earnings
  FROM deduped;

  v_today_start := (
    (timezone(v_timezone, now()))::date::text || ' 00:00:00'
  )::timestamp AT TIME ZONE v_timezone;
  v_today_end := v_today_start + interval '1 day';

  v_today_earnings := public.driver_wallet_trip_earnings_in_range_pence(
    p_driver_id,
    v_today_start,
    v_today_end
  );

  SELECT
    b.live_balance_pence,
    b.available_balance_pence,
    b.pending_balance_pence,
    b.withdrawal_in_progress_pence
  INTO v_live, v_available, v_pending, v_withdrawal
  FROM public.driver_wallet_eligibility_balances(p_driver_id) b;

  v_reserved := public.driver_wallet_active_reservation_pence(p_driver_id);
  v_other_holds := public.driver_wallet_other_holds_pence(p_driver_id);
  v_amount_needed := GREATEST(0, v_minimum - v_available)::bigint;

  IF v_reserved > 0 THEN
    v_eligibility := 'RESERVED_FOR_PAYOUT';
  ELSIF v_available >= v_minimum THEN
    v_eligibility := 'ELIGIBLE';
  ELSIF v_available > 0 THEN
    v_eligibility := 'BELOW_MINIMUM_THRESHOLD';
  ELSE
    v_eligibility := 'NOT_CURRENTLY_ELIGIBLE';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.driver_early_cashouts
    WHERE driver_id = p_driver_id
      AND status IN ('pending', 'processing')
  )
  OR EXISTS (
    SELECT 1
    FROM public.payout_items pi
    JOIN public.payout_batches pb ON pb.id = pi.batch_id
    WHERE pi.driver_id = p_driver_id
      AND pb.kind = 'EARLY_CASHOUT'
      AND upper(COALESCE(pi.status, '')) IN (
        'VALIDATED', 'RESERVING', 'RESERVED', 'SUBMITTING', 'SUBMITTED', 'UNKNOWN'
      )
  )
  OR EXISTS (
    SELECT 1
    FROM public.driver_payout_reservations r
    WHERE r.driver_id = p_driver_id
      AND r.status = 'ACTIVE'
  ) INTO v_cashout_processing;

  SELECT EXISTS (
    SELECT 1
    FROM public.driver_payout_destinations dpd
    WHERE dpd.driver_id = p_driver_id
      AND dpd.is_active IS TRUE
      AND dpd.archived_at IS NULL
      AND upper(coalesce(dpd.provider_link_status, '')) = 'PROVIDER_VERIFIED'
  ) INTO v_dest_verified;

  SELECT NULLIF(trim(coalesce(payment_provider, '')), '')
  INTO v_early_provider
  FROM public.service_areas
  WHERE id = COALESCE(p_service_area_id, v_driver.service_area_id);

  v_early_available := GREATEST(0, v_available)::bigint;

  IF NOT v_early_enabled THEN
    v_early_block := 'FEATURE_DISABLED';
  ELSIF upper(v_currency) <> 'GBP' THEN
    v_early_block := 'CURRENCY_MISMATCH';
  ELSIF COALESCE(v_driver.payouts_enabled, false) IS NOT TRUE THEN
    v_early_block := 'DRIVER_SUSPENDED';
  ELSIF v_cashout_processing THEN
    v_early_block := 'CASHOUT_ALREADY_PROCESSING';
  ELSIF NOT v_dest_verified THEN
    v_early_block := 'PAYOUT_ACCOUNT_NOT_VERIFIED';
  ELSIF v_early_provider IS NULL
       OR lower(v_early_provider) IS DISTINCT FROM 'revolut' THEN
    v_early_block := 'PROVIDER_UNAVAILABLE';
  ELSIF v_reserved > 0 AND v_early_available <= 0 THEN
    v_early_block := 'ACTIVE_PAYOUT_RESERVATION';
  ELSIF v_early_available <= 0 THEN
    v_early_block := 'NO_AVAILABLE_BALANCE';
  ELSIF v_early_available <= v_early_fee THEN
    v_early_block := 'BALANCE_NOT_GREATER_THAN_FEE';
  ELSE
    v_early_eligible := true;
    v_early_block := NULL::text;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'driver_id', p_driver_id,
    'service_area_id', COALESCE(p_service_area_id, v_driver.service_area_id),
    'currency', upper(COALESCE(v_currency, 'GBP')),
    'payout_cycle_start', v_cycle_start,
    'payout_cycle_end', v_cycle_end,
    'current_cycle_trip_earnings_pence', v_cycle_earnings,
    'live_wallet_balance_pence', v_live,
    'live_balance_pence', v_live,
    'active_reserved_payout_pence', v_reserved,
    'available_for_payout_pence', v_available,
    'available_balance_pence', v_available,
    'pending_balance_pence', v_pending,
    'withdrawal_in_progress_pence', v_withdrawal,
    'minimum_payout_pence', v_minimum,
    'amount_needed_for_minimum_pence', v_amount_needed,
    'payout_eligibility_status', v_eligibility,
    'next_payout_at', v_next_payout,
    'today_trip_earnings_pence', v_today_earnings,
    'early_cash_out_enabled', v_early_enabled,
    'early_cash_out_fee_pence', v_early_fee,
    'early_cash_out_available_pence', v_early_available,
    'early_cash_out_minimum_pence', v_early_minimum,
    'early_cash_out_eligible', v_early_eligible,
    'early_cash_out_block_reason', v_early_block,
    'early_cash_out_provider', v_early_provider,
    'active_weekly_reservation_pence', v_reserved,
    'early_cash_out_requested_pence', CASE WHEN v_early_eligible THEN v_early_available ELSE 0 END,
    'early_cash_out_driver_receives_pence', CASE
      WHEN v_early_eligible THEN GREATEST(0, v_early_available - v_early_fee)
      ELSE 0
    END,
    'updated_at', now(),
    'source_version', 'driver_wallet_summary_ssot_v4_economic_earned_at'
  );
END;
$function$;
