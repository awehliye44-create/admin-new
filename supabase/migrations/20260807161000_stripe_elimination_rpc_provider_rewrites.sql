-- Follow-up to 20260807160000: rewrite payout/assert/ops RPCs off dropped stripe_* columns.
-- Already applied to thazislrdkjpvvghtvzo on 2026-08-07 during Stripe elimination.
BEGIN;
DROP FUNCTION IF EXISTS public.insert_payout_ledger_debit_if_missing(uuid, integer, text, text, text, text, text, timestamp with time zone);
CREATE OR REPLACE FUNCTION public.insert_payout_ledger_debit_if_missing(p_driver_id uuid, p_amount_pence integer, p_ledger_type text, p_currency text, p_description text, p_provider_transfer_id text, p_provider_payout_id text, p_paid_at timestamp with time zone DEFAULT now())
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_existing_id uuid;
  v_new_id uuid;
  v_debit integer;
BEGIN
  IF p_amount_pence >= 0 THEN
    RAISE EXCEPTION 'Payout ledger debit must be negative, got %', p_amount_pence;
  END IF;

  v_debit := p_amount_pence;

  IF p_provider_payout_id IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM driver_wallet_ledger
    WHERE provider_payout_id = p_provider_payout_id
      AND type IN ('WEEKLY_PAYOUT', 'PAYOUT', 'MANUAL_PAYOUT', 'EARLY_CASHOUT')
    LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  IF p_provider_transfer_id IS NOT NULL THEN
    SELECT id INTO v_existing_id
    FROM driver_wallet_ledger
    WHERE provider_transfer_id = p_provider_transfer_id
      AND type IN ('WEEKLY_PAYOUT', 'PAYOUT', 'MANUAL_PAYOUT', 'EARLY_CASHOUT')
    LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
      RETURN v_existing_id;
    END IF;
  END IF;

  INSERT INTO driver_wallet_ledger (
    driver_id,
    type,
    amount_pence,
    currency,
    description,
    provider_transfer_id,
    provider_payout_id,
    created_at
  ) VALUES (
    p_driver_id,
    p_ledger_type,
    v_debit,
    COALESCE(NULLIF(upper(p_currency), ''), 'GBP'),
    p_description,
    p_provider_transfer_id,
    p_provider_payout_id,
    COALESCE(p_paid_at, now())
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.sync_payout_item_ledger_debit(p_payout_item_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item payout_items%ROWTYPE;
  v_batch payout_batches%ROWTYPE;
  v_ledger_id uuid;
  v_ledger_type text;
  v_currency text;
  v_debit integer;
  v_driver_region text;
BEGIN
  SELECT * INTO v_item FROM payout_items WHERE id = p_payout_item_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'payout_item_not_found');
  END IF;

  IF v_item.ledger_entry_id IS NOT NULL THEN
    PERFORM recalculate_driver_wallet(v_item.driver_id);
    UPDATE payout_items SET
      status = 'completed',
      wallet_recalculated_at = COALESCE(wallet_recalculated_at, now()),
      ledger_sync_error = NULL,
      updated_at = now()
    WHERE id = p_payout_item_id;

    RETURN jsonb_build_object(
      'success', true,
      'ledger_entry_id', v_item.ledger_entry_id,
      'already_synced', true
    );
  END IF;

  IF v_item.provider_transfer_id IS NULL AND v_item.provider_payout_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'missing_provider_reference',
      'detail', 'provider_transfer_id or provider_payout_id required'
    );
  END IF;

  SELECT * INTO v_batch FROM payout_batches WHERE id = v_item.batch_id;
  v_ledger_type := payout_batch_kind_to_ledger_type(COALESCE(v_batch.kind, 'MANUAL_ADMIN'));
  v_debit := -ABS(COALESCE(v_item.driver_amount_pence, v_item.amount_pence, 0));

  IF v_debit = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'zero_payout_amount');
  END IF;

  SELECT COALESCE(r.currency_code, 'gbp') INTO v_currency
  FROM drivers d
  LEFT JOIN regions r ON r.id = d.region_id
  WHERE d.id = v_item.driver_id;

  v_ledger_id := insert_payout_ledger_debit_if_missing(
    v_item.driver_id,
    v_debit,
    v_ledger_type,
    v_currency,
    CASE
      WHEN v_ledger_type = 'WEEKLY_PAYOUT' THEN 'Weekly payout to bank'
      WHEN v_ledger_type = 'MANUAL_PAYOUT' THEN 'Manual payout to bank'
      ELSE 'Payout to bank'
    END,
    v_item.provider_transfer_id,
    v_item.provider_payout_id,
    COALESCE(v_item.completed_at, now())
  );

  PERFORM recalculate_driver_wallet(v_item.driver_id);

  UPDATE payout_items SET
    status = 'completed',
    ledger_entry_id = v_ledger_id,
    wallet_recalculated_at = now(),
    ledger_sync_error = NULL,
    completed_at = COALESCE(completed_at, now()),
    updated_at = now()
  WHERE id = p_payout_item_id;

  IF v_batch.id IS NOT NULL THEN
    UPDATE payout_batches SET
      status = 'completed',
      successful_payouts = GREATEST(COALESCE(successful_payouts, 0), 1),
      failed_payouts = 0,
      completed_at = COALESCE(completed_at, now()),
      updated_at = now()
    WHERE id = v_batch.id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'ledger_entry_id', v_ledger_id,
    'driver_id', v_item.driver_id,
    'amount_pence', v_debit,
    'wallet_recalculated', true
  );
EXCEPTION WHEN OTHERS THEN
  UPDATE payout_items SET
    status = 'ledger_sync_failed',
    ledger_sync_error = SQLERRM,
    updated_at = now()
  WHERE id = p_payout_item_id;

  RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$

;

