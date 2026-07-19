-- Slice 7 hotfix: Revolut POST /pay request_id max length is 40.
-- Legacy revolut-driver-payout:{uuid} was 58 chars and was hard-rejected.
-- Canonical format: oc-dp: + lowercase uuid hex without dashes (38 chars).

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_driver_payout_submission(
  p_payout_item_id UUID,
  p_source_account_id TEXT,
  p_claim_token UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.payout_items%ROWTYPE;
  v_res public.driver_payout_reservations%ROWTYPE;
  v_dest public.driver_payout_destinations%ROWTYPE;
  v_intent public.driver_payout_payment_intents%ROWTYPE;
  v_token UUID := COALESCE(p_claim_token, gen_random_uuid());
  v_provider_request_id TEXT;
  v_idempotency_key TEXT;
  v_fingerprint TEXT;
  v_now TIMESTAMPTZ := now();
  v_link_ok BOOLEAN;
BEGIN
  IF p_payout_item_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'MISSING_FIELD', 'message', 'payout_item_id required');
  END IF;
  IF p_source_account_id IS NULL OR btrim(p_source_account_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'MISSING_SOURCE_ACCOUNT', 'message', 'source_account_id required');
  END IF;

  SELECT * INTO v_item
  FROM public.payout_items
  WHERE id = p_payout_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_ITEM_NOT_RESERVED', 'message', 'item not found');
  END IF;

  IF upper(v_item.status) = 'SUBMITTED' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_SUBMITTED', 'message', 'item already submitted');
  END IF;
  IF upper(v_item.status) = 'SUBMITTING' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'SUBMISSION_IN_FLIGHT', 'message', 'item submission in flight');
  END IF;
  IF upper(v_item.status) = 'UNKNOWN' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_NO_BLIND_RETRY', 'message', 'prior UNKNOWN — no blind retry');
  END IF;
  IF upper(v_item.status) <> 'RESERVED' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PAYOUT_ITEM_NOT_RESERVED',
      'message', format('item status %s is not RESERVED', v_item.status)
    );
  END IF;

  SELECT * INTO v_res
  FROM public.driver_payout_reservations
  WHERE payout_item_id = p_payout_item_id
    AND status = 'ACTIVE'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'RESERVATION_NOT_ACTIVE', 'message', 'ACTIVE reservation required');
  END IF;

  IF v_res.amount_pence <> v_item.amount_pence THEN
    RETURN jsonb_build_object('ok', false, 'error', 'AMOUNT_MISMATCH', 'message', 'reservation/item amount mismatch');
  END IF;

  SELECT * INTO v_dest
  FROM public.driver_payout_destinations
  WHERE id = v_item.payout_destination_id
  FOR SHARE;

  IF NOT FOUND OR v_dest.is_active IS FALSE OR v_dest.archived_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'DESTINATION_NOT_ACTIVE', 'message', 'destination inactive');
  END IF;

  v_link_ok := (
    upper(COALESCE(v_dest.provider_link_status, '')) = 'PROVIDER_VERIFIED'
    OR (
      upper(COALESCE(v_dest.verification_status, '')) IN ('PROVIDER_VERIFIED', 'MANUAL_VERIFIED')
      AND v_dest.provider_counterparty_id IS NOT NULL
      AND v_dest.provider_recipient_account_id IS NOT NULL
    )
  );
  IF NOT v_link_ok
     OR v_dest.provider_counterparty_id IS NULL
     OR v_dest.provider_recipient_account_id IS NULL
  THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PROVIDER_LINK_NOT_VERIFIED', 'message', 'destination not provider-linked');
  END IF;

  SELECT * INTO v_intent
  FROM public.driver_payout_payment_intents
  WHERE payout_item_id = p_payout_item_id
    AND execution_status IN (
      'DRAFT', 'VALIDATED', 'BLOCKED', 'READY', 'SUBMITTING', 'SUBMITTED', 'UNKNOWN'
    )
  FOR UPDATE;

  IF FOUND THEN
    IF upper(v_intent.execution_status) IN ('SUBMITTED', 'COMPLETED') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_SUBMITTED', 'message', 'intent already submitted');
    END IF;
    IF upper(v_intent.execution_status) = 'SUBMITTING' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SUBMISSION_IN_FLIGHT', 'message', 'intent submission in flight');
    END IF;
    IF upper(v_intent.execution_status) = 'UNKNOWN' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_NO_BLIND_RETRY', 'message', 'intent UNKNOWN — no blind retry');
    END IF;
  END IF;

  -- Revolut /pay request_id max 40 chars: oc-dp: + uuid hex (no dashes) = 38
  v_provider_request_id := 'oc-dp:' || replace(lower(p_payout_item_id::text), '-', '');
  v_idempotency_key := v_provider_request_id;
  v_fingerprint := concat_ws(
    '|',
    v_item.amount_pence::text,
    upper(COALESCE(v_item.currency, 'GBP')),
    btrim(p_source_account_id),
    v_dest.provider_counterparty_id,
    v_dest.provider_recipient_account_id,
    v_dest.id::text
  );

  IF FOUND THEN
    UPDATE public.driver_payout_payment_intents
    SET
      source_account_id = btrim(p_source_account_id),
      provider_counterparty_id = v_dest.provider_counterparty_id,
      provider_recipient_account_id = v_dest.provider_recipient_account_id,
      amount_pence = v_item.amount_pence,
      currency = upper(COALESCE(v_item.currency, 'GBP')),
      provider_request_id = v_provider_request_id,
      idempotency_key = v_idempotency_key,
      request_fingerprint = v_fingerprint,
      execution_status = 'SUBMITTING',
      claim_token = v_token,
      claimed_at = v_now,
      provider_failure_code = NULL,
      provider_failure_reason_safe = NULL,
      updated_at = v_now
    WHERE id = v_intent.id
    RETURNING * INTO v_intent;
  ELSE
    INSERT INTO public.driver_payout_payment_intents (
      payout_item_id,
      driver_id,
      payout_destination_id,
      provider,
      provider_request_id,
      idempotency_key,
      source_account_id,
      provider_counterparty_id,
      provider_recipient_account_id,
      amount_pence,
      currency,
      payment_reference,
      execution_status,
      request_fingerprint,
      claim_token,
      claimed_at
    ) VALUES (
      p_payout_item_id,
      v_item.driver_id,
      v_dest.id,
      'revolut_business',
      v_provider_request_id,
      v_idempotency_key,
      btrim(p_source_account_id),
      v_dest.provider_counterparty_id,
      v_dest.provider_recipient_account_id,
      v_item.amount_pence,
      upper(COALESCE(v_item.currency, 'GBP')),
      left('driver-payout:' || p_payout_item_id::text, 100),
      'SUBMITTING',
      v_fingerprint,
      v_token,
      v_now
    )
    RETURNING * INTO v_intent;
  END IF;

  UPDATE public.payout_items
  SET
    status = 'SUBMITTING',
    execution_status = 'SUBMITTING',
    updated_at = v_now
  WHERE id = p_payout_item_id;

  UPDATE public.payout_batches
  SET
    status = 'PROVIDER_SUBMISSION_IN_PROGRESS',
    updated_at = v_now
  WHERE id = v_item.batch_id
    AND status IN (
      'FUNDS_RESERVED_EXECUTION_DISABLED',
      'RESERVED',
      'PROVIDER_SUBMISSION_PARTIAL',
      'PROVIDER_SUBMISSION_IN_PROGRESS'
    );

  RETURN jsonb_build_object(
    'ok', true,
    'claim_token', v_token,
    'payout_item_id', p_payout_item_id,
    'payout_batch_id', v_item.batch_id,
    'reservation_id', v_res.id,
    'reservation_status', v_res.status,
    'intent_id', v_intent.id,
    'provider_request_id', v_provider_request_id,
    'idempotency_key', v_idempotency_key,
    'driver_id', v_item.driver_id,
    'payout_destination_id', v_dest.id,
    'source_account_id', btrim(p_source_account_id),
    'provider_counterparty_id', v_dest.provider_counterparty_id,
    'provider_recipient_account_id', v_dest.provider_recipient_account_id,
    'amount_pence', v_item.amount_pence,
    'currency', upper(COALESCE(v_item.currency, 'GBP')),
    'payment_reference', v_intent.payment_reference,
    'execution_status', 'SUBMITTING',
    'item_status', 'SUBMITTING'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_driver_payout_submission(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_driver_payout_submission(UUID, TEXT, UUID) TO service_role;

COMMIT;
