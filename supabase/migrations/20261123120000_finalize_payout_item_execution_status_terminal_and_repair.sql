-- Forward: terminalize payout_items.execution_status on finalize + repair two
-- MK0006 COMPLETED early-cashout rows stuck at execution_status=SUBMITTED.
-- Root cause: 20260901130000_payout_rpc_invariant_hardening dropped
-- execution_status = COMPLETED from the payout_items UPDATE while still setting
-- status = COMPLETED (intent row was terminalized correctly).
-- PREPARED FOR EXPLICIT APPROVAL — do not apply without release sign-off.
-- Does not call Revolut, does not create reservations, does not write wallet ledger.

BEGIN;

-- 1) Future writer: finalize must set execution_status atomically with status.
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
  v_live BIGINT;
  v_reserved BIGINT;
  v_avail BIGINT;
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
      completed_at = COALESCE(completed_at, v_now), updated_at = v_now
  WHERE id = p_payout_item_id;

  PERFORM public.recalculate_driver_wallet(v_item.driver_id);

  RETURN jsonb_build_object(
    'ok', true,
    'wallet_debited', true,
    'reservation_consumed', true,
    'ledger_entry_id', v_ledger_id,
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

-- 2) Idempotent, fail-closed repair for the two proven historical item IDs only.
CREATE OR REPLACE FUNCTION public.repair_stale_completed_payout_item_execution_status(
  p_payout_item_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_item public.payout_items%ROWTYPE;
  v_res public.driver_payout_reservations%ROWTYPE;
  v_intent public.driver_payout_payment_intents%ROWTYPE;
  v_debit_n integer := 0;
  v_active_res_n integer := 0;
  v_unresolved_intent_n integer := 0;
  v_updated integer := 0;
BEGIN
  IF p_payout_item_id IS NULL THEN
    RAISE EXCEPTION 'p_payout_item_id required' USING ERRCODE = '22023';
  END IF;

  -- Narrow allow-list only (MK0006 historical COMPLETED+SUBMITTED early cash-outs).
  IF p_payout_item_id NOT IN (
    '5f00ba74-9592-4438-9e42-a9ae9a368c6a'::uuid,
    '0e237504-4d22-4ce4-a93d-ee2c2bdce004'::uuid
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'ITEM_NOT_IN_REPAIR_ALLOWLIST',
      'payout_item_id', p_payout_item_id
    );
  END IF;

  SELECT * INTO v_item
  FROM public.payout_items
  WHERE id = p_payout_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error_code', 'PAYOUT_ITEM_NOT_FOUND');
  END IF;

  -- Already repaired → idempotent no-op.
  IF upper(coalesce(v_item.status, '')) = 'COMPLETED'
     AND upper(coalesce(v_item.execution_status, '')) = 'COMPLETED' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'changed', false,
      'payout_item_id', p_payout_item_id,
      'reason', 'ALREADY_TERMINAL'
    );
  END IF;

  IF upper(coalesce(v_item.status, '')) IS DISTINCT FROM 'COMPLETED'
     OR upper(coalesce(v_item.execution_status, '')) IS DISTINCT FROM 'SUBMITTED' THEN
    RAISE EXCEPTION 'repair precondition failed: unexpected item state status=% execution_status=%',
      v_item.status, v_item.execution_status
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_res
  FROM public.driver_payout_reservations
  WHERE payout_item_id = p_payout_item_id
  ORDER BY CASE WHEN status = 'CONSUMED' THEN 0 ELSE 1 END, created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND OR upper(coalesce(v_res.status, '')) IS DISTINCT FROM 'CONSUMED' THEN
    RAISE EXCEPTION 'repair precondition failed: reservation not CONSUMED for %', p_payout_item_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_intent
  FROM public.driver_payout_payment_intents
  WHERE payout_item_id = p_payout_item_id
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND
     OR upper(coalesce(v_intent.execution_status, '')) IS DISTINCT FROM 'COMPLETED'
     OR lower(coalesce(v_intent.provider_state, '')) IS DISTINCT FROM 'completed'
     OR v_intent.provider_payment_id IS NULL
     OR v_intent.financially_applied_at IS NULL THEN
    RAISE EXCEPTION 'repair precondition failed: provider intent not fully completed for %', p_payout_item_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_debit_n
  FROM public.driver_wallet_ledger l
  WHERE l.id = v_item.ledger_entry_id
     OR l.id = v_res.debit_ledger_entry_id
     OR l.id = v_intent.financial_application_ledger_entry_id;

  -- Distinct debit identity must resolve to exactly one EARLY_CASHOUT (or WEEKLY) debit row.
  SELECT count(DISTINCT l.id) INTO v_debit_n
  FROM public.driver_wallet_ledger l
  WHERE l.id IN (
    v_item.ledger_entry_id,
    v_res.debit_ledger_entry_id,
    v_intent.financial_application_ledger_entry_id
  )
  AND l.amount_pence < 0
  AND upper(l.type) IN ('EARLY_CASHOUT', 'WEEKLY_PAYOUT');

  IF v_debit_n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'repair precondition failed: wallet debit count=% for %', v_debit_n, p_payout_item_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_active_res_n
  FROM public.driver_payout_reservations
  WHERE payout_item_id = p_payout_item_id AND status = 'ACTIVE';

  IF v_active_res_n > 0 THEN
    RAISE EXCEPTION 'repair precondition failed: ACTIVE reservation exists for %', p_payout_item_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_unresolved_intent_n
  FROM public.driver_payout_payment_intents
  WHERE payout_item_id = p_payout_item_id
    AND upper(coalesce(execution_status, '')) IN (
      'SUBMITTED', 'SUBMITTING', 'UNKNOWN', 'PROCESSING', 'READY', 'VALIDATED', 'DRAFT'
    );

  IF v_unresolved_intent_n > 0 THEN
    RAISE EXCEPTION 'repair precondition failed: unresolved provider intent for %', p_payout_item_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.payout_items
  SET execution_status = 'COMPLETED',
      updated_at = now()
  WHERE id = p_payout_item_id
    AND upper(status) = 'COMPLETED'
    AND upper(coalesce(execution_status, '')) = 'SUBMITTED';

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'repair failed: item state changed during repair for %', p_payout_item_id
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.payout_audit_log (
    driver_id,
    payout_type,
    event_type,
    requested_amount_pence,
    metadata
  ) VALUES (
    v_item.driver_id,
    coalesce(v_item.payout_type, 'EARLY_CASHOUT'),
    'STALE_EXECUTION_STATUS_REPAIRED',
    v_item.amount_pence,
    jsonb_build_object(
      'payout_item_id', p_payout_item_id,
      'batch_id', v_item.batch_id,
      'from_execution_status', 'SUBMITTED',
      'to_execution_status', 'COMPLETED',
      'reservation_id', v_res.id,
      'intent_id', v_intent.id,
      'provider_payment_id', v_intent.provider_payment_id,
      'ledger_entry_id', v_item.ledger_entry_id,
      'mechanism', 'repair_stale_completed_payout_item_execution_status',
      'migration', '20261123120000_finalize_payout_item_execution_status_terminal_and_repair'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'changed', true,
    'payout_item_id', p_payout_item_id,
    'execution_status', 'COMPLETED'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.repair_stale_completed_payout_item_execution_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.repair_stale_completed_payout_item_execution_status(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.repair_stale_completed_payout_item_execution_status(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.repair_stale_completed_payout_item_execution_status(uuid) TO service_role;

-- Apply repair for the two proven IDs (fail closed if preconditions drift).
DO $$
DECLARE
  r jsonb;
BEGIN
  r := public.repair_stale_completed_payout_item_execution_status(
    '5f00ba74-9592-4438-9e42-a9ae9a368c6a'::uuid
  );
  IF coalesce(r->>'ok', 'false') <> 'true' THEN
    RAISE EXCEPTION 'repair failed for 5f00ba74: %', r;
  END IF;

  r := public.repair_stale_completed_payout_item_execution_status(
    '0e237504-4d22-4ce4-a93d-ee2c2bdce004'::uuid
  );
  IF coalesce(r->>'ok', 'false') <> 'true' THEN
    RAISE EXCEPTION 'repair failed for 0e237504: %', r;
  END IF;
END $$;

COMMIT;
