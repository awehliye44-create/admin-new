-- P0 Slice 12: company transfer provider submission, status sync, completion.
-- REVOLUT_PAYMENT_TRANSPORT_ENABLED=true; LIVE_COMPANY_TRANSFER_EXECUTION_ENABLED=false.
-- Company funding holds are separate from driver wallet reservations.
-- No company debit until provider state = completed. Fail-closed proof path.

BEGIN;

-- ---------------------------------------------------------------------------
-- Payment intents (provider submission lifecycle)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_transfer_payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES public.company_outgoing_transfers(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL DEFAULT 'revolut_business',
  provider_request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  source_account_id TEXT NOT NULL,
  provider_counterparty_id TEXT,
  provider_recipient_account_id TEXT,
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  currency TEXT NOT NULL DEFAULT 'GBP',
  payment_reference TEXT,
  execution_status TEXT NOT NULL DEFAULT 'READY',
  request_fingerprint TEXT NOT NULL,
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  provider_payment_id TEXT,
  provider_state TEXT,
  provider_created_at TIMESTAMPTZ,
  provider_completed_at TIMESTAMPTZ,
  provider_failure_code TEXT,
  provider_failure_reason_safe TEXT,
  submission_evidence_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
  completion_evidence_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
  financially_applied_at TIMESTAMPTZ,
  financial_application_audit_id UUID,
  last_provider_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.company_transfer_payment_intents
  DROP CONSTRAINT IF EXISTS company_transfer_payment_intents_execution_status_check;
ALTER TABLE public.company_transfer_payment_intents
  ADD CONSTRAINT company_transfer_payment_intents_execution_status_check
  CHECK (execution_status IN (
    'READY', 'SUBMITTING', 'SUBMITTED', 'COMPLETED',
    'FAILED', 'DECLINED', 'UNKNOWN', 'CANCELLED', 'REVERTED'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_transfer_intents_active_transfer
  ON public.company_transfer_payment_intents (transfer_id)
  WHERE execution_status IN ('READY', 'SUBMITTING', 'SUBMITTED', 'UNKNOWN');

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_transfer_intents_idempotency
  ON public.company_transfer_payment_intents (idempotency_key)
  WHERE execution_status NOT IN ('CANCELLED', 'FAILED', 'DECLINED');

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_transfer_intents_provider_applied
  ON public.company_transfer_payment_intents (provider_payment_id)
  WHERE financially_applied_at IS NOT NULL
    AND provider_payment_id IS NOT NULL;

COMMENT ON TABLE public.company_transfer_payment_intents IS
  'Slice 12: Revolut provider submission intents for company_outgoing_transfers.';

-- ---------------------------------------------------------------------------
-- Company funding holds (separate from driver_payout_reservations)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_funding_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id UUID NOT NULL REFERENCES public.company_outgoing_transfers(id) ON DELETE RESTRICT,
  payment_intent_id UUID REFERENCES public.company_transfer_payment_intents(id) ON DELETE SET NULL,
  service_area_id UUID,
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  currency TEXT NOT NULL DEFAULT 'GBP',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  hold_idempotency_key TEXT NOT NULL,
  provider_payment_id TEXT,
  released_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  release_reason TEXT,
  financial_application_audit_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.company_funding_holds
  DROP CONSTRAINT IF EXISTS company_funding_holds_status_check;
ALTER TABLE public.company_funding_holds
  ADD CONSTRAINT company_funding_holds_status_check
  CHECK (status IN ('ACTIVE', 'RELEASED', 'CONSUMED'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_funding_holds_active_transfer
  ON public.company_funding_holds (transfer_id)
  WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_funding_holds_idempotency
  ON public.company_funding_holds (hold_idempotency_key)
  WHERE status IN ('ACTIVE', 'CONSUMED');

COMMENT ON TABLE public.company_funding_holds IS
  'Slice 12: company cash hold during provider submission — never driver wallet reservation.';

-- ---------------------------------------------------------------------------
-- Atomic claim: READY transfer → SUBMITTING + intent + ACTIVE hold
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_company_transfer_submission(
  p_transfer_id UUID,
  p_source_account_id TEXT,
  p_claim_token UUID DEFAULT NULL,
  p_place_hold BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transfer public.company_outgoing_transfers%ROWTYPE;
  v_intent public.company_transfer_payment_intents%ROWTYPE;
  v_hold public.company_funding_holds%ROWTYPE;
  v_token UUID := COALESCE(p_claim_token, gen_random_uuid());
  v_provider_request_id TEXT;
  v_idempotency_key TEXT;
  v_fingerprint TEXT;
  v_hold_key TEXT;
  v_now TIMESTAMPTZ := now();
  v_amount INTEGER;
BEGIN
  IF p_transfer_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'MISSING_FIELD', 'message', 'transfer_id required');
  END IF;
  IF p_source_account_id IS NULL OR btrim(p_source_account_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'MISSING_SOURCE_ACCOUNT', 'message', 'source_account_id required');
  END IF;

  SELECT * INTO v_transfer
  FROM public.company_outgoing_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TRANSFER_NOT_FOUND', 'message', 'transfer not found');
  END IF;

  IF upper(v_transfer.status) NOT IN ('READY_FOR_EXECUTION', 'PROCESSING') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'TRANSFER_NOT_READY',
      'message', format('transfer status %s is not READY_FOR_EXECUTION', v_transfer.status)
    );
  END IF;

  v_amount := COALESCE(v_transfer.approved_amount_pence, v_transfer.amount_pence);
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'AMOUNT_INVALID', 'message', 'amount must be > 0');
  END IF;

  IF v_transfer.revolut_counterparty_id IS NULL OR v_transfer.revolut_recipient_account_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PAYEE_NOT_LINKED', 'message', 'payee linkage required');
  END IF;

  SELECT * INTO v_intent
  FROM public.company_transfer_payment_intents
  WHERE transfer_id = p_transfer_id
    AND execution_status IN ('READY', 'SUBMITTING', 'SUBMITTED', 'UNKNOWN')
  FOR UPDATE;

  IF FOUND THEN
    IF upper(v_intent.execution_status) IN ('SUBMITTED', 'COMPLETED') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_SUBMITTED', 'message', 'intent already submitted');
    END IF;
    IF upper(v_intent.execution_status) = 'SUBMITTING' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SUBMISSION_IN_FLIGHT', 'message', 'submission in flight');
    END IF;
    IF upper(v_intent.execution_status) = 'UNKNOWN' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_NO_BLIND_RETRY', 'message', 'UNKNOWN — no blind retry');
    END IF;
  END IF;

  v_provider_request_id := 'oc-ct:' || replace(lower(p_transfer_id::text), '-', '');
  v_idempotency_key := v_provider_request_id;
  v_fingerprint := concat_ws(
    '|',
    v_amount::text,
    upper(COALESCE(v_transfer.currency, 'GBP')),
    btrim(p_source_account_id),
    v_transfer.revolut_counterparty_id,
    v_transfer.revolut_recipient_account_id,
    p_transfer_id::text
  );
  v_hold_key := 'company-hold:' || p_transfer_id::text;

  IF FOUND THEN
    UPDATE public.company_transfer_payment_intents
    SET
      source_account_id = btrim(p_source_account_id),
      provider_counterparty_id = v_transfer.revolut_counterparty_id,
      provider_recipient_account_id = v_transfer.revolut_recipient_account_id,
      amount_pence = v_amount,
      currency = upper(COALESCE(v_transfer.currency, 'GBP')),
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
    INSERT INTO public.company_transfer_payment_intents (
      transfer_id,
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
      p_transfer_id,
      COALESCE(v_transfer.provider, 'revolut_business'),
      v_provider_request_id,
      v_idempotency_key,
      btrim(p_source_account_id),
      v_transfer.revolut_counterparty_id,
      v_transfer.revolut_recipient_account_id,
      v_amount,
      upper(COALESCE(v_transfer.currency, 'GBP')),
      left(COALESCE(v_transfer.payment_reference, v_transfer.transfer_ref), 100),
      'SUBMITTING',
      v_fingerprint,
      v_token,
      v_now
    )
    RETURNING * INTO v_intent;
  END IF;

  IF p_place_hold THEN
    SELECT * INTO v_hold
    FROM public.company_funding_holds
    WHERE transfer_id = p_transfer_id
      AND status = 'ACTIVE'
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.company_funding_holds (
        transfer_id,
        payment_intent_id,
        service_area_id,
        amount_pence,
        currency,
        status,
        hold_idempotency_key
      ) VALUES (
        p_transfer_id,
        v_intent.id,
        v_transfer.service_area_id,
        v_amount,
        upper(COALESCE(v_transfer.currency, 'GBP')),
        'ACTIVE',
        v_hold_key
      )
      RETURNING * INTO v_hold;
    ELSE
      UPDATE public.company_funding_holds
      SET payment_intent_id = v_intent.id, updated_at = v_now
      WHERE id = v_hold.id
      RETURNING * INTO v_hold;
    END IF;
  END IF;

  UPDATE public.company_outgoing_transfers
  SET
    status = 'PROCESSING',
    source_account_id = btrim(p_source_account_id),
    execution_attempt = COALESCE(execution_attempt, 0) + 1,
    last_attempt_at = v_now,
    updated_at = v_now
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object(
    'ok', true,
    'claim_token', v_token,
    'transfer_id', p_transfer_id,
    'intent_id', v_intent.id,
    'hold_id', v_hold.id,
    'hold_status', COALESCE(v_hold.status, null),
    'provider_request_id', v_provider_request_id,
    'idempotency_key', v_idempotency_key,
    'source_account_id', btrim(p_source_account_id),
    'provider_counterparty_id', v_transfer.revolut_counterparty_id,
    'provider_recipient_account_id', v_transfer.revolut_recipient_account_id,
    'amount_pence', v_amount,
    'currency', upper(COALESCE(v_transfer.currency, 'GBP')),
    'payment_reference', v_intent.payment_reference,
    'execution_status', 'SUBMITTING',
    'transfer_status', 'PROCESSING'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_company_transfer_submission(UUID, TEXT, UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_company_transfer_submission(UUID, TEXT, UUID, BOOLEAN) TO service_role;

-- ---------------------------------------------------------------------------
-- Finalize submission after relay
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_company_transfer_submission(
  p_transfer_id UUID,
  p_claim_token UUID,
  p_execution_status TEXT,
  p_provider_payment_id TEXT DEFAULT NULL,
  p_provider_state TEXT DEFAULT NULL,
  p_provider_created_at TIMESTAMPTZ DEFAULT NULL,
  p_provider_failure_code TEXT DEFAULT NULL,
  p_provider_failure_reason_safe TEXT DEFAULT NULL,
  p_evidence_redacted JSONB DEFAULT '{}'::jsonb,
  p_release_hold BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transfer public.company_outgoing_transfers%ROWTYPE;
  v_intent public.company_transfer_payment_intents%ROWTYPE;
  v_status TEXT := upper(btrim(p_execution_status));
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_status NOT IN ('SUBMITTED', 'FAILED', 'DECLINED', 'UNKNOWN') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'VALIDATION_FAILED', 'message', 'invalid execution_status');
  END IF;

  SELECT * INTO v_intent
  FROM public.company_transfer_payment_intents
  WHERE transfer_id = p_transfer_id
    AND execution_status = 'SUBMITTING'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CLAIM_CONFLICT', 'message', 'no SUBMITTING intent');
  END IF;

  IF v_intent.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CLAIM_CONFLICT', 'message', 'claim_token mismatch');
  END IF;

  SELECT * INTO v_transfer
  FROM public.company_outgoing_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  UPDATE public.company_transfer_payment_intents
  SET
    execution_status = v_status,
    provider_payment_id = COALESCE(p_provider_payment_id, provider_payment_id),
    provider_state = COALESCE(p_provider_state, provider_state),
    provider_created_at = COALESCE(p_provider_created_at, provider_created_at),
    provider_failure_code = p_provider_failure_code,
    provider_failure_reason_safe = p_provider_failure_reason_safe,
    submission_evidence_redacted = COALESCE(p_evidence_redacted, submission_evidence_redacted),
    last_provider_sync_at = v_now,
    updated_at = v_now
  WHERE id = v_intent.id
  RETURNING * INTO v_intent;

  UPDATE public.company_outgoing_transfers
  SET
    status = CASE v_status
      WHEN 'SUBMITTED' THEN 'PROCESSING'
      WHEN 'UNKNOWN' THEN 'PROCESSING'
      WHEN 'DECLINED' THEN 'DECLINED'
      ELSE 'FAILED'
    END,
    provider_transaction_id = COALESCE(p_provider_payment_id, provider_transaction_id),
    provider_state = COALESCE(p_provider_state, provider_state),
    provider_created_at = COALESCE(p_provider_created_at, provider_created_at),
    provider_failure_code = p_provider_failure_code,
    provider_failure_reason = p_provider_failure_reason_safe,
    last_provider_sync_at = v_now,
    failure_reason = CASE WHEN v_status IN ('FAILED', 'DECLINED') THEN COALESCE(p_provider_failure_code, v_status) ELSE failure_reason END,
    updated_at = v_now
  WHERE id = p_transfer_id
  RETURNING * INTO v_transfer;

  IF p_release_hold THEN
    UPDATE public.company_funding_holds
    SET
      status = 'RELEASED',
      released_at = v_now,
      release_reason = COALESCE(p_provider_failure_code, v_status),
      updated_at = v_now
    WHERE transfer_id = p_transfer_id
      AND status = 'ACTIVE';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'transfer_id', p_transfer_id,
    'intent_id', v_intent.id,
    'execution_status', v_status,
    'transfer_status', v_transfer.status,
    'provider_payment_id', v_intent.provider_payment_id,
    'provider_state', v_intent.provider_state,
    'hold_released', p_release_hold,
    'company_debited', false,
    'money_moved', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_company_transfer_submission(UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, JSONB, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_company_transfer_submission(UUID, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, JSONB, BOOLEAN) TO service_role;

-- ---------------------------------------------------------------------------
-- Release hold on failure / reversal (no debit)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_company_funding_hold(
  p_transfer_id UUID,
  p_reason TEXT DEFAULT 'RELEASED'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hold public.company_funding_holds%ROWTYPE;
  v_now TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_hold
  FROM public.company_funding_holds
  WHERE transfer_id = p_transfer_id
    AND status = 'ACTIVE'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'HOLD_NOT_ACTIVE', 'message', 'no ACTIVE hold');
  END IF;

  UPDATE public.company_funding_holds
  SET status = 'RELEASED', released_at = v_now, release_reason = p_reason, updated_at = v_now
  WHERE id = v_hold.id
  RETURNING * INTO v_hold;

  RETURN jsonb_build_object(
    'ok', true,
    'hold_id', v_hold.id,
    'hold_status', 'RELEASED',
    'money_moved', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.release_company_funding_hold(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_company_funding_hold(UUID, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- Completion: provider completed → consume hold + mark transfer COMPLETED (exactly once)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_company_transfer_completion(
  p_transfer_id UUID,
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
  v_transfer public.company_outgoing_transfers%ROWTYPE;
  v_intent public.company_transfer_payment_intents%ROWTYPE;
  v_hold public.company_funding_holds%ROWTYPE;
  v_state TEXT := lower(btrim(COALESCE(p_provider_state, '')));
  v_pay_id TEXT := btrim(COALESCE(p_provider_payment_id, ''));
  v_now TIMESTAMPTZ := now();
  v_audit_id UUID;
BEGIN
  IF v_state IS DISTINCT FROM 'completed' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PROVIDER_NOT_COMPLETED',
      'message', format('Provider state %L must never debit company funds', COALESCE(NULLIF(v_state, ''), 'unknown')),
      'company_debited', false,
      'hold_consumed', false,
      'money_moved', false
    );
  END IF;

  IF v_pay_id = '' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'MISSING_PROVIDER_PAYMENT_ID',
      'message', 'provider_payment_id required',
      'company_debited', false,
      'hold_consumed', false
    );
  END IF;

  SELECT * INTO v_transfer
  FROM public.company_outgoing_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'VALIDATION_FAILED', 'message', 'transfer not found');
  END IF;

  SELECT * INTO v_intent
  FROM public.company_transfer_payment_intents
  WHERE transfer_id = p_transfer_id
  ORDER BY
    CASE WHEN execution_status IN ('SUBMITTED', 'UNKNOWN', 'COMPLETED') THEN 0 ELSE 1 END,
    created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_intent.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TRANSFER_NOT_SUBMITTED', 'message', 'no payment intent');
  END IF;

  IF v_intent.financially_applied_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'already_applied', true,
      'transfer_id', p_transfer_id,
      'intent_id', v_intent.id,
      'provider_payment_id', v_intent.provider_payment_id,
      'company_debited', true,
      'hold_consumed', true,
      'money_moved', true
    );
  END IF;

  SELECT * INTO v_hold
  FROM public.company_funding_holds
  WHERE transfer_id = p_transfer_id
    AND status IN ('ACTIVE', 'CONSUMED')
  FOR UPDATE;

  IF NOT FOUND OR v_hold.status = 'RELEASED' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'HOLD_NOT_ACTIVE',
      'message', 'ACTIVE hold required for completion',
      'company_debited', false,
      'hold_consumed', false
    );
  END IF;

  IF v_intent.provider_payment_id IS NOT NULL AND v_intent.provider_payment_id IS DISTINCT FROM v_pay_id THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'PROVIDER_PAYMENT_ID_MISMATCH',
      'message', 'provider_payment_id mismatch',
      'company_debited', false,
      'hold_consumed', false
    );
  END IF;

  IF v_hold.amount_pence IS DISTINCT FROM v_intent.amount_pence
     OR v_hold.amount_pence IS DISTINCT FROM COALESCE(v_transfer.approved_amount_pence, v_transfer.amount_pence)
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'AMOUNT_MISMATCH',
      'message', 'hold/intent/transfer amount mismatch',
      'company_debited', false,
      'hold_consumed', false
    );
  END IF;

  INSERT INTO public.company_outgoing_transfer_audit (
    transfer_id,
    event_type,
    actor_id,
    old_status,
    new_status,
    metadata
  ) VALUES (
    p_transfer_id,
    'COMPLETION_APPLIED',
    NULL,
    v_transfer.status,
    'COMPLETED',
    jsonb_build_object(
      'money_moved', true,
      'provider_payment_id', v_pay_id,
      'amount_pence', v_hold.amount_pence,
      'slice', 12
    )
  )
  RETURNING id INTO v_audit_id;

  UPDATE public.company_transfer_payment_intents
  SET
    execution_status = 'COMPLETED',
    provider_payment_id = v_pay_id,
    provider_state = 'completed',
    provider_completed_at = COALESCE(p_provider_completed_at, v_now),
    completion_evidence_redacted = COALESCE(p_evidence_redacted, completion_evidence_redacted),
    financially_applied_at = v_now,
    financial_application_audit_id = v_audit_id,
    last_provider_sync_at = v_now,
    updated_at = v_now
  WHERE id = v_intent.id
  RETURNING * INTO v_intent;

  UPDATE public.company_funding_holds
  SET
    status = 'CONSUMED',
    consumed_at = v_now,
    provider_payment_id = v_pay_id,
    financial_application_audit_id = v_audit_id,
    updated_at = v_now
  WHERE id = v_hold.id
  RETURNING * INTO v_hold;

  UPDATE public.company_outgoing_transfers
  SET
    status = 'COMPLETED',
    provider_transaction_id = v_pay_id,
    provider_state = 'completed',
    provider_completed_at = COALESCE(p_provider_completed_at, v_now),
    execution_at = COALESCE(p_provider_completed_at, v_now),
    last_provider_sync_at = v_now,
    updated_at = v_now
  WHERE id = p_transfer_id
  RETURNING * INTO v_transfer;

  RETURN jsonb_build_object(
    'ok', true,
    'transfer_id', p_transfer_id,
    'intent_id', v_intent.id,
    'hold_id', v_hold.id,
    'execution_status', 'COMPLETED',
    'transfer_status', 'COMPLETED',
    'provider_payment_id', v_pay_id,
    'provider_state', 'completed',
    'company_debited', true,
    'hold_consumed', true,
    'money_moved', true,
    'financially_applied_at', v_intent.financially_applied_at,
    'audit_id', v_audit_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_company_transfer_completion(UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finalize_company_transfer_completion(UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- Status sync (read-only provider poll result persistence)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_company_transfer_provider_status(
  p_transfer_id UUID,
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
  v_intent public.company_transfer_payment_intents%ROWTYPE;
  v_now TIMESTAMPTZ := now();
  v_state TEXT := lower(btrim(COALESCE(p_provider_state, '')));
BEGIN
  SELECT * INTO v_intent
  FROM public.company_transfer_payment_intents
  WHERE transfer_id = p_transfer_id
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INTENT_NOT_FOUND');
  END IF;

  UPDATE public.company_transfer_payment_intents
  SET
    provider_payment_id = COALESCE(NULLIF(btrim(p_provider_payment_id), ''), provider_payment_id),
    provider_state = COALESCE(NULLIF(v_state, ''), provider_state),
    provider_completed_at = COALESCE(p_provider_completed_at, provider_completed_at),
    completion_evidence_redacted = CASE
      WHEN v_state = 'completed' THEN COALESCE(p_evidence_redacted, completion_evidence_redacted)
      ELSE completion_evidence_redacted
    END,
    last_provider_sync_at = v_now,
    updated_at = v_now
  WHERE id = v_intent.id
  RETURNING * INTO v_intent;

  UPDATE public.company_outgoing_transfers
  SET
    provider_transaction_id = COALESCE(NULLIF(btrim(p_provider_payment_id), ''), provider_transaction_id),
    provider_state = COALESCE(NULLIF(v_state, ''), provider_state),
    provider_completed_at = COALESCE(p_provider_completed_at, provider_completed_at),
    last_provider_sync_at = v_now,
    updated_at = v_now
  WHERE id = p_transfer_id;

  RETURN jsonb_build_object(
    'ok', true,
    'transfer_id', p_transfer_id,
    'provider_state', v_intent.provider_state,
    'provider_payment_id', v_intent.provider_payment_id,
    'money_moved', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_company_transfer_provider_status(UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_company_transfer_provider_status(UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB) TO service_role;

COMMIT;
