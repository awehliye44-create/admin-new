-- Financial Resilience programme: refund application column, payout eligibility,
-- refund reversal lineage, deleted-driver backstop.
-- Function bodies are the live production definitions (read back 2026-10-13) with
-- targeted edits only. Rollback: rollback/rollback_20261217100000_financial_resilience_hardening.sql

BEGIN;

-- apply_confirmed_provider_refund_atomic (live since 20260930150000) writes this column, which
-- payments never had: every local refund application failed after Revolut had refunded.
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS provider_refund_id text;

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
  v_terminal_kind text;
  v_terminal_fee bigint;
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
      t.airport_charge_pence,
      t.tip_pence,
      t.tip_amount_pence,
      t.financial_outcome::text AS trip_financial_outcome,
      t.payment_status::text AS trip_payment_status,
      t.no_show_charge_pence AS trip_no_show_charge_pence,
      t.driver_id AS trip_driver_id,
      t.confirmed_driver_id AS trip_confirmed_driver_id,
      t.previous_driver_id AS trip_previous_driver_id,
      ps.id AS session_id,
      ps.provider_processing_fee_pence AS session_provider_fee_pence,
      ps.fee_status::text AS session_fee_status,
      ps.captured_amount_pence,
      ps.captured_at,
      ps.metadata AS session_metadata,
      ps.refunded_amount_pence,
      ps.status::text AS session_status,
      ps.provider_state,
      ps.payment_method AS session_payment_method,
      des.settled_at,
      des.settlement_status,
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
    -- Chargeable terminal earning (Arrival Cancellation / No-Show / Late Passenger
    -- Cancellation). The trip stays cancelled / no_show and the trip stamp is not
    -- the SSOT: entitlement = captured − ACTUAL provider fee, commission 0.
    -- Mirror: driverPayoutEligibilitySSOT.evaluateTerminalEarningEligibility.
    v_terminal_kind := NULL;
    IF upper(r.type) = 'TRIP_EARNING_NET' THEN
      v_terminal_kind := public.trip_chargeable_terminal_outcome_kind(
        r.trip_financial_outcome,
        r.trip_status,
        r.trip_payment_status,
        r.trip_no_show_charge_pence
      );
    END IF;

    IF v_terminal_kind IS NOT NULL THEN
      IF public.trip_terminal_entitled_driver_id(
           r.trip_driver_id,
           r.trip_confirmed_driver_id,
           r.trip_previous_driver_id
         ) IS DISTINCT FROM p_driver_id THEN
        CONTINUE;
      END IF;
      IF upper(btrim(COALESCE(r.financial_model, r.payment_collection_model, ''))) <> 'PLATFORM_COLLECTED' THEN
        CONTINUE;
      END IF;
      IF EXISTS (
        SELECT 1
        FROM public.driver_wallet_ledger c
        WHERE c.driver_id = p_driver_id
          AND c.related_trip_id = r.related_trip_id
          AND c.type = 'PLATFORM_COMMISSION'
          AND c.amount_pence <> 0
      ) THEN
        CONTINUE;
      END IF;
      IF EXISTS (
        SELECT 1
        FROM public.driver_wallet_ledger x
        WHERE x.driver_id = p_driver_id
          AND x.related_trip_id = r.related_trip_id
          AND x.type IN ('LEDGER_REVERSAL', 'REFUND_DEBIT')
      ) THEN
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
         OR v_session_status LIKE '%fail%'
         OR v_session_status = 'released'
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

      IF upper(btrim(COALESCE(r.session_fee_status, ''))) <> 'ACTUAL'
         OR r.session_provider_fee_pence IS NULL
         OR r.session_provider_fee_pence < 0 THEN
        CONTINUE;
      END IF;
      v_terminal_fee := round(r.session_provider_fee_pence)::bigint;
      v_canonical := v_captured - v_terminal_fee;
      IF v_canonical <= 0 OR r.amount_pence <> v_canonical THEN
        CONTINUE;
      END IF;
    ELSE
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
        v_canonical := GREATEST(0, COALESCE(r.driver_net_pence, 0) + COALESCE(r.airport_charge_pence, 0));
      ELSE
        v_canonical := GREATEST(0, COALESCE(r.tip_pence, r.tip_amount_pence, 0));
      END IF;

      IF v_canonical <= 0 OR r.amount_pence <> v_canonical THEN
        CONTINUE;
      END IF;

      IF v_captured < v_canonical THEN
        CONTINUE;
      END IF;
    END IF;

    v_model := upper(btrim(COALESCE(
      r.payment_collection_model::text,
      r.financial_model::text,
      'PLATFORM_COLLECTED'
    )));
    v_method := lower(btrim(COALESCE(r.trip_payment_method, r.session_payment_method, '')));
    v_requires_clearing := (v_model NOT LIKE '%DRIVER_COLLECTED%')
      AND v_method NOT LIKE '%cash%';

    -- Strict clearing: stable origin + configured delay (27h), no exception.
    -- Provider availability / settlement state never clears early and never delays.
    v_cleared := NOT v_requires_clearing;
    IF v_requires_clearing THEN
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