CREATE OR REPLACE FUNCTION public.finalize_driver_payout_completion(p_payout_item_id uuid, p_provider_payment_id text, p_provider_state text, p_provider_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_evidence_redacted jsonb DEFAULT '{}'::jsonb)
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
  v_existing_ledger UUID;
  v_debit INTEGER;
  v_live BIGINT;
  v_reserved BIGINT;
  v_avail BIGINT;
  v_idem TEXT;
  v_desc TEXT;
  v_completed_at TIMESTAMPTZ;
BEGIN
  -- HARD RULE: only canonical Revolut completed may finalise.
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

  -- Lock item first, then intent + reservation (serialises retries / concurrent webhooks).
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

  -- Prefer ACTIVE reservation; allow CONSUMED for idempotent reuse.
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

  -- Idempotent reuse: already financially applied.
  IF v_intent.financially_applied_at IS NOT NULL
     AND v_res.status = 'CONSUMED'
     AND v_intent.financial_application_ledger_entry_id IS NOT NULL
  THEN
    IF v_intent.provider_payment_id IS DISTINCT FROM v_pay_id THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'PROVIDER_PAYMENT_ID_MISMATCH',
        'message', 'already applied under a different provider_payment_id'
      );
    END IF;

    v_live := public.driver_wallet_live_balance_pence(v_item.driver_id);
    v_reserved := public.driver_wallet_active_reservation_pence(v_item.driver_id);
    v_avail := public.driver_wallet_available_for_payout_pence(v_item.driver_id);

    RETURN jsonb_build_object(
      'ok', true,
      'already_applied', true,
      'reused', true,
      'payout_item_id', p_payout_item_id,
      'intent_id', v_intent.id,
      'reservation_id', v_res.id,
      'reservation_status', 'CONSUMED',
      'execution_status', 'COMPLETED',
      'item_status', 'COMPLETED',
      'provider_payment_id', v_intent.provider_payment_id,
      'provider_state', 'completed',
      'ledger_entry_id', v_intent.financial_application_ledger_entry_id,
      'ledger_type', 'WEEKLY_PAYOUT',
      'amount_pence', v_item.amount_pence,
      'currency', upper(COALESCE(v_item.currency, 'GBP')),
      'wallet_debited', true,
      'reservation_consumed', true,
      'financially_applied', true,
      'financially_applied_at', v_intent.financially_applied_at,
      'provider_completed_at', v_intent.provider_completed_at,
      'live_balance_pence', v_live,
      'active_reservation_pence', v_reserved,
      'available_pence', v_avail
    );
  END IF;

  -- Partial-state recovery still requires matches below.
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

  IF upper(COALESCE(v_item.status, '')) NOT IN ('SUBMITTED', 'UNKNOWN', 'COMPLETED') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PAYOUT_ITEM_NOT_SUBMITTED',
      'message', format('item status %L not eligible', v_item.status),
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  IF upper(COALESCE(v_intent.execution_status, '')) NOT IN ('SUBMITTED', 'UNKNOWN', 'COMPLETED') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PAYOUT_ITEM_NOT_SUBMITTED',
      'message', format('intent status %L not eligible', v_intent.execution_status),
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  IF v_res.status NOT IN ('ACTIVE', 'CONSUMED') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'RESERVATION_NOT_ACTIVE',
      'message', format('reservation status %L', v_res.status),
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

  IF v_res.amount_pence IS DISTINCT FROM v_item.amount_pence
     OR v_intent.amount_pence IS DISTINCT FROM v_item.amount_pence
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'AMOUNT_MISMATCH',
      'message', format(
        'amount mismatch item=%s reservation=%s intent=%s',
        v_item.amount_pence, v_res.amount_pence, v_intent.amount_pence
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

  v_ledger_type := public.payout_batch_kind_to_ledger_type(COALESCE(v_batch.kind, 'WEEKLY_SCHEDULED'));
  -- Permanent debit must reduce live balance (never hold types).
  IF v_ledger_type IN ('PAYOUT_RESERVATION_HOLD', 'PAYOUT_RESERVATION_RELEASE') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'VALIDATION_FAILED',
      'message', 'hold ledger types cannot finalise completion'
    );
  END IF;

  v_debit := -ABS(v_item.amount_pence);
  v_idem := 'revolut-payout-completion:' || v_pay_id;
  v_desc := format(
    'Revolut payout completion debit item=%s payment=%s reservation=%s',
    p_payout_item_id, v_pay_id, v_res.id
  );
  v_completed_at := COALESCE(p_provider_completed_at, v_now);

  -- Idempotent debit by Revolut payment id (stored in provider_payout_id column).
  SELECT id INTO v_existing_ledger
  FROM public.driver_wallet_ledger
  WHERE provider_payout_id = v_pay_id
    AND type IN ('WEEKLY_PAYOUT', 'PAYOUT', 'MANUAL_PAYOUT')
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

  -- Consume reservation (or verify already consumed with same debit).
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
        'ledger_entry_id', v_ledger_id
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

  -- Mark intent completed + financially applied.
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

  -- Recalculate liabilities from ledger (live + reserved cache).
  PERFORM public.refresh_driver_wallet_reservation_cache(v_item.driver_id);
  BEGIN
    PERFORM public.recalculate_driver_wallet(v_item.driver_id);
  EXCEPTION WHEN OTHERS THEN
    -- refresh_driver_wallet_reservation_cache already set ledger-derived available/pending.
    NULL;
  END;

  v_live := public.driver_wallet_live_balance_pence(v_item.driver_id);
  v_reserved := public.driver_wallet_active_reservation_pence(v_item.driver_id);
  v_avail := public.driver_wallet_available_for_payout_pence(v_item.driver_id);

  -- Batch status: keep non-automatic; reflect partial provider completion.
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
    'ledger_type', v_ledger_type,
    'amount_pence', v_item.amount_pence,
    'currency', 'GBP',
    'wallet_debited', true,
    'reservation_consumed', true,
    'financially_applied', true,
    'financially_applied_at', v_intent.financially_applied_at,
    'provider_completed_at', v_intent.provider_completed_at,
    'live_balance_pence', v_live,
    'active_reservation_pence', v_reserved,
    'available_pence', v_avail,
    'revolut_pay_called', false
  );
