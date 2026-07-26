-- P0 Slice 7: controlled provider submission for RESERVED driver payout items.
-- REVOLUT_PAYMENT_TRANSPORT_ENABLED=true (edge+relay); LIVE_PAYOUT_EXECUTION_ENABLED=false.
-- Reservation stays ACTIVE on SUBMITTED/PENDING/UNKNOWN. Hard reject releases once.
-- No permanent wallet debit (Slice 8).

BEGIN;

-- ---------------------------------------------------------------------------
-- Status widen
-- ---------------------------------------------------------------------------
ALTER TABLE public.payout_batches DROP CONSTRAINT IF EXISTS payout_batches_status_check;
ALTER TABLE public.payout_batches ADD CONSTRAINT payout_batches_status_check
  CHECK (status = ANY (ARRAY[
    'pending', 'processing', 'completed', 'failed', 'partial', 'PARTIAL_SETTLEMENT',
    'INVALID_ORPHANED', 'CREATED', 'READY', 'BLOCKED', 'SENT', 'PAID', 'RETURNED',
    'DRAFT', 'SCHEDULED', 'VALIDATING', 'PROCESSING', 'PARTIALLY_COMPLETED',
    'COMPLETED', 'FAILED', 'CANCELLED',
    'ELIGIBILITY_SNAPSHOTTED', 'ITEMS_CREATED', 'BLOCKED_EXECUTION_DISABLED',
    'FUNDS_RESERVED_EXECUTION_DISABLED',
    'RESERVING', 'RESERVED',
    'PROVIDER_SUBMISSION_IN_PROGRESS', 'PROVIDER_SUBMISSION_PARTIAL'
  ]));

ALTER TABLE public.payout_items DROP CONSTRAINT IF EXISTS payout_items_status_check;
ALTER TABLE public.payout_items ADD CONSTRAINT payout_items_status_check
  CHECK (status = ANY (ARRAY[
    'pending', 'processing', 'completed', 'failed', 'ledger_sync_failed',
    'CREATED', 'READY', 'BLOCKED', 'SENT', 'PAID', 'FAILED', 'RETURNED', 'INVALID_ORPHANED',
    'VALIDATED', 'BLOCKED_EXECUTION_DISABLED', 'INELIGIBLE',
    'RESERVING', 'RESERVED', 'SUBMITTING', 'SUBMITTED', 'COMPLETED',
    'RELEASED', 'REVERSED', 'CANCELLED', 'DECLINED', 'UNKNOWN'
  ]));

ALTER TABLE public.driver_payout_payment_intents
  DROP CONSTRAINT IF EXISTS driver_payout_payment_intents_execution_status_check;
ALTER TABLE public.driver_payout_payment_intents
  ADD CONSTRAINT driver_payout_payment_intents_execution_status_check
  CHECK (execution_status IN (
    'DRAFT', 'VALIDATED', 'BLOCKED', 'READY', 'SUBMITTING', 'SUBMITTED',
    'COMPLETED', 'FAILED', 'DECLINED', 'CANCELLED', 'REVERTED', 'UNKNOWN'
  ));

ALTER TABLE public.driver_payout_payment_intents
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submission_evidence_redacted JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.driver_payout_payment_intents.claim_token IS
  'Slice 7 atomic claim owner token; only claim owner may finalize after relay /pay.';

-- Active unique index must include UNKNOWN (no second submit / blind retry)
DROP INDEX IF EXISTS idx_driver_payout_payment_intents_active_item;
CREATE UNIQUE INDEX idx_driver_payout_payment_intents_active_item
  ON public.driver_payout_payment_intents (payout_item_id)
  WHERE execution_status IN (
    'DRAFT', 'VALIDATED', 'BLOCKED', 'READY', 'SUBMITTING', 'SUBMITTED', 'UNKNOWN'
  );

