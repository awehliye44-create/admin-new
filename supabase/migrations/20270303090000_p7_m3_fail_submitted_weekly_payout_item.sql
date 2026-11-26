-- ============================================================
-- P7 M3 — per-item resolution of a SUBMITTED weekly payout item whose provider
-- transaction reached a terminal failure state.
--
-- fail_submitted_early_cashout is early-cashout-only: it rejects non-EARLY_CASHOUT
-- batches and FAILS THE WHOLE BATCH (one item per cash-out batch). A weekly batch carries
-- many drivers' items, so this RPC fails exactly ONE item, releases exactly ONE
-- reservation (that item's, via the existing per-reservation release RPC) and never
-- writes payout_batches (the existing refresh_driver_payout_batch_aggregate_status
-- trigger recomputes the aggregate) nor any other item/reservation.
--
-- Never resends /pay (DB function; no provider access). Never touches an item whose
-- money was applied (financially_applied_at / COMPLETED / ledger rows) — that is a
-- reversal review, not a release. Service-role only; the admin-gated Edge function
-- `admin-resolve-weekly-terminal-payout-item` GET-reconciles first and then calls this.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fail_submitted_weekly_payout_item(
  p_payout_item_id uuid,
  p_provider_payment_id text,
  p_provider_state text,
  p_evidence_redacted jsonb DEFAULT '{}'::jsonb,
  p_actor_user_id uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item public.payout_items%ROWTYPE;
  v_kind text;
  v_intent public.driver_payout_payment_intents%ROWTYPE;
  v_res public.driver_payout_reservations%ROWTYPE;
  v_state text := lower(btrim(COALESCE(p_provider_state, '')));
  v_pay_id text := NULLIF(btrim(COALESCE(p_provider_payment_id, '')), '');
  v_code text;
  v_intent_exec text;
  v_release jsonb := NULL;
  v_now timestamptz := now();
BEGIN
  IF p_payout_item_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_ITEM_NOT_FOUND');
  END IF;
  IF v_state NOT IN ('failed', 'declined', 'rejected', 'reverted', 'cancelled', 'canceled', 'revoked') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_TERMINAL_PROVIDER_FAILURE', 'provider_state', v_state);
  END IF;
  IF v_pay_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PROVIDER_PAYMENT_ID_REQUIRED');
  END IF;
  v_code := 'PROVIDER_' || upper(CASE WHEN v_state = 'canceled' THEN 'cancelled' ELSE v_state END);
  v_intent_exec := CASE
    WHEN v_state = 'declined' THEN 'DECLINED'
    WHEN v_state = 'reverted' THEN 'REVERTED'
    WHEN v_state IN ('cancelled', 'canceled') THEN 'CANCELLED'
    ELSE 'FAILED'
  END;

  -- Lock ONE item. The batch row is only read (never locked/written here).
  SELECT * INTO v_item FROM public.payout_items WHERE id = p_payout_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_ITEM_NOT_FOUND');
  END IF;

  SELECT kind INTO v_kind FROM public.payout_batches WHERE id = v_item.batch_id;
  IF v_kind IS NULL OR v_kind NOT IN ('WEEKLY_SCHEDULED', 'WEEKLY_MONDAY') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_WEEKLY_PAYOUT', 'kind', v_kind);
  END IF;

  SELECT * INTO v_intent
  FROM public.driver_payout_payment_intents
  WHERE payout_item_id = v_item.id
    AND provider_payment_id = v_pay_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PROVIDER_PAYMENT_ID_MISMATCH');
  END IF;

  -- Money already applied to the wallet: a later revert is a reversal, never a release.
  IF v_intent.financially_applied_at IS NOT NULL
     OR upper(btrim(COALESCE(v_item.status, ''))) = 'COMPLETED'
     OR EXISTS (
       SELECT 1 FROM public.driver_wallet_ledger l
       WHERE l.driver_id = v_item.driver_id
         AND l.provider_payout_id = v_pay_id
         AND l.type IN ('WEEKLY_PAYOUT', 'EARLY_CASHOUT', 'CASHOUT_FEE', 'PAYOUT', 'MANUAL_PAYOUT')
     ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'ALREADY_APPLIED_REQUIRES_REVERSAL_REVIEW',
      'payout_item_id', v_item.id
    );
  END IF;

  -- Idempotent replay.
  IF upper(btrim(COALESCE(v_item.status, ''))) = 'FAILED'
     AND v_item.failure_code = v_code
     AND NOT EXISTS (
       SELECT 1 FROM public.driver_payout_reservations r
       WHERE r.payout_item_id = v_item.id AND r.status = 'ACTIVE'
     ) THEN
    RETURN jsonb_build_object(
      'ok', true, 'already_failed', true, 'idempotent', true,
      'payout_item_id', v_item.id, 'failure_code', v_code
    );
  END IF;

  -- Only a SUBMITTED item can be resolved here (never a draft/reserved/validated one).
  IF upper(btrim(COALESCE(v_item.status, ''))) <> 'SUBMITTED' THEN
    RETURN jsonb_build_object(
      'ok', false, 'error', 'ITEM_NOT_SUBMITTED', 'item_status', v_item.status
    );
  END IF;

  SELECT * INTO v_res
  FROM public.driver_payout_reservations
  WHERE payout_item_id = v_item.id
  ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, created_at DESC
  LIMIT 1;

  IF FOUND AND v_res.status = 'CONSUMED' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'RESERVATION_ALREADY_CONSUMED');
  END IF;

  IF FOUND AND v_res.status = 'ACTIVE' THEN
    -- Releases exactly this reservation (by id), nothing else.
    v_release := public.release_driver_payout_reservation(v_res.id, NULL, v_code);
    IF COALESCE((v_release ->> 'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'WEEKLY_PAYOUT_RELEASE_FAILED: %', v_release;
    END IF;
  END IF;

  UPDATE public.driver_payout_payment_intents
  SET execution_status = v_intent_exec,
      provider_state = v_state,
      provider_failure_code = v_code,
      last_provider_sync_at = v_now,
      completion_evidence_redacted = COALESCE(p_evidence_redacted, '{}'::jsonb),
      updated_at = v_now
  WHERE id = v_intent.id;

  UPDATE public.payout_items
  SET status = 'FAILED',
      execution_status = 'FAILED',
      failure_code = v_code,
      failure_reason = format('Revolut reported %s; weekly item failed by operator, reservation released', v_state),
      error_message = format('Revolut reported %s', v_state),
      failed_at = COALESCE(failed_at, v_now),
      provider_status = v_state,
      manual_review_required = false,
      manual_review_reason = 'WEEKLY_PAYOUT_PROVIDER_TERMINAL_FAILURE_RESOLVED:' || v_state,
      updated_at = v_now
  WHERE id = v_item.id;

  INSERT INTO public.payout_audit_log (
    driver_id, payout_type, event_type, requested_amount_pence, provider_error_code, metadata
  ) VALUES (
    v_item.driver_id,
    v_kind,
    'WEEKLY_PAYOUT_ITEM_PROVIDER_FAILED_RELEASED',
    v_item.amount_pence,
    v_code,
    jsonb_build_object(
      'payout_item_id', v_item.id,
      'batch_id', v_item.batch_id,
      'provider_payment_id', v_pay_id,
      'provider_state', v_state,
      'reservation_id', v_res.id,
      'released_pence', CASE WHEN v_release IS NULL THEN 0 ELSE v_res.amount_pence END,
      'actor_user_id', p_actor_user_id,
      'revolut_pay_called', false
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'failed', true,
    'payout_item_id', v_item.id,
    'failure_code', v_code,
    'reservation_released', v_release IS NOT NULL,
    'released_pence', CASE WHEN v_release IS NULL THEN 0 ELSE v_res.amount_pence END,
    'wallet_debited', false,
    'revolut_pay_called', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fail_submitted_weekly_payout_item(uuid, text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_submitted_weekly_payout_item(uuid, text, text, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_submitted_weekly_payout_item(uuid, text, text, jsonb, uuid) TO postgres;

COMMENT ON FUNCTION public.fail_submitted_weekly_payout_item(uuid, text, text, jsonb, uuid) IS
  'P7 M3: fails ONE SUBMITTED weekly payout item after provider terminal failure and releases ONE reservation. Never writes payout_batches or other items; never resends /pay.';
