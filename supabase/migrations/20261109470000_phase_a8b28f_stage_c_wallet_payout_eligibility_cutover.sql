-- A8B28F Stage C — APPLY-APPROVED
-- 20261109470000_phase_a8b28f_stage_c_wallet_payout_eligibility_cutover.sql
--
-- Cutover ONLY:
--   1) driver_wallet_eligibility_balances:
--        FROM: IF coalesce(payouts_enabled,true) IS NOT TRUE THEN available=0; pending=live
--        TO:   IF coalesce(payout_operational_paused,false) IS TRUE THEN available=0; pending=live
--   2) driver_effective_payout_allowed: DROP legacy drivers.payouts_enabled conjunct
--   3) driver_wallet_summary_ssot early block:
--        REPLACE payouts_enabled false → DRIVER_SUSPENDED
--        WITH: suspend / not-approved / global off / operational pause / provider unverified
--   4) reserve_driver_payout_item: gate via driver_effective_payout_allowed
--
-- MUST NOT:
--   - mutate driver_wallet_ledger / balances rows
--   - flip drivers.payouts_enabled
--   - alter clearing delay / PLATFORM vs DRIVER_COLLECTED math
--   - verify destinations / call provider
--   - touch commission wallet writers
--
-- Approved balance matrix (SSOT):
--   Available = cleared unpaid when NOT operationally paused (verification does not zero Available)
--   Pending = uncleared clearing only (when not paused); when paused pending = live pool presentation
--   Withdrawable = available>0 AND effective_payout_allowed AND fee/min gates
--
-- Canonical apply path. Stage C wallet payout eligibility cutover.

-- 1) Effective withdraw permission — drop legacy payouts_enabled conjunct

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
    lower(coalesce(d.approval_status, '')) IN ('approved', 'active'),
    lower(d.driver_status::text) IN ('disabled', 'deleted', 'suspended', 'banned', 'blocked', 'inactive')
  INTO v_paused, v_approved, v_suspended
  FROM public.drivers d
  WHERE d.id = p_driver_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_provider := public.driver_has_provider_verified_payout_destination(p_driver_id);

  -- A8B28F Stage C: drop legacy drivers.payouts_enabled conjunct.
  -- effective = global AND NOT suspended AND approved AND NOT operational_paused AND provider_verified.
  IF NOT v_global THEN RETURN false; END IF;
  IF v_suspended THEN RETURN false; END IF;
  IF NOT v_approved THEN RETURN false; END IF;
  IF v_paused THEN RETURN false; END IF;
  IF NOT v_provider THEN RETURN false; END IF;
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.driver_effective_payout_allowed(uuid) IS
  'A8B28F Stage C: effective = global admin_settings.payouts_enabled AND provider_verified_active AND NOT payout_operational_paused AND approved/not suspended. Does NOT require legacy drivers.payouts_enabled.';

-- 2) Eligibility balances — OP pause short-circuit only (verification must not zero Available)