END;
$function$

;

CREATE OR REPLACE FUNCTION public.finalize_driver_early_cashout_paid(p_cashout_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cashout public.driver_early_cashouts%ROWTYPE;
  v_ledger_cashout_id uuid;
  v_ledger_fee_id uuid;
  v_now timestamptz := now();
BEGIN
  SELECT *
  INTO v_cashout
  FROM public.driver_early_cashouts
  WHERE id = p_cashout_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'driver_early_cashouts not found: %', p_cashout_id;
  END IF;

  IF v_cashout.ledger_cashout_id IS NOT NULL THEN
    RETURN jsonb_build_object('already_finalized', true);
  END IF;

  IF v_cashout.provider_payout_id IS NOT NULL THEN
    SELECT dwl.id
    INTO v_ledger_cashout_id
    FROM public.driver_wallet_ledger dwl
    WHERE dwl.provider_payout_id = v_cashout.provider_payout_id
      AND dwl.type = 'EARLY_CASHOUT'
    ORDER BY dwl.created_at
    LIMIT 1;
  END IF;

  IF v_ledger_cashout_id IS NULL THEN
    BEGIN
      INSERT INTO public.driver_wallet_ledger (
        driver_id,
        type,
        amount_pence,
        currency,
        provider_transfer_id,
        provider_payout_id,
        description,
        created_at
      ) VALUES (
        v_cashout.driver_id,
        'EARLY_CASHOUT',
        -v_cashout.driver_receives_pence,
        COALESCE(v_cashout.currency, 'GBP'),
        v_cashout.provider_transfer_id,
        v_cashout.provider_payout_id,
        'Early Cash Out',
        v_now
      )
      RETURNING id INTO v_ledger_cashout_id;
    EXCEPTION
      WHEN unique_violation THEN
        SELECT dwl.id
        INTO v_ledger_cashout_id
        FROM public.driver_wallet_ledger dwl
        WHERE dwl.provider_payout_id = v_cashout.provider_payout_id
          AND dwl.type = 'EARLY_CASHOUT'
        ORDER BY dwl.created_at
        LIMIT 1;

        IF v_ledger_cashout_id IS NULL THEN
          RAISE;
        END IF;
    END;
  END IF;

  UPDATE public.driver_early_cashouts
  SET
    status = 'paid',
    ledger_cashout_id = v_ledger_cashout_id,
    paid_at = COALESCE(v_cashout.paid_at, v_now),
    failure_reason = NULL,
    updated_at = v_now
  WHERE id = p_cashout_id
    AND ledger_cashout_id IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('already_finalized', true);
  END IF;

  IF v_cashout.ledger_fee_id IS NULL THEN
    INSERT INTO public.driver_wallet_ledger (
      driver_id,
      type,
      amount_pence,
      currency,
      description,
      created_at
    ) VALUES (
      v_cashout.driver_id,
      'CASHOUT_FEE',
      -v_cashout.early_cashout_fee_pence,
      COALESCE(v_cashout.currency, 'GBP'),
      'Cash Out Fee',
      v_now
    )
    RETURNING id INTO v_ledger_fee_id;

    UPDATE public.driver_early_cashouts
    SET ledger_fee_id = v_ledger_fee_id, updated_at = v_now
    WHERE id = p_cashout_id;
  END IF;

  RETURN jsonb_build_object('already_finalized', false);
END;
$function$

;

CREATE OR REPLACE FUNCTION public.assert_payment_authorized(_trip_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.trips
    WHERE id = _trip_id
      AND (
        payment_method = 'cash'
        OR (provider_order_id IS NOT NULL AND payment_status IN ('preauth_authorized','captured','succeeded'))
      )
  );
$function$

;

CREATE OR REPLACE FUNCTION public.enforce_payment_switch_rules()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old text;
  v_new text;
BEGIN
  v_old := COALESCE(OLD.payment_method, '');
  v_new := COALESCE(NEW.payment_method, '');

  -- Allow inserts and unchanged values to pass
  IF v_old = v_new THEN
    RETURN NEW;
  END IF;

  -- After any terminal state, do not allow swapping payment method
  IF OLD.status IN ('completed', 'cancelled', 'expired', 'no_show') THEN
    RAISE EXCEPTION 'Cannot change payment method on a finalized trip (status=%)', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rule: digital -> cash is NEVER allowed during a booking
  IF v_old IN ('card', 'apple_pay', 'google_pay', 'wallet')
     AND v_new = 'cash' THEN
    RAISE EXCEPTION 'Switching from digital payment to cash is not allowed once a booking has started'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rule: cash -> digital is only allowed if a Stripe PaymentIntent is present
  --       (i.e. authorization has already happened server-side)
  IF v_old = 'cash'
     AND v_new IN ('card', 'apple_pay', 'google_pay', 'wallet')
     AND NEW.provider_order_id IS NULL THEN
    RAISE EXCEPTION 'Switching from cash to a digital payment requires a successful authorization first'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.get_driver_own_profile_contact(p_driver_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_driver public.drivers%ROWTYPE;
  v_region_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_driver_id IS NULL THEN
    SELECT d.*
    INTO v_driver
    FROM public.drivers d
    WHERE d.user_id = auth.uid()
      AND d.deleted_at IS NULL
    ORDER BY d.updated_at DESC, d.created_at DESC
    LIMIT 1;
  ELSE
    SELECT d.*
    INTO v_driver
    FROM public.drivers d
    WHERE d.id = p_driver_id
      AND d.user_id = auth.uid()
      AND d.deleted_at IS NULL;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Driver profile not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_driver.region_id IS NOT NULL THEN
    SELECT r.name INTO v_region_name
    FROM public.regions r
    WHERE r.id = v_driver.region_id;
  END IF;

  RETURN jsonb_build_object(
    'id', v_driver.id,
    'first_name', v_driver.first_name,
    'last_name', v_driver.last_name,
    'driver_code', v_driver.driver_code,
    'rating', v_driver.rating,
    'display_rating', v_driver.display_rating,
    'rating_count', v_driver.rating_count,
    'total_trips', v_driver.total_trips,
    'phone', v_driver.phone,
    'email', v_driver.email,
    'residential_address', v_driver.residential_address,
    'postcode', v_driver.postcode,
    'city', v_driver.city,
    'country', v_driver.country,
    'country_code', v_driver.country_code,
    'profile_photo_url', v_driver.profile_photo_url,
    'approval_status', v_driver.approval_status,
    'vehicle_locked', v_driver.vehicle_locked,
    'category_id', v_driver.category_id,
    'payouts_enabled', v_driver.payouts_enabled,
    'onboarding_complete', v_driver.onboarding_complete,
    'region_id', v_driver.region_id,
    'region', CASE
      WHEN v_region_name IS NOT NULL THEN jsonb_build_object('name', v_region_name)
      ELSE NULL
    END
  );
END;
$function$

;

CREATE OR REPLACE FUNCTION public.driver_cancel_before_start_rematch(p_trip_id uuid, p_driver_id uuid, p_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_request_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_now timestamptz := now();
  v_uid uuid := auth.uid();
  v_jwt_role text := COALESCE(
    NULLIF(auth.role(), ''),
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    'anon'
  );
  v_meta jsonb := COALESCE(p_request_metadata, '{}'::jsonb);
  v_actor_mode text := lower(COALESCE(v_meta->>'actor_mode', ''));
  v_actor text;
  v_auth_driver_id uuid;
  v_status text;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_idem text := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_prev_cancelled uuid[];
  v_next_cancelled uuid[];
  v_prev_excluded uuid[];
  v_next_excluded uuid[];
  v_round_before integer;
  v_round_after integer;
  v_max_offer_round integer;
  v_find_minutes integer;
  v_search_expires timestamptz;
  v_audit_id uuid;
  v_active_offer_id uuid;
  v_customer_active uuid;
  v_finance_before jsonb;
  v_finance_after jsonb;
  v_outbox_key text;
  v_result jsonb;
  v_existing jsonb;
  v_idem_trip uuid;
  v_idem_driver uuid;
  v_outbox_status text;
BEGIN
  IF p_trip_id IS NULL OR p_driver_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'VALIDATION',
      'message', 'trip_id and driver_id are required'
    );
  END IF;

  -- Reject explicit no-show routing (never infer from free text alone).
  IF COALESCE((v_meta->>'is_no_show')::boolean, false)
     OR lower(COALESCE(v_meta->>'action_type', '')) IN ('no_show', 'passenger_no_show', 'noshow')
     OR lower(COALESCE(v_meta->>'cancellation_type', '')) IN ('no_show', 'passenger_no_show')
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'NO_SHOW_NOT_ALLOWED',
      'message', 'No-show must use cancel-trip with is_no_show=true; rematch RPC rejects no-show'
    );
  END IF;

  -- Authorise actor
  IF v_jwt_role = 'service_role' THEN
    IF v_actor_mode NOT IN ('service_role', 'edge', 'admin') THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'FORBIDDEN',
        'message', 'service_role rematch requires explicit actor_mode in request metadata'
      );
    END IF;
    v_actor := COALESCE(NULLIF(v_meta->>'actor', ''), v_actor_mode);
  ELSIF v_uid IS NOT NULL AND public.has_role(v_uid, 'admin'::public.app_role) THEN
    v_actor := 'admin';
    v_actor_mode := 'admin';
  ELSIF v_uid IS NOT NULL THEN
    SELECT d.id INTO v_auth_driver_id
    FROM public.drivers d
    WHERE d.user_id = v_uid
      AND d.id = p_driver_id
    LIMIT 1;
    IF v_auth_driver_id IS NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'FORBIDDEN',
        'message', 'Caller is not authorised for this driver_id'
      );
    END IF;
    v_actor := 'driver';
    v_actor_mode := 'driver';
  ELSE
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'UNAUTHORIZED',
      'message', 'Authentication required'
    );
  END IF;

  -- Lock trip first so concurrent cancel/start/customer-cancel serialize on one row.
  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'NOT_FOUND',
      'message', 'Trip not found'
    );
  END IF;

  -- Idempotent replay check (after trip lock; claim happens only after validation).
  -- Keys are trip-scoped: reuse against a different trip_id/driver_id is rejected.
  IF v_idem IS NOT NULL THEN
    SELECT result, trip_id, driver_id
      INTO v_existing, v_idem_trip, v_idem_driver
    FROM public.driver_cancel_rematch_idempotency
    WHERE idempotency_key = v_idem
    FOR UPDATE;

    IF FOUND THEN
      IF v_idem_trip IS DISTINCT FROM p_trip_id THEN
        RETURN jsonb_build_object(
          'ok', false,
          'error', 'CONFLICT',
          'message', 'Idempotency key already used for a different trip'
        );
      END IF;
      IF v_idem_driver IS DISTINCT FROM p_driver_id THEN
        RETURN jsonb_build_object(
          'ok', false,
          'error', 'CONFLICT',
          'message', 'Idempotency key already used for a different driver'
        );
      END IF;
      IF COALESCE((v_existing->>'pending')::boolean, false) THEN
        RETURN jsonb_build_object(
          'ok', false,
          'error', 'CONFLICT',
          'message', 'Rematch already in progress for this idempotency key'
        );
      END IF;
      RETURN COALESCE(v_existing, '{}'::jsonb) || jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  v_status := lower(COALESCE(v_trip.status, ''));

  -- Already rematched for this driver (CAS soft idempotency without prior key).
  -- Ensure a retryable outbox row exists so Edge does not skip rebroadcast forever.
  IF v_status = 'searching_new_driver'
     AND v_trip.confirmed_driver_id IS NULL
     AND (
       p_driver_id = ANY (COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[]))
       OR EXISTS (
         SELECT 1 FROM public.trip_driver_exclusions tde
         WHERE tde.trip_id = p_trip_id AND tde.driver_id = p_driver_id
           AND tde.source = 'driver_cancel_before_start'
       )
     )
  THEN
    -- auto-dispatch owns round increment; rematch only records the stored round.
    v_round_after := COALESCE(v_trip.current_broadcast_round, 0);
    v_outbox_key := COALESCE(
      v_idem,
      format(
        'driver_cancel_before_pickup:%s:%s:r%s',
        p_trip_id,
        p_driver_id,
        v_round_after
      )
    );

    INSERT INTO public.dispatch_intent_outbox (
      trip_id, intent, trigger_reason, idempotency_key, status, payload
    ) VALUES (
      p_trip_id,
      'auto_dispatch_rebroadcast',
      'driver_cancel_before_pickup',
      v_outbox_key,
      'pending',
      jsonb_build_object(
        'force_rebroadcast', true,
        'driver_id', p_driver_id,
        'soft_idempotent', true,
        'broadcast_round', v_round_after
      )
    )
    ON CONFLICT (idempotency_key) DO UPDATE
    SET
      status = CASE
        WHEN public.dispatch_intent_outbox.status = 'done' THEN public.dispatch_intent_outbox.status
        ELSE 'pending'
      END,
      last_error = CASE
        WHEN public.dispatch_intent_outbox.status = 'done' THEN public.dispatch_intent_outbox.last_error
        ELSE NULL
      END
    WHERE public.dispatch_intent_outbox.status IS DISTINCT FROM 'done';

    SELECT status INTO v_outbox_status
    FROM public.dispatch_intent_outbox
    WHERE idempotency_key = v_outbox_key;

    v_result := jsonb_build_object(
      'ok', true,
      'outcome', 'rematch',
      'trip_id', p_trip_id,
      'previous_status', v_trip.status,
      'status', 'searching_new_driver',
      'dispatch_status', COALESCE(v_trip.dispatch_status, 'broadcasting'),
      'driver_cleared', true,
      'driver_excluded', true,
      'payment_action', 'unchanged',
      'idempotent_replay', true,
      'current_broadcast_round', v_round_after,
      'dispatch_outbox_key', v_outbox_key,
      'dispatch_outbox_status', v_outbox_status,
      'finance_unchanged', true,
      'customer_active_trip_preserved', true
    );
    IF v_idem IS NOT NULL THEN
      INSERT INTO public.driver_cancel_rematch_idempotency (
        idempotency_key, trip_id, driver_id, result
      ) VALUES (v_idem, p_trip_id, p_driver_id, v_result)
      ON CONFLICT (idempotency_key) DO UPDATE
      SET result = EXCLUDED.result
      WHERE public.driver_cancel_rematch_idempotency.trip_id = p_trip_id
        AND public.driver_cancel_rematch_idempotency.driver_id = p_driver_id;
    END IF;
    RETURN v_result;
  END IF;

  IF v_trip.confirmed_driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'FORBIDDEN',
      'message', 'Requesting driver is not the current assignment SSOT'
    );
  END IF;

  IF public.is_driver_cancel_rematch_rejected_status(v_status)
     OR NOT public.is_driver_cancel_rematch_eligible_status(v_status)
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'INVALID_STATE',
      'message', format('Status %s is not rematchable for driver cancel before start', COALESCE(v_trip.status, 'null'))
    );
  END IF;

  IF v_trip.started_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'INVALID_STATE',
      'message', 'Trip already started — rematch not allowed'
    );
  END IF;

  -- Claim idempotency key only after validation (trip lock serializes same-trip callers).
  IF v_idem IS NOT NULL THEN
    INSERT INTO public.driver_cancel_rematch_idempotency (
      idempotency_key, trip_id, driver_id, result
    ) VALUES (
      v_idem, p_trip_id, p_driver_id,
      jsonb_build_object('ok', null, 'pending', true)
    )
    ON CONFLICT (idempotency_key) DO NOTHING;

    SELECT result, trip_id, driver_id
      INTO v_existing, v_idem_trip, v_idem_driver
    FROM public.driver_cancel_rematch_idempotency
    WHERE idempotency_key = v_idem
    FOR UPDATE;

    IF FOUND THEN
      IF v_idem_trip IS DISTINCT FROM p_trip_id
         OR v_idem_driver IS DISTINCT FROM p_driver_id
      THEN
        RETURN jsonb_build_object(
          'ok', false,
          'error', 'CONFLICT',
          'message', 'Idempotency key already used for a different trip/driver'
        );
      END IF;
      IF NOT COALESCE((v_existing->>'pending')::boolean, false) THEN
        RETURN COALESCE(v_existing, '{}'::jsonb) || jsonb_build_object('idempotent_replay', true);
      END IF;
    END IF;
  END IF;

  -- Snapshot finance identity (must remain unchanged)
  v_finance_before := jsonb_build_object(
    'fare', v_trip.fare,
    'fare_amount', v_trip.fare_amount,
    'estimated_fare', v_trip.estimated_fare,
    'estimated_total_pence', v_trip.estimated_total_pence,
    'gross_fare_pence', v_trip.gross_fare_pence,
    'final_fare_pence', v_trip.final_fare_pence,
    'final_customer_fare_pence', v_trip.final_customer_fare_pence,
    'discount_pence', v_trip.discount_pence,
    'voucher_discount_pence', v_trip.voucher_discount_pence,
    'offer_discount_pence', v_trip.offer_discount_pence,
    'payment_intent_id', v_trip.payment_intent_id,
    'payment_status', v_trip.payment_status,
    'payment_state', v_trip.payment_state,
    'payment_method', v_trip.payment_method,
    'provider_order_id', v_trip.provider_order_id,
    'applied_offer_id', v_trip.applied_offer_id,
    'applied_personal_voucher_id', v_trip.applied_personal_voucher_id,
    'passenger_id', v_trip.passenger_id
  );

  SELECT active_trip_id INTO v_customer_active
  FROM public.customers
  WHERE id = v_trip.passenger_id OR user_id = v_trip.passenger_id
  LIMIT 1;

  v_round_before := COALESCE(v_trip.current_broadcast_round, 0);
  SELECT COALESCE(MAX(ro.broadcast_round), 0) INTO v_max_offer_round
  FROM public.ride_offers ro
  WHERE ro.trip_id = p_trip_id;
  -- auto-dispatch owns the next-wave increment (storedRound+1). Rematch records
  -- the intended next round for audit/outbox only and does not advance the trip
  -- column here (avoids double-burn against max_broadcast_rounds).
  v_round_after := GREATEST(v_round_before, v_max_offer_round);

  v_prev_cancelled := COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[]);
  IF p_driver_id = ANY (v_prev_cancelled) THEN
    v_next_cancelled := v_prev_cancelled;
  ELSE
    v_next_cancelled := array_append(v_prev_cancelled, p_driver_id);
  END IF;

  v_prev_excluded := COALESCE(v_trip.excluded_driver_ids, '{}'::uuid[]);
  v_next_excluded := (
    SELECT COALESCE(array_agg(DISTINCT x), '{}'::uuid[])
    FROM unnest(v_prev_excluded || v_next_cancelled) AS x
  );

  SELECT ds.max_driver_find_time_minutes
    INTO v_find_minutes
  FROM public.get_dispatch_settings(v_trip.service_area_id) ds;
  v_find_minutes := COALESCE(NULLIF(v_find_minutes, 0), 3);
  v_search_expires := v_now + make_interval(mins => v_find_minutes);

  SELECT ro.id INTO v_active_offer_id
  FROM public.ride_offers ro
  WHERE ro.trip_id = p_trip_id
    AND ro.driver_id = p_driver_id
    AND ro.status IN ('pending', 'accepted', 'countered')
  ORDER BY ro.offered_at DESC NULLS LAST
  LIMIT 1;

  INSERT INTO public.driver_cancel_rematch_audit (
    trip_id, driver_id, previous_status, resulting_status, reason,
    actor, actor_mode, idempotency_key, request_metadata,
    broadcast_round_before, broadcast_round_after
  ) VALUES (
    p_trip_id, p_driver_id, v_trip.status, 'searching_new_driver',
    COALESCE(v_reason, 'driver_cancelled'),
    v_actor, v_actor_mode, v_idem, v_meta,
    v_round_before, v_round_after
  )
  RETURNING id INTO v_audit_id;

  INSERT INTO public.trip_driver_exclusions (
    trip_id, driver_id, reason, offer_id, source, audit_event_id, metadata, created_at
  ) VALUES (
    p_trip_id,
    p_driver_id,
    COALESCE(v_reason, 'driver_cancelled'),
    v_active_offer_id,
    'driver_cancel_before_start',
    v_audit_id,
    jsonb_build_object(
      'previous_status', v_trip.status,
      'actor', v_actor,
      'actor_mode', v_actor_mode,
      'idempotency_key', v_idem
    ),
    v_now
  )
  ON CONFLICT (trip_id, driver_id) DO UPDATE
  SET
    reason = EXCLUDED.reason,
    offer_id = COALESCE(EXCLUDED.offer_id, public.trip_driver_exclusions.offer_id),
    source = 'driver_cancel_before_start',
    audit_event_id = COALESCE(EXCLUDED.audit_event_id, public.trip_driver_exclusions.audit_event_id),
    metadata = COALESCE(public.trip_driver_exclusions.metadata, '{}'::jsonb) || EXCLUDED.metadata;

  UPDATE public.ride_offers
  SET
    status = 'revoked',
    revoked_reason = 'driver_cancelled_before_pickup',
    updated_at = v_now
  WHERE trip_id = p_trip_id
    AND status IN ('pending', 'accepted', 'countered');

  UPDATE public.trips
  SET
    status = 'searching_new_driver',
    dispatch_status = 'broadcasting',
    driver_id = NULL,
    confirmed_driver_id = NULL,
    current_offer_driver_id = NULL,
    current_offer_expires_at = NULL,
    negotiation_owner_driver_id = NULL,
    negotiation_status = NULL,
    negotiation_locked_until = NULL,
    accepted_ride_offer_id = NULL,
    assigned_at = NULL,
    arrived_at = NULL,
    pickup_arrived_at = NULL,
    scheduled_accepted_at = NULL,
    pickup_waiting_started_at = NULL,
    pickup_paid_waiting_started_at = NULL,
    paid_waiting_started_at = NULL,
    free_wait_expires_at = NULL,
    driver_location_lat = NULL,
    driver_location_lng = NULL,
    driver_started_journey_to_pickup_at = NULL,
    confirm_deadline_at = NULL,
    driver_confirm_deadline_at = NULL,
    commitment_time = NULL,
    previous_driver_id = p_driver_id,
    cancelled_driver_ids = v_next_cancelled,
    excluded_driver_ids = v_next_excluded,
    broadcast_enabled = true,
    cancelled_by = 'driver',
    cancel_reason = 'driver_cancelled',
    -- Leave current_broadcast_round unchanged; deployed auto-dispatch advances it.
    searching_expires_at = v_search_expires,
    updated_at = v_now
  WHERE id = p_trip_id
    AND confirmed_driver_id = p_driver_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONFLICT: trip assignment changed during rematch'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.drivers
  SET current_trip_id = NULL, updated_at = v_now
  WHERE id = p_driver_id
    AND current_trip_id = p_trip_id;

  -- Preserve customer active trip attachment:
  -- never clear; never overwrite a different active trip; attach only if null/same.
  IF v_trip.passenger_id IS NOT NULL THEN
    UPDATE public.customers
    SET
      active_trip_id = COALESCE(active_trip_id, p_trip_id),
      updated_at = v_now
    WHERE (id = v_trip.passenger_id OR user_id = v_trip.passenger_id)
      AND (active_trip_id IS NULL OR active_trip_id = p_trip_id);

    -- Proof: when customer was already on this trip (or unset), attachment must remain.
    IF v_customer_active IS NULL OR v_customer_active = p_trip_id THEN
      SELECT active_trip_id INTO v_customer_active
      FROM public.customers
      WHERE id = v_trip.passenger_id OR user_id = v_trip.passenger_id
      LIMIT 1;

      IF v_customer_active IS DISTINCT FROM p_trip_id THEN
        RAISE EXCEPTION 'CUSTOMER_ACTIVE_TRIP_CHANGED: rematch must preserve customers.active_trip_id'
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  SELECT jsonb_build_object(
    'fare', t.fare,
    'fare_amount', t.fare_amount,
    'estimated_fare', t.estimated_fare,
    'estimated_total_pence', t.estimated_total_pence,
    'gross_fare_pence', t.gross_fare_pence,
    'final_fare_pence', t.final_fare_pence,
    'final_customer_fare_pence', t.final_customer_fare_pence,
    'discount_pence', t.discount_pence,
    'voucher_discount_pence', t.voucher_discount_pence,
    'offer_discount_pence', t.offer_discount_pence,
    'payment_intent_id', t.payment_intent_id,
    'payment_status', t.payment_status,
    'payment_state', t.payment_state,
    'payment_method', t.payment_method,
    'provider_order_id', t.provider_order_id,
    'applied_offer_id', t.applied_offer_id,
    'applied_personal_voucher_id', t.applied_personal_voucher_id,
    'passenger_id', t.passenger_id
  )
  INTO v_finance_after
  FROM public.trips t
  WHERE t.id = p_trip_id;

  IF v_finance_before IS DISTINCT FROM v_finance_after THEN
    RAISE EXCEPTION 'FINANCE_MUTATION_FORBIDDEN: rematch must not alter fare/payment/voucher identity'
      USING ERRCODE = 'P0001';
  END IF;

  v_outbox_key := COALESCE(
    v_idem,
    format('driver_cancel_before_pickup:%s:%s:r%s', p_trip_id, p_driver_id, v_round_after)
  );

  INSERT INTO public.dispatch_intent_outbox (
    trip_id, intent, trigger_reason, idempotency_key, status, payload
  ) VALUES (
    p_trip_id,
    'auto_dispatch_rebroadcast',
    'driver_cancel_before_pickup',
    v_outbox_key,
    'pending',
    jsonb_build_object(
      'force_rebroadcast', true,
      'driver_id', p_driver_id,
      'audit_event_id', v_audit_id,
      'broadcast_round', v_round_after
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO public.dispatch_audit_log (trip_id, event_type, round, driver_id, details)
  VALUES (
    p_trip_id,
    'driver_cancel_before_start_rematch',
    v_round_after,
    p_driver_id,
    jsonb_build_object(
      'previous_status', v_status,
      'status', 'searching_new_driver',
      'dispatch_status', 'broadcasting',
      'actor', v_actor,
      'actor_mode', v_actor_mode,
      'audit_event_id', v_audit_id,
      'customer_active_trip_before', v_customer_active,
      'finance_unchanged', true
    )
  );

  v_result := jsonb_build_object(
    'ok', true,
    'outcome', 'rematch',
    'trip_id', p_trip_id,
    'previous_status', v_trip.status,
    'status', 'searching_new_driver',
    'dispatch_status', 'broadcasting',
    'driver_cleared', true,
    'driver_excluded', true,
    'payment_action', 'unchanged',
    'idempotent_replay', false,
    'current_broadcast_round', v_round_after,
    'searching_expires_at', v_search_expires,
    'audit_event_id', v_audit_id,
    'dispatch_outbox_key', v_outbox_key,
    'finance_unchanged', true,
    'customer_active_trip_preserved', true
  );

  IF v_idem IS NOT NULL THEN
    UPDATE public.driver_cancel_rematch_idempotency
    SET result = v_result
    WHERE idempotency_key = v_idem;
  END IF;

  RETURN v_result;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.run_digital_finance_migration()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_is_admin boolean;
  v_existing text;
  v_started_at timestamptz := now();
  v_drivers_reset int := 0;
  v_ledger_rows int := 0;
  v_payout_items_voided int := 0;
  v_payout_batches_archived int := 0;
  v_auths_cancelled int := 0;
  v_early_cashouts_cancelled int := 0;
  v_settlements_marked int := 0;
  v_currency text;
BEGIN
  -- Auth: super_admin only
  SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id = v_uid AND role = 'super_admin')
    INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'forbidden: super_admin required';
  END IF;

  -- Idempotency guard
  SELECT setting_value #>> '{}' INTO v_existing
  FROM public.admin_settings WHERE setting_key = 'finance_era';
  IF v_existing = 'digital' THEN
    RAISE EXCEPTION 'digital_finance_migration_already_applied';
  END IF;

  -- Per-driver zeroing ledger insert (offsets non-excluded ledger sum)
  WITH per_driver AS (
    SELECT driver_id,
           COALESCE(SUM(amount_pence), 0) AS balance
    FROM public.driver_wallet_ledger
    WHERE type NOT IN ('PLATFORM_COMMISSION','CASH_TRIP_EARNING')
    GROUP BY driver_id
  ),
  inserted AS (
    INSERT INTO public.driver_wallet_ledger
      (driver_id, type, amount_pence, currency, description, created_at)
    SELECT
      pd.driver_id,
      'MIGRATION_RESET',
      -pd.balance,
      COALESCE(
        (SELECT l.currency FROM public.driver_wallet_ledger l
          WHERE l.driver_id = pd.driver_id AND l.currency IS NOT NULL
          ORDER BY l.created_at DESC LIMIT 1),
        'GBP'
      ),
      'Digital Finance Migration – Operational reset for transition to 100% digital payments.',
      v_started_at
    FROM per_driver pd
    WHERE pd.balance <> 0
    RETURNING driver_id
  )
  SELECT COUNT(*) INTO v_ledger_rows FROM inserted;
  v_drivers_reset := v_ledger_rows;

  -- Void orphaned payout items (no Stripe transfer)
  UPDATE public.payout_items
     SET status = 'INVALID_ORPHANED',
         updated_at = now(),
         error_message = COALESCE(error_message,'') || ' [digital_finance_migration]'
   WHERE status IN ('pending','processing','CREATED','READY','BLOCKED')
     AND (provider_transfer_id IS NULL OR provider_transfer_id = '');
  GET DIAGNOSTICS v_payout_items_voided = ROW_COUNT;

  -- Archive open batches with no successful children
  UPDATE public.payout_batches
     SET status = 'INVALID_ORPHANED',
         updated_at = now(),
         notes = COALESCE(notes,'') || ' [digital_finance_migration]'
   WHERE status IN ('pending','processing','CREATED','READY','BLOCKED')
     AND NOT EXISTS (
       SELECT 1 FROM public.payout_items pi
       WHERE pi.batch_id = payout_batches.id
         AND pi.provider_transfer_id IS NOT NULL AND pi.provider_transfer_id <> ''
     );
  GET DIAGNOSTICS v_payout_batches_archived = ROW_COUNT;

  -- Cancel pending authorizations
  UPDATE public.payout_authorization
     SET status = 'cancelled',
         invalidated_at = now(),
         invalidation_reason = 'digital_finance_migration',
         updated_at = now()
   WHERE status IN ('pending','executing','failed_retryable');
  GET DIAGNOSTICS v_auths_cancelled = ROW_COUNT;

  -- Fail-close pending early cashouts
  UPDATE public.driver_early_cashouts
     SET status = 'failed',
         failure_reason = 'digital_finance_migration',
         failed_at = now(),
         updated_at = now()
   WHERE status IN ('pending','processing');
  GET DIAGNOSTICS v_early_cashouts_cancelled = ROW_COUNT;

  -- Mark unallocated settlements ineligible (respects existing check constraint)
  UPDATE public.driver_earning_settlement
     SET eligible_for_payout = false,
         ineligible_reason = 'digital_finance_migration',
         updated_at = now()
   WHERE COALESCE(allocated_to_payout,false) = false
     AND settlement_status <> 'settled'
     AND (eligible_for_payout IS DISTINCT FROM false OR ineligible_reason IS DISTINCT FROM 'digital_finance_migration');
  GET DIAGNOSTICS v_settlements_marked = ROW_COUNT;

  -- Persist era marker
  INSERT INTO public.admin_settings (setting_key, setting_value, description)
  VALUES ('finance_era', to_jsonb('digital'::text), 'Active finance era')
  ON CONFLICT (setting_key) DO UPDATE
    SET setting_value = EXCLUDED.setting_value, updated_at = now();

  INSERT INTO public.admin_settings (setting_key, setting_value, description)
  VALUES ('finance_era_started_at', to_jsonb(v_started_at), 'Digital finance era start timestamp')
  ON CONFLICT (setting_key) DO UPDATE
    SET setting_value = EXCLUDED.setting_value, updated_at = now();

  RETURN jsonb_build_object(
    'ok', true,
    'started_at', v_started_at,
    'drivers_reset', v_drivers_reset,
    'ledger_rows_inserted', v_ledger_rows,
    'payout_items_voided', v_payout_items_voided,
    'payout_batches_archived', v_payout_batches_archived,
    'payout_authorizations_cancelled', v_auths_cancelled,
    'early_cashouts_cancelled', v_early_cashouts_cancelled,
    'settlements_marked_ineligible', v_settlements_marked
  );
END;
$function$

;

CREATE OR REPLACE FUNCTION public.capture_expired_tip_windows_sweep_has_work()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.trips t
    WHERE t.status = 'completed'
      AND t.provider_order_id IS NOT NULL
      AND t.tip_window_expires_at IS NOT NULL
      AND t.tip_window_expires_at < now()
      AND t.payment_status IN (
        'preauth_created',
        'preauth_authorized',
        'authorized',
        'preauth_updated',
        'capture_requested',
        'capture_failed'
      )
    LIMIT 1
  );
