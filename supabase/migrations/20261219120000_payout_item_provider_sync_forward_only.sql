-- FINAL PREP ONLY. Do not apply / deploy without explicit approval.
-- Timestamp AFTER production tip 20261218120000.
--
-- Scope (minimised): CREATE OR REPLACE public.finalize_driver_payout_completion
-- only — forward-only payout_items.provider_* sync on successful completion.
-- Body is the live production definition plus the provider sync CASE expressions.
-- Preserves fee_ledger / gross-net return fields and existing financial guards.
--
-- Intentionally does NOT touch driver_wallet_resolve_economic_date
-- (production already has the CAPTURED residual-buffer resolver).
--
-- Does NOT: write wallet ledger rows, backfill historical payout_items, call
-- Revolut, alter MK-260923-017, or reverse financial state.

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
  v_fee_ledger_id UUID;
  v_existing_ledger UUID;
  v_existing_fee UUID;
  v_debit INTEGER;
  v_fee INTEGER := 0;
  v_net INTEGER;
  v_idem TEXT;
  v_desc TEXT;
  v_completed_at TIMESTAMPTZ;
  v_snap jsonb;
  v_alloc_count integer;
  v_alloc_sum integer;
  v_item_status text;
BEGIN
  IF v_state IS DISTINCT FROM 'completed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PROVIDER_NOT_COMPLETED',
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  IF v_pay_id = '' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'MISSING_PROVIDER_PAYMENT_ID',
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  SELECT * INTO v_item
  FROM public.payout_items
  WHERE id = p_payout_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_ITEM_NOT_FOUND');
  END IF;

  v_item_status := lower(btrim(COALESCE(v_item.status, '')));
  IF v_item_status IN ('cancelled', 'released', 'ineligible', 'failed_permanent') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PAYOUT_ITEM_NOT_ELIGIBLE',
      'message', format('item status %s cannot complete', v_item.status)
    );
  END IF;

  -- Lineage + allocation sum + PLATFORM_COLLECTED ledger types (raises on violation).
  BEGIN
    PERFORM public.assert_payout_item_ledger_lineage(p_payout_item_id);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PAYOUT_LINEAGE_VALIDATION_FAILED',
      'message', SQLERRM
    );
  END;

  SELECT count(*), coalesce(sum(a.amount_pence), 0)
    INTO v_alloc_count, v_alloc_sum
  FROM public.payout_item_ledger_allocations a
  WHERE a.payout_item_id = p_payout_item_id;

  IF v_alloc_count < 1 OR v_alloc_sum IS DISTINCT FROM v_item.amount_pence THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PAYOUT_LINEAGE_MISMATCH',
      'message', format('allocation sum %s != item %s', v_alloc_sum, v_item.amount_pence)
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
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  SELECT * INTO v_intent
  FROM public.driver_payout_payment_intents
  WHERE id = v_intent_id
  FOR UPDATE;

  IF v_intent.provider_payment_id IS NOT NULL
     AND v_intent.provider_payment_id IS DISTINCT FROM v_pay_id
     AND v_intent.financially_applied_at IS NULL
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PROVIDER_PAYMENT_ID_MISMATCH',
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

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
      'wallet_debited', false,
      'reservation_consumed', false
    );
  END IF;

  SELECT * INTO v_res
  FROM public.driver_payout_reservations
  WHERE id = v_res_id
  FOR UPDATE;

  IF v_intent.financially_applied_at IS NOT NULL AND v_res.status = 'CONSUMED' THEN
    IF v_intent.provider_payment_id IS DISTINCT FROM v_pay_id THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'PROVIDER_PAYMENT_ID_MISMATCH'
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'already_applied', true,
      'idempotent', true,
      'ledger_entry_id', v_intent.financial_application_ledger_entry_id,
      'wallet_debited', true,
      'reservation_consumed', true
    );
  END IF;

  IF v_res.driver_id IS DISTINCT FROM v_item.driver_id
     OR v_intent.driver_id IS DISTINCT FROM v_item.driver_id
  THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DRIVER_MISMATCH');
  END IF;

  IF v_res.amount_pence IS DISTINCT FROM v_item.amount_pence THEN
    RETURN jsonb_build_object('ok', false, 'error', 'AMOUNT_MISMATCH');
  END IF;

  IF COALESCE(v_batch.kind, '') = 'EARLY_CASHOUT' THEN
    IF v_intent.amount_pence IS DISTINCT FROM v_item.amount_pence
       AND v_intent.amount_pence IS DISTINCT FROM COALESCE(v_item.net_driver_payout_pence, v_item.amount_pence)
    THEN
      RETURN jsonb_build_object('ok', false, 'error', 'AMOUNT_MISMATCH');
    END IF;
  ELSIF v_intent.amount_pence IS DISTINCT FROM v_item.amount_pence THEN
    RETURN jsonb_build_object('ok', false, 'error', 'AMOUNT_MISMATCH');
  END IF;

  IF v_res.status NOT IN ('ACTIVE', 'CONSUMED') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'RESERVATION_NOT_ACTIVE');
  END IF;

  v_ledger_type := public.payout_batch_kind_to_ledger_type(COALESCE(v_batch.kind, 'WEEKLY_SCHEDULED'));
  v_snap := COALESCE(v_item.eligibility_snapshot, '{}'::jsonb);

  IF COALESCE(v_batch.kind, '') = 'EARLY_CASHOUT' THEN
    v_fee := GREATEST(0, COALESCE(NULLIF(v_snap->>'withdrawal_fee_pence', '')::integer, 0));
    v_net := COALESCE(v_item.net_driver_payout_pence, v_item.amount_pence - v_fee);
    -- Wallet consumes the gross; Revolut receives the net; ONECAB keeps the fee.
    IF v_net <= 0 OR (v_net + v_fee) IS DISTINCT FROM v_item.amount_pence THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'FEE_AMOUNT_MISMATCH',
        'message', format('gross %s != net %s + fee %s', v_item.amount_pence, v_net, v_fee),
        'wallet_debited', false,
        'reservation_consumed', false
      );
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
    AND driver_id = v_item.driver_id
    AND type IN ('WEEKLY_PAYOUT', 'PAYOUT', 'MANUAL_PAYOUT', 'EARLY_CASHOUT')
    AND amount_pence < 0
  LIMIT 1;

  IF v_existing_ledger IS NOT NULL AND v_res.status = 'CONSUMED' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_applied', true,
      'idempotent', true,
      'ledger_entry_id', v_existing_ledger,
      'wallet_debited', true,
      'reservation_consumed', true
    );
  END IF;

  IF v_existing_ledger IS NULL THEN
    INSERT INTO public.driver_wallet_ledger (
      driver_id, type, amount_pence, currency, description, provider_payout_id, created_at
    ) VALUES (
      v_item.driver_id, v_ledger_type, v_debit, 'GBP', v_desc, v_pay_id, v_completed_at
    )
    RETURNING id INTO v_ledger_id;
  ELSE
    v_ledger_id := v_existing_ledger;
  END IF;

  IF v_fee > 0 THEN
    SELECT id INTO v_existing_fee
    FROM public.driver_wallet_ledger
    WHERE driver_id = v_item.driver_id
      AND provider_payout_id = v_pay_id
      AND type = 'CASHOUT_FEE'
    LIMIT 1;

    IF v_existing_fee IS NULL THEN
      INSERT INTO public.driver_wallet_ledger (
        driver_id, type, amount_pence, currency, description, provider_payout_id, created_at, metadata
      ) VALUES (
        v_item.driver_id,
        'CASHOUT_FEE',
        -ABS(v_fee),
        'GBP',
        format('Early cash-out fee (ONECAB revenue) item=%s payment=%s', p_payout_item_id, v_pay_id),
        v_pay_id,
        v_completed_at,
        jsonb_build_object(
          'payout_item_id', p_payout_item_id,
          'revenue_class', 'ONECAB_EARLY_CASHOUT_FEE',
          'gross_wallet_consumed_pence', v_item.amount_pence,
          'net_transfer_pence', v_net,
          'fee_pence', v_fee
        )
      )
      RETURNING id INTO v_fee_ledger_id;
    ELSE
      v_fee_ledger_id := v_existing_fee;
    END IF;
  END IF;

  IF v_res.status = 'ACTIVE' THEN
    UPDATE public.driver_payout_reservations
    SET status = 'CONSUMED', consumed_at = COALESCE(consumed_at, v_now),
        debit_ledger_entry_id = v_ledger_id, provider_payment_id = v_pay_id,
        completion_idempotency_key = v_idem, updated_at = v_now
    WHERE id = v_res.id;
  END IF;

  UPDATE public.driver_payout_payment_intents
  SET execution_status = 'COMPLETED', provider_payment_id = v_pay_id,
      provider_state = 'completed', provider_completed_at = COALESCE(provider_completed_at, v_completed_at),
      financially_applied_at = COALESCE(financially_applied_at, v_now),
      financial_application_ledger_entry_id = v_ledger_id,
      completion_evidence_redacted = COALESCE(p_evidence_redacted, '{}'::jsonb),
      updated_at = v_now
  WHERE id = v_intent.id;

  UPDATE public.payout_items
  SET status = 'COMPLETED',
      execution_status = 'COMPLETED',
      ledger_entry_id = COALESCE(ledger_entry_id, v_ledger_id),
      completed_at = COALESCE(completed_at, v_now),
      -- Forward-only provider evidence sync from the same values written on the intent.
      -- Never overwrite a different provider id or a terminal failure already on the item.
      provider_payout_id = CASE
        WHEN provider_payout_id IS NULL OR btrim(provider_payout_id) = '' THEN v_pay_id
        WHEN provider_payout_id = v_pay_id THEN provider_payout_id
        ELSE provider_payout_id
      END,
      provider_status = CASE
        WHEN provider_status IS NULL OR btrim(provider_status) = '' THEN lower(btrim(COALESCE(p_provider_state, '')))
        WHEN lower(btrim(provider_status)) IN ('failed','declined','cancelled','canceled','reversed','reverted','error')
          THEN provider_status
        WHEN provider_payout_id IS NOT NULL AND provider_payout_id IS DISTINCT FROM v_pay_id
          THEN provider_status
        ELSE lower(btrim(COALESCE(p_provider_state, '')))
      END,
      updated_at = v_now
  WHERE id = p_payout_item_id;

  PERFORM public.recalculate_driver_wallet(v_item.driver_id);

  RETURN jsonb_build_object(
    'ok', true,
    'wallet_debited', true,
    'reservation_consumed', true,
    'ledger_entry_id', v_ledger_id,
    'fee_ledger_entry_id', v_fee_ledger_id,
    'gross_wallet_consumed_pence', v_item.amount_pence,
    'net_transfer_pence', v_net,
    'fee_pence', v_fee,
    'idempotent', v_existing_ledger IS NOT NULL
  );
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_driver_payout_completion(uuid, text, text, timestamp with time zone, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_driver_payout_completion(uuid, text, text, timestamp with time zone, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_driver_payout_completion(uuid, text, text, timestamp with time zone, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_driver_payout_completion(uuid, text, text, timestamp with time zone, jsonb) TO service_role;

