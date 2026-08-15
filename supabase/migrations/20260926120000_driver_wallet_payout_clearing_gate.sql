-- Driver Wallet Ledger payout-clearing gate (PLATFORM_COLLECTED).
-- Capture is necessary but not sufficient for Available.
-- Pending = earned / captured but not payout-cleared. Reservations stay separate.
-- Eligibility reclassification only — no new TRIP_EARNING_NET rows.

BEGIN;

INSERT INTO public.admin_settings (setting_key, setting_value, description)
VALUES (
  'payout_clearing_delay_hours',
  '48'::jsonb,
  'Backend-owned PLATFORM_COLLECTED payout-clearing fallback (hours). Used only when Revolut has not exposed a merchant-clearing event. Never a Driver-app timer.'
)
ON CONFLICT (setting_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.driver_wallet_payout_clearing_delay_hours()
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_raw jsonb;
  v_hours numeric;
BEGIN
  SELECT setting_value INTO v_raw
  FROM public.admin_settings
  WHERE setting_key = 'payout_clearing_delay_hours'
  LIMIT 1;

  IF v_raw IS NULL THEN
    RETURN 48;
  END IF;

  BEGIN
    IF jsonb_typeof(v_raw) = 'number' THEN
      v_hours := (v_raw #>> '{}')::numeric;
    ELSE
      v_hours := NULLIF(btrim(v_raw #>> '{}', '"'), '')::numeric;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN 48;
  END;

  IF v_hours IS NULL OR v_hours < 0 THEN
    RETURN 48;
  END IF;
  RETURN v_hours;
END;
$$;

CREATE OR REPLACE FUNCTION public.driver_wallet_provider_funds_cleared(p_state text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_state IS NULL OR btrim(p_state) = '' THEN false
    WHEN upper(regexp_replace(p_state, '[\s-]+', '_', 'g')) IN (
      'COMPLETED', 'CAPTURED', 'AUTHORISED', 'AUTHORIZED', 'PROCESSING', 'PENDING'
    ) THEN false
    WHEN upper(regexp_replace(p_state, '[\s-]+', '_', 'g')) LIKE '%SETTLE%' THEN true
    WHEN upper(regexp_replace(p_state, '[\s-]+', '_', 'g')) IN (
      'AVAILABLE', 'PAID_OUT', 'FUNDS_AVAILABLE'
    ) THEN true
    WHEN upper(regexp_replace(p_state, '[\s-]+', '_', 'g')) LIKE '%BALANCE_AVAILABLE%' THEN true
    ELSE false
  END;
$$;

CREATE OR REPLACE FUNCTION public.driver_wallet_eligibility_balances(p_driver_id uuid)
RETURNS TABLE (
  live_balance_pence bigint,
  available_balance_pence bigint,
  pending_balance_pence bigint,
  withdrawal_in_progress_pence bigint,
  outstanding_debt_pence bigint,
  eligible_earnings_pence bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_live bigint := 0;
  v_debt bigint := 0;
  v_reserved bigint := 0;
  v_in_flight bigint := 0;
  v_withdrawal bigint := 0;
  v_eligible bigint := 0;
  v_pending bigint := 0;
  v_available bigint := 0;
  v_delay_hours numeric := 48;
  v_payouts_enabled boolean := true;
  r record;
  v_captured bigint;
  v_canonical bigint;
  v_refunded bigint;
  v_session_status text;
  v_allocated bigint;
  v_model text;
  v_method text;
  v_requires_clearing boolean;
  v_cleared boolean;
  v_origin timestamptz;
BEGIN
  v_live := public.driver_wallet_live_balance_pence(p_driver_id);
  v_reserved := public.driver_wallet_active_reservation_pence(p_driver_id);
  v_in_flight := public.driver_wallet_other_holds_pence(p_driver_id);
  v_withdrawal := GREATEST(0, v_reserved) + GREATEST(0, v_in_flight);
  v_delay_hours := public.driver_wallet_payout_clearing_delay_hours();

  SELECT COALESCE(payouts_enabled, true)
  INTO v_payouts_enabled
  FROM public.drivers
  WHERE id = p_driver_id;

  SELECT GREATEST(
    0,
    COALESCE(SUM(CASE WHEN type = 'CASH_COMMISSION_DEBT' THEN abs(amount_pence) ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN type = 'DEBT_RECOVERY' THEN abs(amount_pence) ELSE 0 END), 0)
  )::bigint
  INTO v_debt
  FROM public.driver_wallet_ledger
  WHERE driver_id = p_driver_id;

  IF v_payouts_enabled IS NOT TRUE THEN
    RETURN QUERY SELECT
      v_live,
      0::bigint,
      GREATEST(0, v_live)::bigint,
      v_withdrawal,
      GREATEST(0, v_debt)::bigint,
      0::bigint;
    RETURN;
  END IF;

  FOR r IN
    SELECT
      l.id AS ledger_id,
      l.type,
      l.amount_pence,
      l.related_trip_id,
      l.created_at,
      t.payment_collection_model::text AS payment_collection_model,
      t.financial_model::text AS financial_model,
      t.payment_method AS trip_payment_method,
      t.driver_net_pence,
      t.tip_pence,
      t.tip_amount_pence,
      t.provider_available_on AS trip_provider_available_on,
      ps.id AS session_id,
      ps.captured_amount_pence,
      ps.captured_at,
      ps.refunded_amount_pence,
      ps.status::text AS session_status,
      ps.provider_state,
      ps.payment_method AS session_payment_method,
      des.settled_at,
      des.settlement_status,
      des.provider_available_on AS des_provider_available_on,
      des.capture_time,
      des.allocated_to_payout,
      des.allocated_amount_pence,
      des.paid_in_batch_id,
      COALESCE(alloc.allocated_sum, 0)::bigint AS alloc_sum
    FROM public.driver_wallet_ledger l
    LEFT JOIN public.trips t ON t.id = l.related_trip_id
    LEFT JOIN LATERAL (
      SELECT s.*
      FROM public.payment_sessions s
      WHERE s.id = t.payment_session_id
         OR s.trip_id = t.id
      ORDER BY COALESCE(s.captured_amount_pence, 0) DESC, s.captured_at DESC NULLS LAST
      LIMIT 1
    ) ps ON true
    LEFT JOIN LATERAL (
      SELECT d.*
      FROM public.driver_earning_settlement d
      WHERE d.ledger_entry_id = l.id
      ORDER BY d.updated_at DESC NULLS LAST
      LIMIT 1
    ) des ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(a.amount_pence), 0) AS allocated_sum
      FROM public.payout_item_ledger_allocations a
      WHERE a.ledger_entry_id = l.id
    ) alloc ON true
    WHERE l.driver_id = p_driver_id
      AND l.type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT', 'TIP_CREDIT')
      AND l.amount_pence > 0
  LOOP
    IF r.paid_in_batch_id IS NOT NULL OR r.allocated_to_payout IS TRUE THEN
      CONTINUE;
    END IF;
    v_allocated := GREATEST(
      COALESCE(r.alloc_sum, 0),
      COALESCE(r.allocated_amount_pence, 0)
    );
    IF v_allocated >= r.amount_pence THEN
      CONTINUE;
    END IF;

    v_session_status := lower(COALESCE(r.session_status::text, ''));
    v_refunded := GREATEST(0, COALESCE(r.refunded_amount_pence, 0));
    IF v_refunded > 0
       OR v_session_status LIKE '%refund%'
       OR v_session_status LIKE '%chargeback%'
       OR v_session_status LIKE '%dispute%'
       OR v_session_status LIKE '%cancel%'
       OR v_session_status LIKE '%void%'
       OR lower(COALESCE(r.provider_state, '')) IN ('cancelled', 'canceled', 'failed', 'void') THEN
      CONTINUE;
    END IF;

    v_captured := CASE
      WHEN r.captured_amount_pence IS NULL THEN NULL
      ELSE round(r.captured_amount_pence)::bigint
    END;

    -- Uncaptured / authorised-only is not settlement Pending.
    IF r.session_id IS NULL OR v_captured IS NULL OR v_captured <= 0 THEN
      CONTINUE;
    END IF;

    IF upper(r.type) = 'TRIP_EARNING_NET' THEN
      v_canonical := GREATEST(0, COALESCE(r.driver_net_pence, 0));
    ELSE
      v_canonical := GREATEST(0, COALESCE(r.tip_pence, r.tip_amount_pence, 0));
    END IF;

    IF v_canonical <= 0 OR r.amount_pence <> v_canonical THEN
      CONTINUE;
    END IF;

    IF v_captured < v_canonical THEN
      CONTINUE;
    END IF;

    v_model := upper(btrim(COALESCE(
      r.payment_collection_model::text,
      r.financial_model::text,
      'PLATFORM_COLLECTED'
    )));
    v_method := lower(btrim(COALESCE(r.trip_payment_method, r.session_payment_method, '')));
    v_requires_clearing := (v_model NOT LIKE '%DRIVER_COLLECTED%')
      AND v_method NOT LIKE '%cash%';

    v_cleared := NOT v_requires_clearing;
    IF v_requires_clearing THEN
      IF COALESCE(r.des_provider_available_on, r.trip_provider_available_on) IS NOT NULL
         AND COALESCE(r.des_provider_available_on, r.trip_provider_available_on) <= now() THEN
        v_cleared := true;
      ELSIF public.driver_wallet_provider_funds_cleared(r.provider_state) THEN
        v_cleared := true;
      ELSE
        v_origin := COALESCE(r.captured_at, r.capture_time, r.created_at);
        IF v_origin IS NOT NULL
           AND (v_origin + (v_delay_hours * interval '1 hour')) <= now() THEN
          v_cleared := true;
        END IF;
      END IF;
    END IF;

    IF v_cleared THEN
      v_eligible := v_eligible + r.amount_pence;
    ELSE
      v_pending := v_pending + r.amount_pence;
    END IF;
  END LOOP;

  v_available := GREATEST(
    0,
    LEAST(GREATEST(0, v_live), v_eligible) - GREATEST(0, v_debt) - v_withdrawal
  );

  RETURN QUERY SELECT
    v_live,
    v_available,
    GREATEST(0, v_pending)::bigint,
    v_withdrawal,
    GREATEST(0, v_debt)::bigint,
    GREATEST(0, v_eligible)::bigint;
END;
$$;

CREATE OR REPLACE FUNCTION public.driver_wallet_available_for_payout_pence(p_driver_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT available_balance_pence
  FROM public.driver_wallet_eligibility_balances(p_driver_id);
$$;

CREATE OR REPLACE FUNCTION public.driver_wallet_summary_ssot(p_driver_id uuid, p_service_area_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
      amount_pence,
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

  WITH deduped_today AS (
    SELECT DISTINCT ON (related_trip_id, type)
      amount_pence
    FROM public.driver_wallet_ledger
    WHERE driver_id = p_driver_id
      AND type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT')
      AND related_trip_id IS NOT NULL
      AND created_at >= v_today_start
      AND created_at < v_today_end
    ORDER BY related_trip_id, type, created_at DESC
  )
  SELECT COALESCE(SUM(amount_pence), 0)::bigint INTO v_today_earnings
  FROM deduped_today;

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
    v_early_block := NULL;
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
    'source_version', 'driver_wallet_summary_ssot_v3'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_driver_own_wallet_summary(p_service_area_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_driver_id uuid;
BEGIN
  v_driver_id := public.current_driver_id();
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'driver_not_found');
  END IF;
  RETURN public.driver_wallet_summary_ssot(v_driver_id, p_service_area_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.driver_wallet_payout_clearing_delay_hours() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.driver_wallet_provider_funds_cleared(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.driver_wallet_eligibility_balances(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.driver_wallet_available_for_payout_pence(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.driver_wallet_summary_ssot(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_own_wallet_summary(uuid) TO authenticated, service_role;

COMMIT;
