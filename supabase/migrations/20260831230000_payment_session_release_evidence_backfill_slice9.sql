-- Slice 9: Historical customer-payment release evidence backfill ledger.
-- Evidence / reconciliation ONLY.
-- Never invents released_amount_pence from authorised − captured.
-- Never mutates driver wallets, payouts, or Revolut Business /pay.

BEGIN;

CREATE TABLE IF NOT EXISTS public.payment_session_release_evidence_backfill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  payment_session_id uuid NOT NULL REFERENCES public.payment_sessions (id),
  trip_id uuid NULL,
  provider_order_id text NOT NULL,
  provider_payment_id text NULL,
  provider_state text NULL,
  authorised_amount_pence integer NULL CHECK (authorised_amount_pence IS NULL OR authorised_amount_pence >= 0),
  captured_amount_pence integer NULL CHECK (captured_amount_pence IS NULL OR captured_amount_pence >= 0),
  -- Provider-explicit only; NULL when unresolved / fail-closed.
  released_amount_pence integer NULL CHECK (released_amount_pence IS NULL OR released_amount_pence >= 0),
  -- Comparison-only (auth − capture); never treated as canonical released amount.
  comparison_auth_minus_capture_pence integer NULL,
  release_evidence_status text NOT NULL,
  suggested_status_alias text NULL,
  unresolved_reason text NULL,
  backfill_source text NOT NULL,
  backfill_version text NOT NULL,
  provider_retrieved_at timestamptz NOT NULL,
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  session_patch_applied boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_session_release_evidence_backfill_status_check
    CHECK (
      release_evidence_status IN (
        'NOT_REQUIRED',
        'PENDING_PROVIDER_CONFIRMATION',
        'CONFIRMED',
        'AMOUNT_UNCONFIRMED',
        'FAILED',
        'PROVIDER_STATE_UNAVAILABLE'
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ps_release_evidence_backfill_idem
  ON public.payment_session_release_evidence_backfill (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_ps_release_evidence_backfill_session
  ON public.payment_session_release_evidence_backfill (payment_session_id);

CREATE INDEX IF NOT EXISTS idx_ps_release_evidence_backfill_trip
  ON public.payment_session_release_evidence_backfill (trip_id)
  WHERE trip_id IS NOT NULL;

COMMENT ON TABLE public.payment_session_release_evidence_backfill IS
  'Slice 9 historical release evidence backfill audit. Fail-closed amounts. No money mutations.';

COMMENT ON COLUMN public.payment_session_release_evidence_backfill.released_amount_pence IS
  'Provider-explicit cancelled/released amount only. Never auth−capture.';

COMMENT ON COLUMN public.payment_session_release_evidence_backfill.comparison_auth_minus_capture_pence IS
  'Audit comparison only — never write to payment_sessions.released_amount_pence from this column.';

-- Idempotent insert: returns existing row when key already present (no overwrite).
CREATE OR REPLACE FUNCTION public.insert_payment_release_evidence_backfill(
  p_idempotency_key text,
  p_payment_session_id uuid,
  p_trip_id uuid,
  p_provider_order_id text,
  p_provider_payment_id text,
  p_provider_state text,
  p_authorised_amount_pence integer,
  p_captured_amount_pence integer,
  p_released_amount_pence integer,
  p_comparison_auth_minus_capture_pence integer,
  p_release_evidence_status text,
  p_suggested_status_alias text,
  p_unresolved_reason text,
  p_backfill_source text,
  p_backfill_version text,
  p_provider_retrieved_at timestamptz,
  p_provider_snapshot jsonb,
  p_session_patch_applied boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.payment_session_release_evidence_backfill%ROWTYPE;
  v_inserted public.payment_session_release_evidence_backfill%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'idempotency_key required';
  END IF;
  IF p_released_amount_pence IS NOT NULL
     AND p_release_evidence_status IS DISTINCT FROM 'CONFIRMED' THEN
    RAISE EXCEPTION 'released_amount_pence only allowed when status=CONFIRMED';
  END IF;

  SELECT * INTO v_existing
  FROM public.payment_session_release_evidence_backfill
  WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'inserted', false,
      'duplicate', true,
      'id', v_existing.id,
      'idempotency_key', v_existing.idempotency_key,
      'release_evidence_status', v_existing.release_evidence_status,
      'released_amount_pence', v_existing.released_amount_pence
    );
  END IF;

  INSERT INTO public.payment_session_release_evidence_backfill (
    idempotency_key,
    payment_session_id,
    trip_id,
    provider_order_id,
    provider_payment_id,
    provider_state,
    authorised_amount_pence,
    captured_amount_pence,
    released_amount_pence,
    comparison_auth_minus_capture_pence,
    release_evidence_status,
    suggested_status_alias,
    unresolved_reason,
    backfill_source,
    backfill_version,
    provider_retrieved_at,
    provider_snapshot,
    session_patch_applied
  ) VALUES (
    p_idempotency_key,
    p_payment_session_id,
    p_trip_id,
    p_provider_order_id,
    p_provider_payment_id,
    p_provider_state,
    p_authorised_amount_pence,
    p_captured_amount_pence,
    p_released_amount_pence,
    p_comparison_auth_minus_capture_pence,
    p_release_evidence_status,
    p_suggested_status_alias,
    p_unresolved_reason,
    p_backfill_source,
    p_backfill_version,
    p_provider_retrieved_at,
    COALESCE(p_provider_snapshot, '{}'::jsonb),
    COALESCE(p_session_patch_applied, false)
  )
  RETURNING * INTO v_inserted;

  RETURN jsonb_build_object(
    'inserted', true,
    'duplicate', false,
    'id', v_inserted.id,
    'idempotency_key', v_inserted.idempotency_key,
    'release_evidence_status', v_inserted.release_evidence_status,
    'released_amount_pence', v_inserted.released_amount_pence
  );
END;
$$;

REVOKE ALL ON FUNCTION public.insert_payment_release_evidence_backfill FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_payment_release_evidence_backfill TO service_role;

ALTER TABLE public.payment_session_release_evidence_backfill ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_session_release_evidence_backfill_service ON public.payment_session_release_evidence_backfill;
CREATE POLICY payment_session_release_evidence_backfill_service
  ON public.payment_session_release_evidence_backfill
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMIT;
