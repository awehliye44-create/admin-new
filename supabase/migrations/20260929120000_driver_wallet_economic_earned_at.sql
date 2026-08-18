-- Step 4C (LOCAL ONLY — do not apply to production until explicitly approved)
-- Canonical economic earning-date SSOT for PLATFORM_COLLECTED TRIP_EARNING_NET.
--
-- Does NOT:
--   - overwrite driver_wallet_ledger.created_at
--   - change payout eligibility / captured_at + 27h clearing
--   - recover MK-007 / MK-009
--   - INSERT/UPDATE/DELETE money or finance rows
--   - use dynamic SQL

BEGIN;

CREATE OR REPLACE FUNCTION public.driver_wallet_resolve_economic_date(
  p_type text,
  p_related_trip_id uuid,
  p_created_at timestamptz
)
RETURNS TABLE (
  economic_earned_at timestamptz,
  posting_created_at timestamptz,
  economic_date_status text,
  captured_at timestamptz,
  eligible_at timestamptz,
  clearing_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  v_model text;
  v_booking_count integer := 0;
  v_capture_evidence_count integer := 0;
  v_missing_ts boolean := false;
  v_refunded boolean := false;
  v_released boolean := false;
  v_unverified boolean := false;
  v_captured timestamptz := NULL;
  v_eligible timestamptz := NULL;
  v_clearing text := NULL;
  v_delay numeric := 27;
  v_status text;
BEGIN
  posting_created_at := p_created_at;

  IF upper(coalesce(p_type, '')) <> 'TRIP_EARNING_NET' THEN
    economic_earned_at := p_created_at;
    economic_date_status := 'POSTING_CREATED_AT';
    captured_at := NULL;
    eligible_at := NULL;
    clearing_status := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  IF p_related_trip_id IS NULL THEN
    economic_earned_at := NULL;
    economic_date_status := 'PAYMENT_SESSION_MISSING';
    captured_at := NULL;
    eligible_at := NULL;
    clearing_status := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT financial_model INTO v_model
  FROM public.trips
  WHERE id = p_related_trip_id;

  IF upper(coalesce(v_model, '')) IS DISTINCT FROM 'PLATFORM_COLLECTED' THEN
    economic_earned_at := NULL;
    economic_date_status := 'FINANCIAL_MODEL_MISMATCH';
    captured_at := NULL;
    eligible_at := NULL;
    clearing_status := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Canonical origin is RIDE_BOOKING only. PAYMENT_RECOVERY is excluded by purpose
  -- and must not create booking-origin ambiguity.
  -- Exactly one RIDE_BOOKING row is required. Two rows always fail closed,
  -- even when provider_order_id / provider_capture_id / captured_at / amount match.
  SELECT COUNT(*)::integer
  INTO v_booking_count
  FROM public.payment_sessions
  WHERE trip_id = p_related_trip_id
    AND upper(coalesce(purpose, '')) = 'RIDE_BOOKING';

  IF v_booking_count = 0 THEN
    v_status := 'PAYMENT_SESSION_MISSING';
  ELSIF v_booking_count > 1 THEN
    v_status := 'CAPTURE_AMBIGUOUS';
    v_captured := NULL;
  ELSE
    SELECT
      COUNT(*) FILTER (
        WHERE captured_at IS NOT NULL
          AND coalesce(captured_amount_pence, 0) > 0
          AND refunded_at IS NULL
          AND released_at IS NULL
          AND coalesce(refunded_amount_pence, 0) = 0
          AND coalesce(released_amount_pence, 0) = 0
          AND upper(coalesce(status, '')) NOT IN ('REFUNDED', 'RELEASED')
          AND coalesce(upper(hold_release_state), '') NOT LIKE '%RELEASE%'
          AND upper(coalesce(provider_state, '')) IN ('COMPLETED', 'CAPTURED')
          AND provider_state_verified_at IS NOT NULL
      )::integer,
      bool_or(captured_at IS NULL),
      bool_or(
        refunded_at IS NOT NULL
        OR coalesce(refunded_amount_pence, 0) > 0
        OR upper(coalesce(status, '')) = 'REFUNDED'
      ),
      bool_or(
        released_at IS NOT NULL
        OR coalesce(released_amount_pence, 0) > 0
        OR upper(coalesce(status, '')) = 'RELEASED'
        OR upper(coalesce(hold_release_state, '')) LIKE '%RELEASE%'
      ),
      bool_or(
        captured_at IS NOT NULL
        AND coalesce(captured_amount_pence, 0) > 0
        AND refunded_at IS NULL
        AND released_at IS NULL
        AND coalesce(refunded_amount_pence, 0) = 0
        AND coalesce(released_amount_pence, 0) = 0
        AND (
          upper(coalesce(provider_state, '')) NOT IN ('COMPLETED', 'CAPTURED')
          OR provider_state_verified_at IS NULL
        )
      ),
      MIN(captured_at) FILTER (
        WHERE captured_at IS NOT NULL
          AND coalesce(captured_amount_pence, 0) > 0
          AND refunded_at IS NULL
          AND released_at IS NULL
          AND coalesce(refunded_amount_pence, 0) = 0
          AND coalesce(released_amount_pence, 0) = 0
          AND upper(coalesce(status, '')) NOT IN ('REFUNDED', 'RELEASED')
          AND coalesce(upper(hold_release_state), '') NOT LIKE '%RELEASE%'
          AND upper(coalesce(provider_state, '')) IN ('COMPLETED', 'CAPTURED')
          AND provider_state_verified_at IS NOT NULL
      )
    INTO v_capture_evidence_count, v_missing_ts, v_refunded, v_released, v_unverified, v_captured
    FROM public.payment_sessions
    WHERE trip_id = p_related_trip_id
      AND upper(coalesce(purpose, '')) = 'RIDE_BOOKING';

    IF v_capture_evidence_count = 1 THEN
      v_status := 'RESOLVED';
    ELSIF v_refunded AND NOT v_released THEN
      v_status := 'CAPTURE_REFUNDED';
      v_captured := NULL;
    ELSIF v_released THEN
      v_status := 'CAPTURE_RELEASED';
      v_captured := NULL;
    ELSIF v_missing_ts THEN
      v_status := 'CAPTURE_TIMESTAMP_MISSING';
      v_captured := NULL;
    ELSIF v_unverified THEN
      v_status := 'CAPTURE_NOT_VERIFIED';
      v_captured := NULL;
    ELSE
      v_status := 'PAYMENT_SESSION_MISSING';
      v_captured := NULL;
    END IF;
  END IF;

  IF v_status = 'RESOLVED' THEN
    v_delay := public.driver_wallet_payout_clearing_delay_hours();
    v_eligible := v_captured + pg_catalog.make_interval(hours => v_delay::integer);
    IF pg_catalog.now() >= v_eligible THEN
      v_clearing := 'AVAILABLE';
    ELSE
      v_clearing := 'PENDING';
    END IF;
    economic_earned_at := v_captured;
    economic_date_status := 'RESOLVED';
    captured_at := v_captured;
    eligible_at := v_eligible;
    clearing_status := v_clearing;
  ELSE
    economic_earned_at := NULL;
    economic_date_status := v_status;
    captured_at := NULL;
    eligible_at := NULL;
    clearing_status := NULL;
  END IF;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.driver_wallet_resolve_economic_date(text, uuid, timestamptz) IS
  'Canonical economic earning timestamp. Exactly one RIDE_BOOKING payment_sessions row is required for PLATFORM_COLLECTED TRIP_EARNING_NET. Two RIDE_BOOKING rows always CAPTURE_AMBIGUOUS, including identical duplicates. PAYMENT_RECOVERY is excluded. Never mutates created_at. Payout remains captured_at+27h elsewhere.';

CREATE OR REPLACE FUNCTION public.driver_wallet_trip_earnings_in_range_pence(
  p_driver_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
  WITH deduped AS (
    SELECT DISTINCT ON (related_trip_id, type)
      amount_pence,
      type,
      related_trip_id,
      created_at
    FROM public.driver_wallet_ledger
    WHERE driver_id = p_driver_id
      AND type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT')
      AND related_trip_id IS NOT NULL
    ORDER BY related_trip_id, type, created_at DESC
  )
  SELECT COALESCE(SUM(d.amount_pence), 0)::bigint
  FROM deduped d
  CROSS JOIN LATERAL public.driver_wallet_resolve_economic_date(d.type, d.related_trip_id, d.created_at) r
  WHERE r.economic_earned_at >= p_start
    AND r.economic_earned_at < p_end;
$$;

CREATE OR REPLACE FUNCTION public.driver_wallet_jwt_role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog'
AS $$
  SELECT lower(coalesce(auth.jwt() ->> 'role', ''));
$$;

CREATE OR REPLACE FUNCTION public.driver_wallet_ledger_economic_fields(p_driver_id uuid)
RETURNS TABLE (
  ledger_entry_id uuid,
  related_trip_id uuid,
  amount_pence bigint,
  posting_created_at timestamptz,
  economic_earned_at timestamptz,
  economic_date_status text,
  captured_at timestamptz,
  eligible_at timestamptz,
  clearing_status text,
  type text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  v_role text := public.driver_wallet_jwt_role();
  v_self uuid;
BEGIN
  IF v_role = 'service_role' THEN
    NULL;
  ELSIF v_role = 'authenticated' THEN
    v_self := public.current_driver_id();
    IF v_self IS NULL OR v_self IS DISTINCT FROM p_driver_id THEN
      RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    dwl.id,
    dwl.related_trip_id,
    dwl.amount_pence,
    r.posting_created_at,
    r.economic_earned_at,
    r.economic_date_status,
    r.captured_at,
    r.eligible_at,
    r.clearing_status,
    dwl.type
  FROM public.driver_wallet_ledger dwl
  CROSS JOIN LATERAL public.driver_wallet_resolve_economic_date(
    dwl.type, dwl.related_trip_id, dwl.created_at
  ) r
  WHERE dwl.driver_id = p_driver_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_driver_own_wallet_earning_rows(
  p_start timestamptz,
  p_end timestamptz
)
RETURNS TABLE (
  ledger_entry_id uuid,
  related_trip_id uuid,
  amount_pence bigint,
  type text,
  description text,
  posting_created_at timestamptz,
  economic_earned_at timestamptz,
  economic_date_status text,
  captured_at timestamptz,
  eligible_at timestamptz,
  clearing_status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog'
AS $$
DECLARE
  v_role text := public.driver_wallet_jwt_role();
  v_driver_id uuid;
  v_pad interval := interval '45 days';
BEGIN
  IF v_role IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  v_driver_id := public.current_driver_id();
  IF v_driver_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    dwl.id,
    dwl.related_trip_id,
    dwl.amount_pence,
    dwl.type,
    dwl.description,
    r.posting_created_at,
    r.economic_earned_at,
    r.economic_date_status,
    r.captured_at,
    r.eligible_at,
    r.clearing_status
  FROM public.driver_wallet_ledger dwl
  CROSS JOIN LATERAL public.driver_wallet_resolve_economic_date(
    dwl.type, dwl.related_trip_id, dwl.created_at
  ) r
  WHERE dwl.driver_id = v_driver_id
    AND dwl.type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT', 'NO_SHOW_FEE', 'BONUS', 'REFUND_DEBIT')
    AND dwl.created_at >= (p_start - v_pad)
    AND dwl.created_at < (p_end + v_pad);
END;
$$;

COMMENT ON FUNCTION public.get_driver_own_wallet_earning_rows(timestamptz, timestamptz) IS
  'Authenticated driver-only earning rows with backend-resolved economic_earned_at. Identity from auth.uid()/current_driver_id(). Caller cannot supply another driver UUID.';

-- Today KPI uses economic date. Cycle earnings remain posting-based.
-- Body copied from 20260926120000 with today CTE replaced; grants tightened in 4C.
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
    'source_version', 'driver_wallet_summary_ssot_v4_economic_earned_at'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.driver_wallet_resolve_economic_date(text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.driver_wallet_trip_earnings_in_range_pence(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.driver_wallet_ledger_economic_fields(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_driver_own_wallet_earning_rows(timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.driver_wallet_jwt_role() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.driver_wallet_summary_ssot(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.driver_wallet_resolve_economic_date(text, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_wallet_trip_earnings_in_range_pence(uuid, timestamptz, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.driver_wallet_ledger_economic_fields(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_own_wallet_earning_rows(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.driver_wallet_summary_ssot(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_own_wallet_summary(uuid) TO authenticated, service_role;

COMMIT;
