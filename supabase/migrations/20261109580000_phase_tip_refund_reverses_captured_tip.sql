-- A captured passenger tip is DRIVER_TIP_CREDIT, separate from TRIP_EARNING_NET.
-- apply_confirmed_provider_refund_atomic reversed only driver_net, so a refund
-- that returned the tip left the credit with the driver. Claw the tip only when
-- the cumulative refund exceeds the fare. A fare-only refund is unchanged.

CREATE OR REPLACE FUNCTION public.apply_confirmed_provider_refund_atomic(
  p_trip_id uuid,
  p_payment_provider text,
  p_provider_refund_id text,
  p_event_refund_amount_pence integer,
  p_cumulative_refunded_pence integer,
  p_provider_order_id text DEFAULT NULL,
  p_provider_payment_id text DEFAULT NULL,
  p_refund_reason text DEFAULT NULL,
  p_source text DEFAULT 'admin_refund',
  p_skip_driver_wallet_reversal boolean DEFAULT false
)
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
    AND dwl.driver_id = v_trip.driver_id
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
  v_driver_net_pence := greatest(0, coalesce(v_trip.driver_net_pence, 0));

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

  -- Reverse DRIVER_TIP_CREDIT only when the refund exceeds the fare.
  SELECT coalesce(sum(greatest(0, dwl.amount_pence)), 0)::integer
    INTO v_tip_credit_pence
  FROM public.driver_wallet_ledger dwl
  WHERE dwl.related_trip_id = p_trip_id
    AND dwl.type = 'DRIVER_TIP_CREDIT'
    AND (v_trip.driver_id IS NULL OR dwl.driver_id = v_trip.driver_id);

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
     AND v_trip.driver_id IS NOT NULL
     AND v_existing_debit_id IS NULL THEN
    SELECT coalesce(sum(greatest(0, dwl.amount_pence)), 0)::integer INTO v_credited_pence
    FROM public.driver_wallet_ledger dwl
    WHERE dwl.driver_id = v_trip.driver_id
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
        v_trip.driver_id,
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
      AND dwl.driver_id = v_trip.driver_id
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