CREATE OR REPLACE FUNCTION public.driver_wallet_eligibility_balances(p_driver_id uuid)
 RETURNS TABLE(live_balance_pence bigint, available_balance_pence bigint, pending_balance_pence bigint, withdrawal_in_progress_pence bigint, outstanding_debt_pence bigint, eligible_earnings_pence bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_live bigint := 0;
  v_debt bigint := 0;
  v_reserved bigint := 0;
  v_in_flight bigint := 0;
  v_withdrawal bigint := 0;
  v_eligible bigint := 0;
  v_pending bigint := 0;
  v_unpaid_eligible bigint := 0;
  v_available bigint := 0;
  v_delay_hours numeric := 48;
  v_operational_paused boolean := false;
  r record;
  v_captured bigint;
  v_canonical bigint;
  v_refunded bigint;
  v_session_status text;
  v_allocated bigint;
  v_unpaid bigint;
  v_model text;
  v_method text;
  v_requires_clearing boolean;
  v_cleared boolean;
  v_origin timestamptz;
  v_first_captured timestamptz;
BEGIN
  PERFORM public.assert_driver_wallet_read_access(p_driver_id);

  v_live := public.driver_wallet_live_balance_pence(p_driver_id);
  v_reserved := public.driver_wallet_active_reservation_pence(p_driver_id);
  v_in_flight := public.driver_wallet_other_holds_pence(p_driver_id);
  v_withdrawal := GREATEST(0, v_reserved) + GREATEST(0, v_in_flight);
  v_delay_hours := public.driver_wallet_payout_clearing_delay_hours();

  SELECT COALESCE(payout_operational_paused, false)
  INTO v_operational_paused
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

  -- A8B28F Stage C: operational pause zeros Available; verification does NOT.
  IF v_operational_paused IS TRUE THEN
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
      t.status::text AS trip_status,
      t.cancelled_at AS trip_cancelled_at,
      t.completed_at AS trip_completed_at,
      t.driver_net_pence,
      t.tip_pence,
      t.tip_amount_pence,
      t.provider_available_on AS trip_provider_available_on,
      ps.id AS session_id,
      ps.captured_amount_pence,
      ps.captured_at,
      ps.metadata AS session_metadata,
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
      des.paid_in_payout_item_id,
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
      INNER JOIN public.payout_items pi ON pi.id = a.payout_item_id
      WHERE a.ledger_entry_id = l.id
        AND NOT public.payout_item_status_releases_ledger_allocation(pi.status, pi.execution_status)
    ) alloc ON true
    WHERE l.driver_id = p_driver_id
      AND l.type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT', 'TIP_CREDIT')
      AND l.amount_pence > 0
  LOOP
    IF r.paid_in_batch_id IS NOT NULL
       OR r.allocated_to_payout IS TRUE
       OR r.paid_in_payout_item_id IS NOT NULL THEN
      CONTINUE;
    END IF;

    v_allocated := GREATEST(
      COALESCE(r.alloc_sum, 0),
      COALESCE(r.allocated_amount_pence, 0)
    );
    v_unpaid := GREATEST(0, r.amount_pence - v_allocated);
    IF v_unpaid <= 0 THEN
      CONTINUE;
    END IF;

    IF r.related_trip_id IS NULL THEN
      CONTINUE;
    END IF;
    IF r.trip_cancelled_at IS NOT NULL THEN
      CONTINUE;
    END IF;
    IF lower(COALESCE(r.trip_status, '')) LIKE '%cancel%' THEN
      CONTINUE;
    END IF;
    IF lower(btrim(COALESCE(r.trip_status, ''))) <> 'completed'
       AND r.trip_completed_at IS NULL THEN
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
        v_first_captured := NULL;
        IF r.session_metadata IS NOT NULL
           AND jsonb_typeof(r.session_metadata) = 'object'
           AND NULLIF(btrim(r.session_metadata->>'first_captured_at'), '') IS NOT NULL THEN
          BEGIN
            v_first_captured := (r.session_metadata->>'first_captured_at')::timestamptz;
          EXCEPTION WHEN OTHERS THEN
            v_first_captured := NULL;
          END;
        END IF;

        v_origin := public.driver_wallet_stable_clearing_origin(
          r.captured_at,
          r.trip_completed_at,
          r.capture_time,
          r.created_at,
          v_first_captured
        );
        IF v_origin IS NOT NULL
           AND (v_origin + (v_delay_hours * interval '1 hour')) <= now() THEN
          v_cleared := true;
        END IF;
      END IF;
    END IF;

    IF v_cleared THEN
      v_eligible := v_eligible + v_unpaid;
    ELSE
      v_pending := v_pending + v_unpaid;
    END IF;
  END LOOP;

  v_unpaid_eligible := LEAST(
    GREATEST(0, v_eligible),
    GREATEST(0, GREATEST(0, v_live) - GREATEST(0, v_pending))
  );
  v_available := GREATEST(
    0,
    v_unpaid_eligible - GREATEST(0, v_debt) - v_withdrawal
  );

  RETURN QUERY SELECT
    v_live,
    v_available,
    GREATEST(0, v_pending)::bigint,
    v_withdrawal,
    GREATEST(0, v_debt)::bigint,
    GREATEST(0, v_unpaid_eligible)::bigint;
END;
$function$;

