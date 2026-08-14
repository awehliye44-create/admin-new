-- Driver Withdraw post-pay: RLS for Withdrawal Details + EARLY_CASHOUT fee ledger split.
BEGIN;

-- ---------------------------------------------------------------------------
-- Drivers may read their own EARLY_CASHOUT payout items / batches (Wallet UI).
-- Weekly/admin payout rows remain admin-only.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Drivers read own early cashout payout items"
  ON public.payout_items;
CREATE POLICY "Drivers read own early cashout payout items"
  ON public.payout_items
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.drivers d
      JOIN public.payout_batches b ON b.id = payout_items.batch_id
      WHERE d.id = payout_items.driver_id
        AND d.user_id = auth.uid()
        AND b.kind = 'EARLY_CASHOUT'
    )
  );

DROP POLICY IF EXISTS "Drivers read own early cashout payout batches"
  ON public.payout_batches;
CREATE POLICY "Drivers read own early cashout payout batches"
  ON public.payout_batches
  FOR SELECT
  TO authenticated
  USING (
    kind = 'EARLY_CASHOUT'
    AND EXISTS (
      SELECT 1
      FROM public.payout_items i
      JOIN public.drivers d ON d.id = i.driver_id
      WHERE i.batch_id = payout_batches.id
        AND d.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- finalize_driver_payout_completion: EARLY_CASHOUT fee split when configured.
-- Historical items with net == gross (fee not applied at /pay) keep single debit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_driver_payout_completion(
  p_payout_item_id uuid,
  p_provider_payment_id text,
  p_provider_state text,
  p_provider_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_evidence_redacted jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_item public.payout_items%ROWTYPE;
  v_batch public.payout_batches%ROWTYPE;
  v_intent public.driver_payout_payment_intents%ROWTYPE;
  v_res public.driver_payout_reservations%ROWTYPE;
  v_intent_id UUID;
  v_res_id UUID;
  v_state TEXT := lower(btrim(COALESCE(p_provider_state, '')));
  v_pay_id TEXT := btrim(COALESCE(p_provider_payment_id, ''));
  v_now TIMESTAMPTZ := now();
  v_ledger_type TEXT;
  v_ledger_id UUID;
  v_fee_ledger_id UUID;
  v_existing_ledger UUID;
  v_existing_fee UUID;
  v_debit INTEGER;
  v_fee INTEGER := 0;
  v_net INTEGER;
  v_live BIGINT;
  v_reserved BIGINT;
  v_avail BIGINT;
  v_idem TEXT;
  v_desc TEXT;
  v_completed_at TIMESTAMPTZ;
  v_snap jsonb;
BEGIN
  IF v_state IS DISTINCT FROM 'completed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PROVIDER_NOT_COMPLETED',
      'message', format(
        'Provider state %L must never consume reservation or debit wallet',
        COALESCE(NULLIF(v_state, ''), 'unknown')
      ),
      'provider_state', NULLIF(v_state, ''),
      'wallet_debited', false,
      'reservation_consumed', false,
      'financially_applied', false
    );
  END IF;

  IF v_pay_id = '' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'MISSING_PROVIDER_PAYMENT_ID',
      'message', 'provider_payment_id required',
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  SELECT * INTO v_item
  FROM public.payout_items
  WHERE id = p_payout_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'VALIDATION_FAILED',
      'message', 'payout item not found'
    );
  END IF;

  SELECT * INTO v_batch
  FROM public.payout_batches
  WHERE id = v_item.batch_id
  FOR UPDATE;

  SELECT id INTO v_intent_id
  FROM public.driver_payout_payment_intents
  WHERE payout_item_id = p_payout_item_id
  ORDER BY
    CASE WHEN execution_status IN ('SUBMITTED', 'UNKNOWN', 'COMPLETED') THEN 0 ELSE 1 END,
    created_at DESC
  LIMIT 1;

  IF v_intent_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PAYOUT_ITEM_NOT_SUBMITTED',
      'message', 'payment intent not found',
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  SELECT * INTO v_intent
  FROM public.driver_payout_payment_intents
  WHERE id = v_intent_id
  FOR UPDATE;

  SELECT id INTO v_res_id
  FROM public.driver_payout_reservations
  WHERE payout_item_id = p_payout_item_id
    AND status IN ('ACTIVE', 'CONSUMED')
  ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, created_at DESC
  LIMIT 1;

  IF v_res_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'RESERVATION_NOT_ACTIVE',
      'message', 'no ACTIVE/CONSUMED reservation for item',
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  SELECT * INTO v_res
  FROM public.driver_payout_reservations
  WHERE id = v_res_id
  FOR UPDATE;

  IF v_intent.financially_applied_at IS NOT NULL
     AND v_res.status = 'CONSUMED'
  THEN
    IF v_intent.provider_payment_id IS DISTINCT FROM v_pay_id THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'PROVIDER_PAYMENT_ID_MISMATCH',
        'message', 'already applied under a different provider_payment_id'
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'already_applied', true,
      'reused', true,
      'payout_item_id', p_payout_item_id,
      'intent_id', v_intent.id,
      'reservation_id', v_res.id,
      'reservation_status', 'CONSUMED',
      'execution_status', 'COMPLETED',
      'item_status', COALESCE(v_item.status, 'COMPLETED'),
      'provider_payment_id', v_intent.provider_payment_id,
      'provider_state', 'completed',
      'ledger_entry_id', v_intent.financial_application_ledger_entry_id,
      'wallet_debited', true,
      'reservation_consumed', true,
      'financially_applied', true,
      'financially_applied_at', v_intent.financially_applied_at,
      'amount_pence', v_item.amount_pence
    );
  END IF;

  IF v_intent.provider_payment_id IS NOT NULL
     AND v_intent.provider_payment_id IS DISTINCT FROM v_pay_id
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PROVIDER_PAYMENT_ID_MISMATCH',
      'message', 'provider_payment_id does not match intent',
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  IF v_res.driver_id IS DISTINCT FROM v_item.driver_id
     OR v_intent.driver_id IS DISTINCT FROM v_item.driver_id
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'DRIVER_MISMATCH',
      'message', 'driver_id mismatch across item/intent/reservation'
    );
  END IF;

  -- Reservation always matches wallet gross. Intent may be gross (claim) even when
  -- Revolut /pay sent net (withdrawal fee deducted before provider transfer).
  IF v_res.amount_pence IS DISTINCT FROM v_item.amount_pence THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'AMOUNT_MISMATCH',
      'message', format(
        'amount mismatch item=%s reservation=%s',
        v_item.amount_pence, v_res.amount_pence
      )
    );
  END IF;

  IF COALESCE(v_batch.kind, '') = 'EARLY_CASHOUT' THEN
    IF v_intent.amount_pence IS DISTINCT FROM v_item.amount_pence
       AND v_intent.amount_pence IS DISTINCT FROM COALESCE(v_item.net_driver_payout_pence, v_item.amount_pence)
    THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'AMOUNT_MISMATCH',
        'message', format(
          'amount mismatch item=%s intent=%s net=%s',
          v_item.amount_pence, v_intent.amount_pence, v_item.net_driver_payout_pence
        )
      );
    END IF;
  ELSIF v_intent.amount_pence IS DISTINCT FROM v_item.amount_pence THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'AMOUNT_MISMATCH',
      'message', format(
        'amount mismatch item=%s intent=%s',
        v_item.amount_pence, v_intent.amount_pence
      )
    );
  END IF;

  IF upper(COALESCE(v_item.currency, 'GBP')) <> 'GBP'
     OR upper(COALESCE(v_res.currency, 'GBP')) <> 'GBP'
     OR upper(COALESCE(v_intent.currency, 'GBP')) <> 'GBP'
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'CURRENCY_MISMATCH',
      'message', 'currency must be GBP'
    );
  END IF;

  IF v_res.status NOT IN ('ACTIVE', 'CONSUMED') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'RESERVATION_NOT_ACTIVE',
      'message', format('reservation status %L cannot be consumed', v_res.status)
    );
  END IF;

  v_ledger_type := public.payout_batch_kind_to_ledger_type(COALESCE(v_batch.kind, 'WEEKLY_SCHEDULED'));
  IF v_ledger_type IN ('PAYOUT_RESERVATION_HOLD', 'PAYOUT_RESERVATION_RELEASE') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'VALIDATION_FAILED',
      'message', 'hold ledger types cannot finalise completion'
    );
  END IF;

  v_snap := COALESCE(v_item.eligibility_snapshot, '{}'::jsonb);
  IF COALESCE(v_batch.kind, '') = 'EARLY_CASHOUT' THEN
    v_fee := GREATEST(
      0,
      COALESCE(
        NULLIF(v_snap->>'withdrawal_fee_pence', '')::integer,
        CASE
          WHEN COALESCE(v_item.net_driver_payout_pence, v_item.amount_pence) < v_item.amount_pence
          THEN v_item.amount_pence - COALESCE(v_item.net_driver_payout_pence, v_item.amount_pence)
          ELSE 0
        END
      )
    );
    v_net := COALESCE(v_item.net_driver_payout_pence, v_item.amount_pence - v_fee);
    IF v_fee > 0 AND (v_net + v_fee) IS DISTINCT FROM v_item.amount_pence THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'FEE_AMOUNT_MISMATCH',
        'message', format('gross=%s net=%s fee=%s must reconcile', v_item.amount_pence, v_net, v_fee)
      );
    END IF;
    IF v_fee <= 0 THEN
      v_net := v_item.amount_pence;
      v_fee := 0;
    END IF;
  ELSE
    v_net := v_item.amount_pence;
    v_fee := 0;
  END IF;

  v_debit := -ABS(v_net);
  v_idem := 'revolut-payout-completion:' || v_pay_id;
  v_desc := format(
    'Revolut payout completion debit item=%s payment=%s reservation=%s',
    p_payout_item_id, v_pay_id, v_res.id
  );
  v_completed_at := COALESCE(p_provider_completed_at, v_now);

  SELECT id INTO v_existing_ledger
  FROM public.driver_wallet_ledger
  WHERE provider_payout_id = v_pay_id
    AND type IN ('WEEKLY_PAYOUT', 'PAYOUT', 'MANUAL_PAYOUT', 'EARLY_CASHOUT')
    AND amount_pence < 0
  LIMIT 1;

  IF v_existing_ledger IS NOT NULL THEN
    v_ledger_id := v_existing_ledger;
  ELSE
    INSERT INTO public.driver_wallet_ledger (
      driver_id,
      type,
      amount_pence,
      currency,
      description,
      provider_payout_id,
      created_at
    ) VALUES (
      v_item.driver_id,
      v_ledger_type,
      v_debit,
      'GBP',
      v_desc,
      v_pay_id,
      v_completed_at
    )
    RETURNING id INTO v_ledger_id;
  END IF;

  IF v_fee > 0 THEN
    SELECT id INTO v_existing_fee
    FROM public.driver_wallet_ledger
    WHERE provider_payout_id = v_pay_id
      AND type = 'CASHOUT_FEE'
      AND amount_pence < 0
    LIMIT 1;

    IF v_existing_fee IS NOT NULL THEN
      v_fee_ledger_id := v_existing_fee;
    ELSE
      INSERT INTO public.driver_wallet_ledger (
        driver_id,
        type,
        amount_pence,
        currency,
        description,
        provider_payout_id,
        created_at
      ) VALUES (
        v_item.driver_id,
        'CASHOUT_FEE',
        -ABS(v_fee),
        'GBP',
        format('Withdrawal fee for payout item=%s payment=%s', p_payout_item_id, v_pay_id),
        v_pay_id,
        v_completed_at
      )
      RETURNING id INTO v_fee_ledger_id;
    END IF;
  END IF;

  IF v_res.status = 'ACTIVE' THEN
    UPDATE public.driver_payout_reservations
    SET
      status = 'CONSUMED',
      consumed_at = COALESCE(consumed_at, v_now),
      debit_ledger_entry_id = v_ledger_id,
      provider_payment_id = v_pay_id,
      completion_idempotency_key = v_idem,
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'slice', 8,
        'consumed_via', 'finalize_driver_payout_completion',
        'provider_payment_id', v_pay_id,
        'ledger_entry_id', v_ledger_id,
        'fee_ledger_entry_id', v_fee_ledger_id,
        'withdrawal_fee_pence', v_fee,
        'provider_transfer_pence', ABS(v_debit)
      ),
      updated_at = v_now
    WHERE id = v_res.id
    RETURNING * INTO v_res;
  ELSIF v_res.status = 'CONSUMED' THEN
    IF v_res.debit_ledger_entry_id IS NOT NULL
       AND v_res.debit_ledger_entry_id IS DISTINCT FROM v_ledger_id
    THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'INVARIANT_PARTIAL_STATE',
        'message', 'CONSUMED reservation linked to a different debit'
      );
    END IF;
    UPDATE public.driver_payout_reservations
    SET
      debit_ledger_entry_id = COALESCE(debit_ledger_entry_id, v_ledger_id),
      provider_payment_id = COALESCE(provider_payment_id, v_pay_id),
      completion_idempotency_key = COALESCE(completion_idempotency_key, v_idem),
      updated_at = v_now
    WHERE id = v_res.id
    RETURNING * INTO v_res;
  END IF;

  UPDATE public.driver_payout_payment_intents
  SET
    execution_status = 'COMPLETED',
    provider_payment_id = v_pay_id,
    provider_state = 'completed',
    provider_completed_at = COALESCE(provider_completed_at, v_completed_at),
    last_provider_sync_at = v_now,
    financially_applied_at = COALESCE(financially_applied_at, v_now),
    financial_application_ledger_entry_id = v_ledger_id,
    completion_evidence_redacted = COALESCE(p_evidence_redacted, '{}'::jsonb),
    updated_at = v_now
  WHERE id = v_intent.id
  RETURNING * INTO v_intent;

  UPDATE public.payout_items
  SET
    status = 'COMPLETED',
    execution_status = 'COMPLETED',
    ledger_entry_id = COALESCE(ledger_entry_id, v_ledger_id),
    completed_at = COALESCE(completed_at, v_now),
    wallet_recalculated_at = v_now,
    ledger_sync_error = NULL,
    updated_at = v_now
  WHERE id = p_payout_item_id
  RETURNING * INTO v_item;

  PERFORM public.refresh_driver_wallet_reservation_cache(v_item.driver_id);
  BEGIN
    PERFORM public.recalculate_driver_wallet(v_item.driver_id);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  v_live := public.driver_wallet_live_balance_pence(v_item.driver_id);
  v_reserved := public.driver_wallet_active_reservation_pence(v_item.driver_id);
  v_avail := public.driver_wallet_available_for_payout_pence(v_item.driver_id);

  UPDATE public.payout_batches
  SET
    status = CASE
      WHEN EXISTS (
        SELECT 1 FROM public.driver_payout_reservations r
        WHERE r.payout_batch_id = v_item.batch_id AND r.status = 'ACTIVE'
      ) THEN 'PROVIDER_SUBMISSION_PARTIAL'
      ELSE COALESCE(status, 'PROVIDER_SUBMISSION_PARTIAL')
    END,
    updated_at = v_now
  WHERE id = v_item.batch_id
    AND status IN (
      'PROVIDER_SUBMISSION_IN_PROGRESS',
      'PROVIDER_SUBMISSION_PARTIAL',
      'FUNDS_RESERVED_EXECUTION_DISABLED'
    );

  RETURN jsonb_build_object(
    'ok', true,
    'already_applied', false,
    'reused', v_existing_ledger IS NOT NULL AND v_res.status = 'CONSUMED',
    'payout_item_id', p_payout_item_id,
    'intent_id', v_intent.id,
    'reservation_id', v_res.id,
    'reservation_status', 'CONSUMED',
    'execution_status', 'COMPLETED',
    'item_status', 'COMPLETED',
    'provider_payment_id', v_pay_id,
    'provider_state', 'completed',
    'ledger_entry_id', v_ledger_id,
    'fee_ledger_entry_id', v_fee_ledger_id,
    'ledger_type', v_ledger_type,
    'amount_pence', v_item.amount_pence,
    'provider_transfer_pence', ABS(v_debit),
    'withdrawal_fee_pence', v_fee,
    'currency', 'GBP',
    'wallet_debited', true,
    'reservation_consumed', true,
    'financially_applied', true,
    'live_wallet_balance_pence', v_live,
    'active_reserved_payout_pence', v_reserved,
    'available_for_payout_pence', v_avail,
    'financially_applied_at', v_intent.financially_applied_at
  );
END;
$function$;

COMMIT;