CREATE OR REPLACE FUNCTION public.apply_confirmed_provider_refund_atomic(p_trip_id uuid, p_payment_provider text, p_provider_refund_id text, p_event_refund_amount_pence integer, p_cumulative_refunded_pence integer, p_provider_order_id text DEFAULT NULL::text, p_provider_payment_id text DEFAULT NULL::text, p_refund_reason text DEFAULT NULL::text, p_source text DEFAULT 'admin_refund'::text, p_skip_driver_wallet_reversal boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_ps public.payment_sessions%ROWTYPE;
  v_rb_count integer;
  v_captured_pence integer;
  v_commission_pence integer;
  v_driver_net_pence integer;
  v_now timestamptz := now();
  v_child_id uuid;
  v_existing_child_id uuid;
  v_existing_debit_id uuid;
  v_existing_debit_pence integer;
  v_ps_refunded_sum integer;
  v_refund_status text;
  v_payment_status text;
  v_ratio numeric;
  v_target_reversal integer;
  v_authoritative_debit_sum integer;
  v_missing_reversal integer;
  v_credited_pence integer;
  v_insert_debit_pence integer;
  v_ledger_id uuid;
  v_net_captured integer;
  v_adjusted_commission integer;
  v_adjusted_driver_net integer;
  v_tip_credit_pence integer;
  v_fare_basis_pence integer;
  v_target_tip_reversal integer;
  v_wallet_driver_id uuid;
  v_earning_credit_pence integer;
BEGIN
  IF p_trip_id IS NULL THEN
    RAISE EXCEPTION 'trip_id_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_provider_refund_id IS NULL OR btrim(p_provider_refund_id) = '' THEN
    RAISE EXCEPTION 'provider_refund_id_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payment_provider IS NULL OR btrim(p_payment_provider) = '' THEN
    RAISE EXCEPTION 'payment_provider_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_event_refund_amount_pence IS NULL OR p_event_refund_amount_pence <= 0 THEN
    RAISE EXCEPTION 'event_refund_amount_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_cumulative_refunded_pence IS NULL OR p_cumulative_refunded_pence <= 0 THEN
    RAISE EXCEPTION 'cumulative_refund_amount_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'trip_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  IF upper(coalesce(v_trip.financial_model::text, '')) = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION' USING ERRCODE = 'check_violation';
  END IF;

  -- The trip's driver columns can be cleared after a reassignment or cancellation;
  -- the reversal belongs to whoever the ledger actually credited.
  SELECT dwl.driver_id INTO v_wallet_driver_id
  FROM public.driver_wallet_ledger dwl
  WHERE dwl.related_trip_id = p_trip_id
    AND dwl.type = 'TRIP_EARNING_NET'
    AND dwl.amount_pence > 0
  ORDER BY dwl.created_at
  LIMIT 1;

  IF v_wallet_driver_id IS NULL THEN
    v_wallet_driver_id := public.trip_terminal_entitled_driver_id(
      v_trip.driver_id,
      v_trip.confirmed_driver_id,
      v_trip.previous_driver_id
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.driver_wallet_ledger dwl
    WHERE dwl.related_trip_id = p_trip_id
      AND dwl.type = 'REFUND_DEBIT'
      AND dwl.provider_refund_id IS NULL
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_REFUND_DEBIT_REQUIRES_MANUAL_RECONCILIATION'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::integer INTO v_rb_count
  FROM public.payment_sessions ps
  WHERE ps.trip_id = p_trip_id
    AND ps.purpose = 'RIDE_BOOKING';

  IF v_rb_count = 0 THEN
    RAISE EXCEPTION 'PAYMENT_SESSION_MISSING' USING ERRCODE = 'check_violation';
  END IF;

  IF v_rb_count > 1 THEN
    RAISE EXCEPTION 'CAPTURE_AMBIGUOUS' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_ps
  FROM public.payment_sessions ps
  WHERE ps.trip_id = p_trip_id
    AND ps.purpose = 'RIDE_BOOKING'
  FOR UPDATE;

  SELECT id INTO v_existing_child_id
  FROM public.payment_session_refunds psr
  WHERE psr.payment_provider = p_payment_provider
    AND psr.provider_refund_id = p_provider_refund_id;

  SELECT id, abs(dwl.amount_pence)::integer
    INTO v_existing_debit_id, v_existing_debit_pence
  FROM public.driver_wallet_ledger dwl
  WHERE dwl.payment_provider = p_payment_provider
    AND dwl.provider_refund_id = p_provider_refund_id
    AND dwl.driver_id = v_wallet_driver_id
    AND dwl.type = 'REFUND_DEBIT';

  IF v_existing_child_id IS NOT NULL AND v_existing_debit_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'already_applied',
      'trip_id', p_trip_id,
      'payment_session_id', v_ps.id,
      'provider_refund_id', p_provider_refund_id,
      'refund_child_id', v_existing_child_id,
      'ledger_debit_id', v_existing_debit_id,
      'cumulative_refunded_pence', p_cumulative_refunded_pence
    );
  END IF;

  v_captured_pence := greatest(
    0,
    coalesce(v_trip.capture_amount_pence, v_ps.captured_amount_pence, v_ps.authorised_amount_pence, 0)
  );
  v_commission_pence := greatest(0, coalesce(v_trip.commission_pence, 0));
  SELECT coalesce(sum(greatest(0, dwl.amount_pence)), 0)::integer INTO v_earning_credit_pence
  FROM public.driver_wallet_ledger dwl
  WHERE dwl.related_trip_id = p_trip_id
    AND dwl.driver_id = v_wallet_driver_id
    AND dwl.type = 'TRIP_EARNING_NET';

  -- Completion credits driver_net + airport; terminal fee earnings carry no driver_net stamp.
  v_driver_net_pence := CASE
    WHEN v_earning_credit_pence > 0 THEN v_earning_credit_pence
    ELSE greatest(0, coalesce(v_trip.driver_net_pence, 0) + coalesce(v_trip.airport_charge_pence, 0))
  END;

  IF v_captured_pence <= 0 THEN
    RAISE EXCEPTION 'captured_amount_missing' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.payment_session_refunds (
    payment_session_id,
    payment_provider,
    provider_refund_id,
    provider_payment_id,
    amount_pence,
    currency,
    status,
    confirmed_at,
    metadata
  ) VALUES (
    v_ps.id,
    p_payment_provider,
    p_provider_refund_id,
    coalesce(p_provider_payment_id, p_provider_order_id, v_ps.provider_order_id),
    p_event_refund_amount_pence,
    lower(coalesce(v_ps.currency, 'gbp')),
    'confirmed',
    v_now,
    jsonb_build_object('source', coalesce(p_source, 'admin_refund'))
  )
  ON CONFLICT (payment_provider, provider_refund_id) DO NOTHING
  RETURNING id INTO v_child_id;

  IF v_child_id IS NULL THEN
    SELECT id INTO v_child_id
    FROM public.payment_session_refunds psr
    WHERE psr.payment_provider = p_payment_provider
      AND psr.provider_refund_id = p_provider_refund_id;
  END IF;

  SELECT coalesce(sum(psr.amount_pence), 0)::integer INTO v_ps_refunded_sum
  FROM public.payment_session_refunds psr
  WHERE psr.payment_session_id = v_ps.id
    AND psr.amount_pence > 0;

  IF v_ps_refunded_sum <> p_cumulative_refunded_pence THEN
    RAISE EXCEPTION 'cumulative_refund_mismatch: expected % got %',
      p_cumulative_refunded_pence, v_ps_refunded_sum
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_cumulative_refunded_pence >= v_captured_pence THEN
    v_refund_status := 'refunded';
    v_payment_status := 'refunded';
  ELSE
    v_refund_status := 'partially_refunded';
    v_payment_status := 'partially_refunded';
  END IF;

  v_net_captured := greatest(0, v_captured_pence - p_cumulative_refunded_pence);
  v_ratio := v_net_captured::numeric / v_captured_pence::numeric;
  v_adjusted_commission := greatest(0, round(v_commission_pence * v_ratio)::integer);
  v_adjusted_driver_net := greatest(0, round(v_driver_net_pence * v_ratio)::integer);
  v_target_reversal := greatest(0, v_driver_net_pence - v_adjusted_driver_net);

  SELECT coalesce(sum(greatest(0, dwl.amount_pence)), 0)::integer
    INTO v_tip_credit_pence
  FROM public.driver_wallet_ledger dwl
  WHERE dwl.related_trip_id = p_trip_id
    AND dwl.type = 'DRIVER_TIP_CREDIT'
    AND (v_wallet_driver_id IS NULL OR dwl.driver_id = v_wallet_driver_id);

  v_fare_basis_pence := greatest(0, coalesce(v_trip.final_fare_pence, 0));
  IF v_fare_basis_pence <= 0 THEN
    v_fare_basis_pence := greatest(0, v_captured_pence - least(v_tip_credit_pence, v_captured_pence));
  END IF;
  v_target_tip_reversal := least(
    v_tip_credit_pence,
    greatest(0, p_cumulative_refunded_pence - v_fare_basis_pence)
  );
  v_target_reversal := v_target_reversal + v_target_tip_reversal;

  SELECT coalesce(sum(abs(dwl.amount_pence)), 0)::integer INTO v_authoritative_debit_sum
  FROM public.driver_wallet_ledger dwl
  WHERE dwl.related_trip_id = p_trip_id
    AND dwl.type = 'REFUND_DEBIT'
    AND dwl.provider_refund_id IS NOT NULL;

  v_missing_reversal := greatest(0, v_target_reversal - v_authoritative_debit_sum);
  v_insert_debit_pence := 0;

  IF v_missing_reversal > 0
     AND NOT coalesce(p_skip_driver_wallet_reversal, false)
     AND v_wallet_driver_id IS NOT NULL
     AND v_existing_debit_id IS NULL THEN
    SELECT coalesce(sum(greatest(0, dwl.amount_pence)), 0)::integer INTO v_credited_pence
    FROM public.driver_wallet_ledger dwl
    WHERE dwl.driver_id = v_wallet_driver_id
      AND dwl.related_trip_id = p_trip_id
      AND dwl.type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT');

    IF v_credited_pence > 0 THEN
      v_insert_debit_pence := least(v_credited_pence - v_authoritative_debit_sum, v_missing_reversal);
      v_insert_debit_pence := greatest(0, v_insert_debit_pence);
    ELSE
      v_insert_debit_pence := v_missing_reversal;
    END IF;

    IF v_insert_debit_pence > 0 THEN
      INSERT INTO public.driver_wallet_ledger (
        driver_id,
        related_trip_id,
        type,
        amount_pence,
        currency,
        description,
        payment_provider,
        provider_refund_id
      ) VALUES (
        v_wallet_driver_id,
        p_trip_id,
        'REFUND_DEBIT',
        -v_insert_debit_pence,
        coalesce(v_trip.currency, 'GBP'),
        format('provider refund reversal (%s) — %s', p_provider_refund_id, coalesce(p_source, 'admin_refund')),
        p_payment_provider,
        p_provider_refund_id
      )
      RETURNING id INTO v_ledger_id;
    END IF;
  ELSIF v_existing_debit_id IS NOT NULL THEN
    v_ledger_id := v_existing_debit_id;
  END IF;

  UPDATE public.payment_sessions
  SET
    refunded_amount_pence = v_ps_refunded_sum,
    refunded_at = v_now,
    provider_refund_id = p_provider_refund_id,
    updated_at = v_now
  WHERE id = v_ps.id;

  UPDATE public.trips
  SET
    payment_status = v_payment_status,
    refund_amount_pence = p_cumulative_refunded_pence,
    refunded_at = v_now,
    updated_at = v_now,
    refund_reason = coalesce(p_refund_reason, refund_reason)
  WHERE id = p_trip_id;

  UPDATE public.payments pay
  SET
    status = v_payment_status,
    refunded_amount_pence = p_cumulative_refunded_pence,
    refund_status = v_refund_status,
    refunded_at = v_now,
    updated_at = v_now,
    provider_refund_id = p_provider_refund_id,
    last_error = format('provider_refund:%s:%s', p_provider_refund_id, p_cumulative_refunded_pence)
  WHERE pay.trip_id = p_trip_id;

  UPDATE public.trip_finance tf
  SET
    refund_amount_pence = p_cumulative_refunded_pence,
    refund_status = v_refund_status,
    net_card_revenue_after_refund_pence = v_net_captured,
    driver_wallet_reversal_pence = v_target_reversal,
    commission_reversal_pence = greatest(0, v_commission_pence - v_adjusted_commission),
    financial_status = CASE WHEN v_refund_status = 'refunded' THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
    updated_at = v_now
  WHERE tf.trip_id = p_trip_id;

  RETURN jsonb_build_object(
    'status', 'applied',
    'trip_id', p_trip_id,
    'payment_session_id', v_ps.id,
    'provider_refund_id', p_provider_refund_id,
    'refund_child_id', v_child_id,
    'ledger_debit_id', v_ledger_id,
    'cumulative_refunded_pence', p_cumulative_refunded_pence,
    'target_driver_reversal_pence', v_target_reversal,
    'authoritative_debit_sum_pence', v_authoritative_debit_sum + coalesce(v_insert_debit_pence, 0),
    'inserted_debit_pence', coalesce(v_insert_debit_pence, 0),
    'payment_status', v_payment_status,
    'refund_status', v_refund_status
  );

EXCEPTION
  WHEN unique_violation THEN
    SELECT id INTO v_existing_child_id
    FROM public.payment_session_refunds psr
    WHERE psr.payment_provider = p_payment_provider
      AND psr.provider_refund_id = p_provider_refund_id;

    SELECT id, abs(dwl.amount_pence)::integer
      INTO v_existing_debit_id, v_existing_debit_pence
    FROM public.driver_wallet_ledger dwl
    WHERE dwl.payment_provider = p_payment_provider
      AND dwl.provider_refund_id = p_provider_refund_id
      AND dwl.driver_id = v_wallet_driver_id
      AND dwl.type = 'REFUND_DEBIT';

    SELECT coalesce(sum(psr.amount_pence), 0)::integer INTO v_ps_refunded_sum
    FROM public.payment_session_refunds psr
    WHERE psr.payment_session_id = v_ps.id
      AND psr.amount_pence > 0;

    IF v_existing_child_id IS NOT NULL
       AND v_existing_debit_id IS NOT NULL
       AND v_ps_refunded_sum = p_cumulative_refunded_pence THEN
      RETURN jsonb_build_object(
        'status', 'already_applied',
        'trip_id', p_trip_id,
        'payment_session_id', v_ps.id,
        'provider_refund_id', p_provider_refund_id,
        'refund_child_id', v_existing_child_id,
        'ledger_debit_id', v_existing_debit_id,
        'cumulative_refunded_pence', p_cumulative_refunded_pence,
        'recovered_from', 'unique_violation'
      );
    END IF;

    RAISE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.driver_effective_payout_allowed(p_driver_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
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
      OR d.deleted_at IS NOT NULL
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
$function$;

COMMIT;