-- 3) Wallet summary / early cashout block reasons

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
  v_global_payouts boolean := true;
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

  -- A8B28F Stage C early/withdraw gates (legacy payouts_enabled removed).
  SELECT lower(coalesce((
    SELECT setting_value::text FROM public.admin_settings
    WHERE setting_key = 'payouts_enabled' LIMIT 1
  ), 'true')) IS DISTINCT FROM 'false'
  INTO v_global_payouts;

  IF NOT v_early_enabled THEN
    v_early_block := 'FEATURE_DISABLED';
  ELSIF upper(v_currency) <> 'GBP' THEN
    v_early_block := 'CURRENCY_MISMATCH';
  ELSIF lower(v_driver.driver_status::text) IN ('disabled', 'deleted', 'suspended', 'banned', 'blocked', 'inactive') THEN
    v_early_block := 'DRIVER_SUSPENDED';
  ELSIF lower(coalesce(v_driver.approval_status, '')) NOT IN ('approved', 'active') THEN
    v_early_block := 'DRIVER_NOT_APPROVED';
  ELSIF v_global_payouts IS NOT TRUE THEN
    v_early_block := 'FEATURE_DISABLED';
  ELSIF COALESCE(v_driver.payout_operational_paused, false) IS TRUE THEN
    v_early_block := 'ADMIN_HOLD';
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
    'source_version', 'driver_wallet_summary_ssot_v5_a8b28f_stage_c'
  );
END;
$function$;

-- 4) Weekly/batch reserve gate

