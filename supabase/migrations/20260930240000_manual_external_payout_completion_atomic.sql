-- Phase 0c — hardened manual external payout RPC (local migration; not deployed).

BEGIN;

CREATE OR REPLACE FUNCTION public.finalize_manual_external_payout_completion(
  p_payout_item_id uuid,
  p_external_reference text,
  p_driver_id uuid,
  p_amount_pence integer,
  p_completed_at timestamptz DEFAULT now(),
  p_admin_user_id uuid DEFAULT NULL,
  p_operator_reason text DEFAULT NULL,
  p_evidence jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_item public.payout_items%ROWTYPE;
  v_batch public.payout_batches%ROWTYPE;
  v_ref text := btrim(COALESCE(p_external_reference, ''));
  v_reason text := btrim(COALESCE(p_operator_reason, ''));
  v_amount integer := ABS(COALESCE(p_amount_pence, 0));
  v_now timestamptz := now();
  v_ledger_id uuid;
  v_existing uuid;
  v_idem text;
  v_ledger_type text;
  v_alloc_count integer;
  v_alloc_sum integer;
BEGIN
  IF v_ref = '' OR length(v_ref) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'MISSING_EXTERNAL_REFERENCE');
  END IF;
  IF v_reason = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'MISSING_OPERATOR_REASON');
  END IF;
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT');
  END IF;
  IF p_completed_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'MISSING_COMPLETION_TIMESTAMP');
  END IF;

  SELECT id INTO v_existing
  FROM public.driver_wallet_ledger
  WHERE provider_payout_id = v_ref
    AND driver_id = p_driver_id
    AND type IN ('WEEKLY_PAYOUT', 'PAYOUT', 'MANUAL_PAYOUT', 'EARLY_CASHOUT')
    AND amount_pence = -v_amount
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true, 'already_applied', true, 'idempotent', true,
      'ledger_entry_id', v_existing, 'wallet_debited', true
    );
  END IF;

  SELECT * INTO v_item FROM public.payout_items WHERE id = p_payout_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_ITEM_NOT_FOUND');
  END IF;

  IF v_item.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DRIVER_MISMATCH');
  END IF;

  IF COALESCE(v_item.net_driver_payout_pence, v_item.amount_pence) IS DISTINCT FROM v_amount THEN
    RETURN jsonb_build_object('ok', false, 'error', 'AMOUNT_MISMATCH');
  END IF;

  IF upper(COALESCE(v_item.currency, 'GBP')) <> 'GBP' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CURRENCY_MISMATCH');
  END IF;

  IF lower(COALESCE(v_item.status, '')) IN ('completed', 'ledger_sync_failed')
     AND v_item.ledger_entry_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true, 'already_applied', true,
      'ledger_entry_id', v_item.ledger_entry_id, 'wallet_debited', true
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payout_items
    WHERE provider_reference = v_ref AND driver_id IS DISTINCT FROM p_driver_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CROSS_DRIVER_REFERENCE_REUSE');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.payout_items
    WHERE provider_reference = v_ref AND id <> p_payout_item_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_EXTERNAL_REFERENCE');
  END IF;

  BEGIN
    PERFORM public.assert_payout_item_ledger_lineage(p_payout_item_id);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_LINEAGE_VALIDATION_FAILED', 'message', SQLERRM);
  END;

  SELECT count(*), coalesce(sum(a.amount_pence), 0)
    INTO v_alloc_count, v_alloc_sum
  FROM public.payout_item_ledger_allocations a
  WHERE a.payout_item_id = p_payout_item_id;

  IF v_alloc_count < 1 OR v_alloc_sum IS DISTINCT FROM v_amount THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_LINEAGE_MISMATCH');
  END IF;

  SELECT * INTO v_batch FROM public.payout_batches WHERE id = v_item.batch_id;
  v_ledger_type := public.payout_batch_kind_to_ledger_type(COALESCE(v_batch.kind, 'MANUAL_ADMIN'));
  v_idem := 'manual-external-payout:' || v_ref || ':' || p_driver_id::text || ':' || v_amount::text;

  INSERT INTO public.driver_wallet_ledger (
    driver_id, type, amount_pence, currency, description, provider_payout_id, created_at
  ) VALUES (
    p_driver_id, v_ledger_type, -v_amount,
    upper(COALESCE(v_item.currency, 'GBP')),
    format('Manual external payout item=%s ref=%s reason=%s', p_payout_item_id, v_ref, v_reason),
    v_ref, COALESCE(p_completed_at, v_now)
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_ledger_id;

  IF v_ledger_id IS NULL THEN
    SELECT id INTO v_ledger_id
    FROM public.driver_wallet_ledger
    WHERE provider_payout_id = v_ref AND driver_id = p_driver_id AND amount_pence = -v_amount
    LIMIT 1;
  END IF;

  PERFORM public.recalculate_driver_wallet(p_driver_id);

  UPDATE public.payout_items SET
    status = 'completed', provider_reference = v_ref, provider_payout_id = v_ref,
    ledger_entry_id = v_ledger_id, completed_at = COALESCE(p_completed_at, v_now),
    wallet_recalculated_at = v_now, ledger_sync_error = NULL, error_message = NULL, updated_at = v_now
  WHERE id = p_payout_item_id;

  INSERT INTO public.admin_payment_audit (action, provider, provider_payment_id, metadata)
  VALUES (
    'manual_external_payout_completion', 'manual_bank', v_ref,
    COALESCE(p_evidence, '{}'::jsonb) || jsonb_build_object(
      'payout_item_id', p_payout_item_id, 'driver_id', p_driver_id,
      'amount_pence', v_amount, 'admin_user_id', p_admin_user_id,
      'operator_reason', v_reason, 'ledger_entry_id', v_ledger_id, 'idempotency_key', v_idem
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'wallet_debited', true, 'ledger_entry_id', v_ledger_id,
    'payout_item_id', p_payout_item_id, 'external_reference', v_ref, 'amount_pence', v_amount
  );
EXCEPTION WHEN OTHERS THEN
  RAISE;
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_manual_external_payout_completion(uuid, text, uuid, integer, timestamptz, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_manual_external_payout_completion(uuid, text, uuid, integer, timestamptz, uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_manual_external_payout_completion(uuid, text, uuid, integer, timestamptz, uuid, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_manual_external_payout_completion(uuid, text, uuid, integer, timestamptz, uuid, text, jsonb) TO service_role;

COMMIT;
