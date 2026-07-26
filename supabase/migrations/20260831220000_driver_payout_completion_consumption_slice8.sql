-- P0 Slice 8: Revolut COMPLETED → consume ACTIVE reservation + permanent wallet debit.
-- Atomic SECURITY DEFINER RPC. Only canonical provider_state = 'completed' may finalise.
-- LIVE_PAYOUT_EXECUTION_ENABLED stays false (no automatic Tuesday execution).
-- Idempotent on provider_payment_id / financial_application uniqueness.

BEGIN;

-- ---------------------------------------------------------------------------
-- Batch kind → WEEKLY_PAYOUT for WEEKLY_SCHEDULED (Slice 5)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payout_batch_kind_to_ledger_type(p_kind text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_kind = 'EARLY_CASHOUT' THEN 'EARLY_CASHOUT'
    WHEN p_kind IN ('WEEKLY_MONDAY', 'WEEKLY_SCHEDULED', 'WEEKLY', 'WEEKLY_PAYOUT')
      THEN 'WEEKLY_PAYOUT'
    WHEN p_kind IN ('MANUAL_ADMIN', 'MANUAL') THEN 'MANUAL_PAYOUT'
    ELSE 'WEEKLY_PAYOUT'
  END;
$$;

-- ---------------------------------------------------------------------------
-- Financial application evidence columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.driver_payout_payment_intents
  ADD COLUMN IF NOT EXISTS financially_applied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS financial_application_ledger_entry_id UUID,
  ADD COLUMN IF NOT EXISTS completion_evidence_redacted JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.driver_payout_payment_intents.financially_applied_at IS
  'Slice 8: set when reservation consumed + wallet debit applied in same TX.';
COMMENT ON COLUMN public.driver_payout_payment_intents.financial_application_ledger_entry_id IS
  'Slice 8: immutable WEEKLY_PAYOUT (or mapped) debit ledger row id.';

ALTER TABLE public.driver_payout_reservations
  ADD COLUMN IF NOT EXISTS debit_ledger_entry_id UUID,
  ADD COLUMN IF NOT EXISTS provider_payment_id TEXT,
  ADD COLUMN IF NOT EXISTS completion_idempotency_key TEXT;

COMMENT ON COLUMN public.driver_payout_reservations.debit_ledger_entry_id IS
  'Slice 8: permanent debit ledger entry that consumed this reservation.';
COMMENT ON COLUMN public.driver_payout_reservations.provider_payment_id IS
  'Slice 8: Revolut transaction/payment id at consumption time.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_payout_intents_financial_apply_once
  ON public.driver_payout_payment_intents (id)
  WHERE financially_applied_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_payout_intents_provider_payment_applied
  ON public.driver_payout_payment_intents (provider_payment_id)
  WHERE financially_applied_at IS NOT NULL
    AND provider_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_payout_reservations_completion_idem
  ON public.driver_payout_reservations (completion_idempotency_key)
  WHERE completion_idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Atomic finalisation: COMPLETED → CONSUMED + debit exactly once
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_driver_payout_completion(
  p_payout_item_id UUID,
  p_provider_payment_id TEXT,
  p_provider_state TEXT,
  p_provider_completed_at TIMESTAMPTZ DEFAULT NULL,
  p_evidence_redacted JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Idempotent debit by Revolut payment id (stored in stripe_payout_id column).
  SELECT id INTO v_existing_ledger
  FROM public.driver_wallet_ledger
  WHERE stripe_payout_id = v_pay_id
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
      stripe_payout_id,
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
$$;

REVOKE ALL ON FUNCTION public.finalize_driver_payout_completion(
  UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_driver_payout_completion(
  UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB
) TO service_role;

COMMENT ON FUNCTION public.finalize_driver_payout_completion(UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB) IS
  'Slice 8: atomic COMPLETED finalisation — consume ACTIVE reservation + insert WEEKLY_PAYOUT debit once. Rejects non-completed provider states.';

COMMIT;