CREATE OR REPLACE FUNCTION public.reserve_driver_payout_item(p_payout_item_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.payout_items%ROWTYPE;
  v_batch public.payout_batches%ROWTYPE;
  v_dest public.driver_payout_destinations%ROWTYPE;
  v_driver public.drivers%ROWTYPE;
  v_wallet public.driver_wallets%ROWTYPE;
  v_existing public.driver_payout_reservations%ROWTYPE;
  v_idempotency text;
  v_fingerprint text;
  v_live bigint;
  v_other_holds bigint;
  v_active_other bigint;
  v_available bigint;
  v_amount integer;
  v_currency text;
  v_res_id uuid;
  v_hold_id uuid;
  v_now timestamptz := now();
  v_batch_live_in_flight boolean;
  v_item_exec_status text;
BEGIN
  BEGIN
    SELECT * INTO v_wallet
    FROM public.driver_wallets
    WHERE driver_id = (
      SELECT driver_id FROM public.payout_items WHERE id = p_payout_item_id
    )
    FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'WALLET_LOCK_TIMEOUT',
      'reservation', NULL
    );
  END;

  SELECT * INTO v_item
  FROM public.payout_items
  WHERE id = p_payout_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  IF v_wallet.id IS NULL THEN
    INSERT INTO public.driver_wallets (driver_id, available_pence, pending_pence, lifetime_earned_pence, updated_at)
    VALUES (v_item.driver_id, 0, 0, 0, v_now)
    ON CONFLICT (driver_id) DO NOTHING;

    BEGIN
      SELECT * INTO v_wallet
      FROM public.driver_wallets
      WHERE driver_id = v_item.driver_id
      FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'WALLET_LOCK_TIMEOUT');
    END;
  END IF;

  SELECT * INTO v_batch FROM public.payout_batches WHERE id = v_item.batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'BATCH_NOT_ELIGIBLE');
  END IF;

  v_batch_live_in_flight := upper(coalesce(v_batch.status, '')) IN ('PROCESSING', 'RESERVING');

  IF v_batch.kind IS DISTINCT FROM 'WEEKLY_SCHEDULED'
     AND v_batch.kind IS DISTINCT FROM 'WEEKLY_MONDAY' THEN
    IF v_batch.kind IS DISTINCT FROM 'WEEKLY_SCHEDULED' THEN
      RETURN jsonb_build_object('ok', false, 'error_code', 'BATCH_NOT_ELIGIBLE');
    END IF;
  END IF;

  IF upper(coalesce(v_batch.status, '')) IN (
    'COMPLETED', 'CANCELLED', 'CANCELED', 'FAILED', 'FAILED_PERMANENT', 'FAILED_TERMINAL', 'REVERSED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'BATCH_NOT_ELIGIBLE');
  END IF;

  IF v_batch.status NOT IN (
    'BLOCKED_EXECUTION_DISABLED',
    'FUNDS_RESERVED_EXECUTION_DISABLED',
    'ITEMS_CREATED',
    'VALIDATED',
    'RESERVED',
    'RESERVING',
    'PROCESSING'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'BATCH_NOT_ELIGIBLE');
  END IF;

  IF upper(coalesce(v_item.status, '')) IN (
    'PAID', 'COMPLETED', 'SUBMITTED', 'SUBMITTING', 'SENT', 'CANCELLED', 'REVERSED', 'PROCESSING'
  ) OR lower(coalesce(v_item.status, '')) IN ('completed', 'cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  IF upper(coalesce(v_item.status, '')) NOT IN (
    'VALIDATED', 'BLOCKED_EXECUTION_DISABLED', 'RESERVING', 'RESERVED'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.driver_payout_payment_intents i
    WHERE i.payout_item_id = v_item.id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PROVIDER_INTENT_EXISTS');
  END IF;

  v_amount := COALESCE(v_item.amount_pence, v_item.net_driver_payout_pence, 0);
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'AMOUNT_MISMATCH');
  END IF;

  v_currency := upper(COALESCE(NULLIF(trim(v_item.currency), ''), 'GBP'));
  IF v_currency <> 'GBP' THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'CURRENCY_MISMATCH');
  END IF;

  BEGIN
    PERFORM public.assert_payout_item_ledger_lineage(p_payout_item_id);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', CASE
        WHEN SQLERRM LIKE '%FINANCIAL_MODEL_VIOLATION%' THEN 'FINANCIAL_MODEL_VIOLATION'
        WHEN SQLERRM LIKE '%PAYOUT_LINEAGE_MISMATCH%' THEN 'PAYOUT_LINEAGE_MISMATCH'
        WHEN SQLERRM LIKE '%PAYOUT_LINEAGE_MISSING%' THEN 'PAYOUT_LINEAGE_MISSING'
        ELSE 'PAYOUT_LINEAGE_VALIDATION_FAILED'
      END,
      'message', SQLERRM
    );
  END;

  SELECT * INTO v_driver FROM public.drivers WHERE id = v_item.driver_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_RESERVABLE');
  END IF;

  -- A8B28F Stage C: use effective helper (global/OP/provider/approval) — not legacy payouts_enabled.
  IF NOT public.driver_effective_payout_allowed(v_item.driver_id) THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'DRIVER_PAYOUT_HELD');
  END IF;

  IF v_item.payout_destination_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'DESTINATION_NOT_ACTIVE');
  END IF;

  SELECT * INTO v_dest
  FROM public.driver_payout_destinations
  WHERE id = v_item.payout_destination_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_dest.is_active IS NOT TRUE
     OR v_dest.archived_at IS NOT NULL
     OR v_dest.driver_id IS DISTINCT FROM v_item.driver_id THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'DESTINATION_NOT_ACTIVE');
  END IF;

  IF upper(COALESCE(v_dest.provider_link_status, '')) <> 'PROVIDER_VERIFIED'
     OR NULLIF(trim(COALESCE(v_dest.provider_counterparty_id, '')), '') IS NULL
     OR NULLIF(trim(COALESCE(v_dest.provider_recipient_account_id, '')), '') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PROVIDER_LINK_NOT_VERIFIED');
  END IF;

  v_idempotency := 'driver-payout-reservation:' || v_item.id::text;
  v_fingerprint := 'drv-payout-res-v1:'
    || v_item.id::text || ':'
    || v_item.batch_id::text || ':'
    || v_item.driver_id::text || ':'
    || v_amount::text || ':'
    || v_currency;

  v_item_exec_status := CASE
    WHEN v_batch_live_in_flight THEN 'RESERVED'
    ELSE 'BLOCKED_EXECUTION_DISABLED'
  END;

  SELECT * INTO v_existing
  FROM public.driver_payout_reservations
  WHERE idempotency_key = v_idempotency;

  IF FOUND THEN
    IF v_existing.reservation_fingerprint IS DISTINCT FROM v_fingerprint
       OR v_existing.amount_pence IS DISTINCT FROM v_amount
       OR v_existing.driver_id IS DISTINCT FROM v_item.driver_id
       OR v_existing.payout_item_id IS DISTINCT FROM v_item.id
       OR upper(v_existing.currency) IS DISTINCT FROM v_currency THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'IDEMPOTENCY_CONFLICT',
        'reservation_id', v_existing.id
      );
    END IF;

    IF v_existing.status = 'ACTIVE' THEN
      UPDATE public.payout_items
      SET status = 'RESERVED',
          execution_status = v_item_exec_status,
          updated_at = v_now
      WHERE id = v_item.id
        AND status IS DISTINCT FROM 'RESERVED';

      IF NOT v_batch_live_in_flight THEN
        UPDATE public.payout_batches
        SET status = 'FUNDS_RESERVED_EXECUTION_DISABLED',
            failure_code = 'FUNDS_RESERVED_EXECUTION_DISABLED',
            failure_reason = 'Funds reserved; LIVE/TRANSPORT execution disabled',
            updated_at = v_now
        WHERE id = v_batch.id
          AND status IS DISTINCT FROM 'FUNDS_RESERVED_EXECUTION_DISABLED';
      END IF;

      PERFORM public.refresh_driver_wallet_reservation_cache(v_item.driver_id);

      RETURN jsonb_build_object(
        'ok', true,
        'reused', true,
        'error_code', NULL,
        'reservation', jsonb_build_object(
          'id', v_existing.id,
          'payout_item_id', v_existing.payout_item_id,
          'payout_batch_id', v_existing.payout_batch_id,
          'driver_id', v_existing.driver_id,
          'amount_pence', v_existing.amount_pence,
          'currency', v_existing.currency,
          'status', v_existing.status,
          'idempotency_key', v_existing.idempotency_key,
          'reservation_fingerprint', v_existing.reservation_fingerprint,
          'reserved_at', v_existing.reserved_at
        ),
        'live_balance_pence', public.driver_wallet_live_balance_pence(v_item.driver_id),
        'available_pence', public.driver_wallet_available_for_payout_pence(v_item.driver_id),
        'reserved_pence', public.driver_wallet_active_reservation_pence(v_item.driver_id)
      );
    END IF;

    IF v_existing.status IN ('RELEASED', 'CANCELLED', 'FAILED') THEN
      NULL;
    ELSE
      RETURN jsonb_build_object(
        'ok', false,
        'error_code', 'ACTIVE_RESERVATION_EXISTS',
        'reservation_id', v_existing.id
      );
    END IF;
  END IF;

  UPDATE public.payout_items
  SET status = 'RESERVING',
      execution_status = 'RESERVING',
      updated_at = v_now
  WHERE id = v_item.id
    AND status IN ('VALIDATED', 'BLOCKED_EXECUTION_DISABLED', 'RESERVING', 'RESERVED');

  v_live := public.driver_wallet_live_balance_pence(v_item.driver_id);
  v_other_holds := public.driver_wallet_other_holds_pence(v_item.driver_id);
  SELECT COALESCE(SUM(amount_pence), 0)::bigint INTO v_active_other
  FROM public.driver_payout_reservations
  WHERE driver_id = v_item.driver_id
    AND status = 'ACTIVE'
    AND payout_item_id IS DISTINCT FROM v_item.id;

  v_available := GREATEST(0, v_live - v_active_other - v_other_holds);

  IF v_available < v_amount THEN
    UPDATE public.payout_items
    SET status = 'BLOCKED_EXECUTION_DISABLED',
        execution_status = 'BLOCKED_EXECUTION_DISABLED',
        error_message = 'INSUFFICIENT_AVAILABLE_WALLET',
        updated_at = v_now
    WHERE id = v_item.id AND status = 'RESERVING';

    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'INSUFFICIENT_AVAILABLE_WALLET',
      'available_pence', v_available,
      'required_pence', v_amount,
      'live_balance_pence', v_live
    );
  END IF;

  IF v_existing.id IS NOT NULL AND v_existing.status IN ('RELEASED', 'CANCELLED', 'FAILED') THEN
    UPDATE public.driver_payout_reservations
    SET status = 'ACTIVE',
        amount_pence = v_amount,
        reserved_at = v_now,
        released_at = NULL,
        consumed_at = NULL,
        release_reason = NULL,
        failure_code = NULL,
        wallet_account_id = v_wallet.id,
        metadata = jsonb_build_object(
          'slice', 6,
          'hold_model', 'PAYOUT_RESERVATION_HOLD',
          'revived', true
        ),
        updated_at = v_now
    WHERE id = v_existing.id
    RETURNING id INTO v_res_id;
  ELSE
    INSERT INTO public.driver_payout_reservations (
      payout_item_id,
      payout_batch_id,
      driver_id,
      wallet_account_id,
      reservation_type,
      amount_pence,
      currency,
      status,
      idempotency_key,
      reservation_fingerprint,
      reserved_at,
      metadata
    ) VALUES (
      v_item.id,
      v_item.batch_id,
      v_item.driver_id,
      v_wallet.id,
      'DRIVER_PAYOUT',
      v_amount,
      v_currency,
      'ACTIVE',
      v_idempotency,
      v_fingerprint,
      v_now,
      jsonb_build_object('slice', 6, 'hold_model', 'PAYOUT_RESERVATION_HOLD')
    )
    RETURNING id INTO v_res_id;
  END IF;

  INSERT INTO public.driver_wallet_ledger (
    driver_id, type, amount_pence, currency, description, created_at
  ) VALUES (
    v_item.driver_id,
    'PAYOUT_RESERVATION_HOLD',
    v_amount,
    lower(v_currency),
    'Slice 6 payout reservation hold for item ' || v_item.id::text,
    v_now
  )
  RETURNING id INTO v_hold_id;

  UPDATE public.driver_payout_reservations
  SET hold_ledger_entry_id = v_hold_id,
      updated_at = v_now
  WHERE id = v_res_id;

  UPDATE public.payout_items
  SET status = 'RESERVED',
      execution_status = v_item_exec_status,
      error_message = NULL,
      updated_at = v_now
  WHERE id = v_item.id;

  IF NOT v_batch_live_in_flight THEN
    UPDATE public.payout_batches
    SET status = 'FUNDS_RESERVED_EXECUTION_DISABLED',
        failure_code = 'FUNDS_RESERVED_EXECUTION_DISABLED',
        failure_reason = 'Funds reserved; LIVE/TRANSPORT execution disabled',
        updated_at = v_now
    WHERE id = v_batch.id;
  END IF;

  PERFORM public.refresh_driver_wallet_reservation_cache(v_item.driver_id);

  RETURN jsonb_build_object(
    'ok', true,
    'reused', false,
    'error_code', NULL,
    'reservation', jsonb_build_object(
      'id', v_res_id,
      'payout_item_id', v_item.id,
      'payout_batch_id', v_item.batch_id,
      'driver_id', v_item.driver_id,
      'amount_pence', v_amount,
      'currency', v_currency,
      'status', 'ACTIVE',
      'idempotency_key', v_idempotency,
      'reservation_fingerprint', v_fingerprint,
      'reserved_at', v_now,
      'hold_ledger_entry_id', v_hold_id
    ),
    'live_balance_pence', public.driver_wallet_live_balance_pence(v_item.driver_id),
    'available_pence', public.driver_wallet_available_for_payout_pence(v_item.driver_id),
    'reserved_pence', public.driver_wallet_active_reservation_pence(v_item.driver_id)
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO v_existing
    FROM public.driver_payout_reservations
    WHERE payout_item_id = p_payout_item_id AND status = 'ACTIVE'
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true,
        'reused', true,
        'error_code', NULL,
        'reservation', jsonb_build_object(
          'id', v_existing.id,
          'payout_item_id', v_existing.payout_item_id,
          'amount_pence', v_existing.amount_pence,
          'status', v_existing.status,
          'idempotency_key', v_existing.idempotency_key
        ),
        'live_balance_pence', public.driver_wallet_live_balance_pence(v_existing.driver_id),
        'available_pence', public.driver_wallet_available_for_payout_pence(v_existing.driver_id),
        'reserved_pence', public.driver_wallet_active_reservation_pence(v_existing.driver_id)
      );
    END IF;
    RETURN jsonb_build_object('ok', false, 'error_code', 'ACTIVE_RESERVATION_EXISTS');
END;
$$;