$function$

;
CREATE OR REPLACE FUNCTION public.ops_detect_payment_gaps()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count int := 0; rec record;
BEGIN
  FOR rec IN
    SELECT t.id as trip_id FROM trips t
    LEFT JOIN trip_finance tf ON tf.trip_id = t.id
    WHERE t.status = 'completed' AND t.updated_at >= now() - interval '24 hours'
      AND (tf.id IS NULL OR tf.payment_status = 'failed' OR tf.provider_order_id IS NULL)
    LIMIT 50
  LOOP
    PERFORM ops_upsert_alert('payment_gap:' || rec.trip_id, 'payment', 'critical', 'detection', 'backend',
      'Payment gap for completed trip', 'Trip ' || rec.trip_id || ' completed but no successful payment.',
      jsonb_build_object('trip_id', rec.trip_id));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('payment_gaps', v_count);
EXCEPTION WHEN undefined_table THEN RETURN jsonb_build_object('payment_gaps', 0, 'note', 'table not found');
END; $function$

;
CREATE OR REPLACE FUNCTION public.ops_detect_repeated_webhooks()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT p.provider_payment_id, count(*) as dup_count,
           array_agg(p.id) as payment_ids
    FROM public.payments p
    WHERE p.provider_payment_id IS NOT NULL
      AND p.created_at > now() - interval '24 hours'
    GROUP BY p.provider_payment_id
    HAVING count(*) > 1
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.ops_alerts oa
      WHERE oa.fingerprint = 'dup_webhook:' || r.provider_payment_id
        AND oa.status IN ('open', 'acknowledged')
    ) THEN
      PERFORM public.ops_upsert_alert(
        'dup_webhook:' || r.provider_payment_id,
        'duplication', 'warning', 'system', 'backend',
        'Repeated Webhook Processing',
        'Payment intent ' || r.provider_payment_id || ' processed ' || r.dup_count || ' times',
        NULL, NULL, (r.payment_ids)[1], NULL, 'provider_pi', r.provider_payment_id,
        jsonb_build_object('provider_pi', r.provider_payment_id, 'dup_count', r.dup_count)
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$function$

;
COMMIT;