-- ---------------------------------------------------------------------------
-- Atomic claim: lock item + ACTIVE reservation → gates → SUBMITTING → intent row
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Finalize after relay: claim-owner only; optionally release on hard reject
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_driver_payout_submission(
  p_payout_item_id UUID,
  p_claim_token UUID,
  p_execution_status TEXT,
  p_provider_payment_id TEXT DEFAULT NULL,
  p_provider_state TEXT DEFAULT NULL,
  p_provider_created_at TIMESTAMPTZ DEFAULT NULL,
  p_provider_failure_code TEXT DEFAULT NULL,
  p_provider_failure_reason_safe TEXT DEFAULT NULL,
  p_evidence_redacted JSONB DEFAULT '{}'::jsonb,
  p_release_reservation BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.payout_items%ROWTYPE;
  v_intent public.driver_payout_payment_intents%ROWTYPE;
  v_status TEXT := upper(btrim(p_execution_status));
  v_now TIMESTAMPTZ := now();
  v_release JSONB;
  v_reserved_left INTEGER;
  v_submitted_count INTEGER;
BEGIN
  IF v_status NOT IN ('SUBMITTED', 'FAILED', 'DECLINED', 'UNKNOWN') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'VALIDATION_FAILED', 'message', 'invalid execution_status');
  END IF;

  SELECT * INTO v_intent
  FROM public.driver_payout_payment_intents
  WHERE payout_item_id = p_payout_item_id
    AND execution_status = 'SUBMITTING'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CLAIM_CONFLICT', 'message', 'no SUBMITTING intent for item');
  END IF;

  IF v_intent.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CLAIM_CONFLICT', 'message', 'claim_token mismatch');
  END IF;

  SELECT * INTO v_item
  FROM public.payout_items
  WHERE id = p_payout_item_id
  FOR UPDATE;

  UPDATE public.driver_payout_payment_intents
  SET
    execution_status = v_status,
    provider_payment_id = COALESCE(p_provider_payment_id, provider_payment_id),
    provider_state = COALESCE(p_provider_state, provider_state),
    provider_created_at = COALESCE(p_provider_created_at, provider_created_at),
    provider_failure_code = p_provider_failure_code,
    provider_failure_reason_safe = p_provider_failure_reason_safe,
    submission_evidence_redacted = COALESCE(p_evidence_redacted, '{}'::jsonb),
    last_provider_sync_at = v_now,
    updated_at = v_now
  WHERE id = v_intent.id
  RETURNING * INTO v_intent;

  UPDATE public.payout_items
  SET
    status = v_status,
    execution_status = v_status,
    updated_at = v_now
  WHERE id = p_payout_item_id
  RETURNING * INTO v_item;

  IF p_release_reservation AND v_status IN ('FAILED', 'DECLINED') THEN
    v_release := public.release_driver_payout_reservation(
      NULL,
      p_payout_item_id,
      'PROVIDER_SUBMISSION_FAILED'
    );
  END IF;

  SELECT count(*)::int INTO v_reserved_left
  FROM public.driver_payout_reservations
  WHERE payout_batch_id = v_item.batch_id
    AND status = 'ACTIVE';

  SELECT count(*)::int INTO v_submitted_count
  FROM public.payout_items
  WHERE batch_id = v_item.batch_id
    AND status IN ('SUBMITTED', 'UNKNOWN');

  IF v_submitted_count > 0 AND v_reserved_left > 0 THEN
    UPDATE public.payout_batches
    SET status = 'PROVIDER_SUBMISSION_PARTIAL', updated_at = v_now
    WHERE id = v_item.batch_id;
  ELSIF v_submitted_count > 0 THEN
    UPDATE public.payout_batches
    SET status = 'PROVIDER_SUBMISSION_PARTIAL', updated_at = v_now
    WHERE id = v_item.batch_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'payout_item_id', p_payout_item_id,
    'intent_id', v_intent.id,
    'execution_status', v_status,
    'item_status', v_status,
    'provider_payment_id', v_intent.provider_payment_id,
    'provider_state', v_intent.provider_state,
    'reservation_release', COALESCE(v_release, jsonb_build_object('released', false)),
    'wallet_debited', false,
    'paid', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_driver_payout_submission(
  UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, JSONB, BOOLEAN
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_driver_payout_submission(
  UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, JSONB, BOOLEAN
) TO service_role;

-- Abort claim before any provider payment creation (transport/relay infra gap).
-- Restores RESERVED + keeps ACTIVE reservation. Never debits.
CREATE OR REPLACE FUNCTION public.abort_driver_payout_submission_claim(
  p_payout_item_id UUID,
  p_claim_token UUID,
  p_failure_code TEXT DEFAULT 'PAYMENT_TRANSPORT_DISABLED',
  p_failure_reason_safe TEXT DEFAULT 'Submission aborted before provider payment creation'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_intent public.driver_payout_payment_intents%ROWTYPE;
  v_item public.payout_items%ROWTYPE;
  v_now TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_intent
  FROM public.driver_payout_payment_intents
  WHERE payout_item_id = p_payout_item_id
    AND execution_status = 'SUBMITTING'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CLAIM_CONFLICT', 'message', 'no SUBMITTING intent');
  END IF;
  IF v_intent.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CLAIM_CONFLICT', 'message', 'claim_token mismatch');
  END IF;

  UPDATE public.driver_payout_payment_intents
  SET execution_status = 'BLOCKED',
      provider_failure_code = p_failure_code,
      provider_failure_reason_safe = p_failure_reason_safe,
      claim_token = NULL,
      claimed_at = NULL,
      updated_at = v_now
  WHERE id = v_intent.id;

  UPDATE public.payout_items
  SET status = 'RESERVED',
      execution_status = 'BLOCKED_EXECUTION_DISABLED',
      updated_at = v_now
  WHERE id = p_payout_item_id
  RETURNING * INTO v_item;

  UPDATE public.payout_batches
  SET status = 'FUNDS_RESERVED_EXECUTION_DISABLED',
      updated_at = v_now
  WHERE id = v_item.batch_id
    AND NOT EXISTS (
      SELECT 1 FROM public.payout_items pi
      WHERE pi.batch_id = v_item.batch_id
        AND pi.status IN ('SUBMITTING', 'SUBMITTED', 'UNKNOWN')
    );

  RETURN jsonb_build_object(
    'ok', true,
    'aborted', true,
    'payout_item_id', p_payout_item_id,
    'item_status', 'RESERVED',
    'reservation_released', false,
    'wallet_debited', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.abort_driver_payout_submission_claim(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.abort_driver_payout_submission_claim(UUID, UUID, TEXT, TEXT) TO service_role;

COMMIT;
