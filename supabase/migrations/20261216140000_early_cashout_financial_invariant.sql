-- ============================================================
-- Early cash-out financial invariant (database-level SSOT)
--
--   gross wallet consumption = net Revolut transfer + ONECAB cash-out fee
--
-- 1) payout_items guard: an EARLY_CASHOUT item can never exist (outside a
--    failed/cancelled state) with gross <> net + fee, net <= 0 or fee < 0, and its
--    amounts are frozen once a provider payment intent exists. Fails closed before
--    reservation and before any Revolut call.
-- 2) Completion constraint (deferred to COMMIT): an EARLY_CASHOUT item can only be
--    COMPLETED when the ledger holds exactly net (EARLY_CASHOUT) + fee (one
--    CASHOUT_FEE row) for its provider payment. No path can complete a cash-out and
--    leave the fee as a driver balance.
-- 3) fail_submitted_early_cashout: provider-terminal failure (failed / declined /
--    rejected / reverted / cancelled / revoked) of a submitted, never-applied cash-out
--    releases the gross reservation and fails the item. Never touches an applied one.
-- 4) early_cashout_invariant_audit: read-only reconciliation view.
--
-- Early cash-out batches are one item each; nothing here reads or depends on weekly
-- batch status.
-- ============================================================

-- ---------------------------------------------------------------------------
-- 1) Amount guard on payout_items
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payout_item_early_cashout_fee_pence(p_snapshot jsonb)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN btrim(COALESCE(p_snapshot ->> 'withdrawal_fee_pence', ''), ' "') ~ '^-?[0-9]+$'
      THEN btrim(p_snapshot ->> 'withdrawal_fee_pence', ' "')::bigint
    ELSE 0
  END;
$function$;

REVOKE ALL ON FUNCTION public.payout_item_early_cashout_fee_pence(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payout_item_early_cashout_fee_pence(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.payout_item_early_cashout_fee_pence(jsonb) TO postgres;

CREATE OR REPLACE FUNCTION public.enforce_early_cashout_amount_invariant()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_kind text;
  v_status text := upper(btrim(COALESCE(NEW.status, '')));
  v_gross bigint := COALESCE(NEW.amount_pence, 0);
  v_fee bigint := public.payout_item_early_cashout_fee_pence(NEW.eligibility_snapshot);
  v_net bigint := COALESCE(NEW.net_driver_payout_pence, NEW.amount_pence);
BEGIN
  SELECT kind INTO v_kind FROM public.payout_batches WHERE id = NEW.batch_id;
  IF v_kind IS DISTINCT FROM 'EARLY_CASHOUT' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       NEW.amount_pence IS DISTINCT FROM OLD.amount_pence
       OR NEW.net_driver_payout_pence IS DISTINCT FROM OLD.net_driver_payout_pence
       OR public.payout_item_early_cashout_fee_pence(NEW.eligibility_snapshot)
          IS DISTINCT FROM public.payout_item_early_cashout_fee_pence(OLD.eligibility_snapshot)
     )
     AND EXISTS (
       SELECT 1 FROM public.driver_payout_payment_intents i WHERE i.payout_item_id = NEW.id
     ) THEN
    RAISE EXCEPTION 'EARLY_CASHOUT_INVARIANT_VIOLATION: amounts are frozen once submitted (item %)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- A failing / cancelling item must always be allowed to reach its terminal state.
  IF v_status IN ('FAILED', 'CANCELLED', 'DECLINED', 'RELEASED', 'INELIGIBLE', 'INVALID_ORPHANED')
     OR lower(v_status) = 'failed' THEN
    RETURN NEW;
  END IF;

  IF v_fee < 0 OR v_net <= 0 OR v_gross <> v_net + v_fee THEN
    RAISE EXCEPTION
      'EARLY_CASHOUT_INVARIANT_VIOLATION: gross % <> net % + fee % (item %)',
      v_gross, v_net, v_fee, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_early_cashout_amount_invariant() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_enforce_early_cashout_amount_invariant ON public.payout_items;
CREATE TRIGGER trg_enforce_early_cashout_amount_invariant
  BEFORE INSERT OR UPDATE OF amount_pence, net_driver_payout_pence, eligibility_snapshot, status, batch_id
  ON public.payout_items
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_early_cashout_amount_invariant();

-- ---------------------------------------------------------------------------
-- 2) Completion constraint (checked at COMMIT)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_early_cashout_completion_invariant()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_kind text;
  v_item public.payout_items%ROWTYPE;
  v_pay_id text;
  v_fee bigint;
  v_net bigint;
  v_debit bigint;
  v_fee_sum bigint;
  v_fee_rows integer;
  v_expected_fee_rows integer;
BEGIN
  SELECT * INTO v_item FROM public.payout_items WHERE id = NEW.id;
  IF NOT FOUND OR upper(btrim(COALESCE(v_item.status, ''))) <> 'COMPLETED' THEN
    RETURN NULL;
  END IF;

  SELECT kind INTO v_kind FROM public.payout_batches WHERE id = v_item.batch_id;
  IF v_kind IS DISTINCT FROM 'EARLY_CASHOUT' THEN
    RETURN NULL;
  END IF;

  SELECT i.provider_payment_id INTO v_pay_id
  FROM public.driver_payout_payment_intents i
  WHERE i.payout_item_id = v_item.id
    AND i.provider_payment_id IS NOT NULL
  ORDER BY (i.financially_applied_at IS NOT NULL) DESC, i.updated_at DESC
  LIMIT 1;

  IF v_pay_id IS NULL THEN
    RAISE EXCEPTION 'EARLY_CASHOUT_INVARIANT_VIOLATION: completed without provider payment (item %)', v_item.id
      USING ERRCODE = 'check_violation';
  END IF;

  v_fee := public.payout_item_early_cashout_fee_pence(v_item.eligibility_snapshot);
  v_net := COALESCE(v_item.net_driver_payout_pence, v_item.amount_pence);

  SELECT COALESCE(SUM(l.amount_pence), 0)
    INTO v_debit
  FROM public.driver_wallet_ledger l
  WHERE l.driver_id = v_item.driver_id
    AND l.provider_payout_id = v_pay_id
    AND l.type = 'EARLY_CASHOUT';

  SELECT COALESCE(SUM(l.amount_pence), 0), count(*)
    INTO v_fee_sum, v_fee_rows
  FROM public.driver_wallet_ledger l
  WHERE l.driver_id = v_item.driver_id
    AND l.provider_payout_id = v_pay_id
    AND l.type = 'CASHOUT_FEE';

  v_expected_fee_rows := (v_fee > 0)::integer;

  IF v_net + v_fee <> v_item.amount_pence
     OR v_debit <> -v_net
     OR v_fee_sum <> -v_fee
     OR v_fee_rows <> v_expected_fee_rows THEN
    RAISE EXCEPTION
      'EARLY_CASHOUT_INVARIANT_VIOLATION: item % gross % net % fee % ledger debit % fee % (% rows)',
      v_item.id, v_item.amount_pence, v_net, v_fee, v_debit, v_fee_sum, v_fee_rows
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_early_cashout_completion_invariant() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_assert_early_cashout_completion_invariant ON public.payout_items;
CREATE CONSTRAINT TRIGGER trg_assert_early_cashout_completion_invariant
  AFTER UPDATE OF status ON public.payout_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (upper(btrim(COALESCE(NEW.status, ''))) = 'COMPLETED'
        AND upper(btrim(COALESCE(OLD.status, ''))) IS DISTINCT FROM 'COMPLETED')
  EXECUTE FUNCTION public.assert_early_cashout_completion_invariant();

-- ---------------------------------------------------------------------------
-- 3) Provider-terminal failure: release the gross reservation, fail the item
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fail_submitted_early_cashout(
  p_payout_item_id uuid,
  p_provider_payment_id text,
  p_provider_state text,
  p_evidence_redacted jsonb DEFAULT '{}'::jsonb
)
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
  v_state text := lower(btrim(COALESCE(p_provider_state, '')));
  v_pay_id text := NULLIF(btrim(COALESCE(p_provider_payment_id, '')), '');
  v_code text;
  v_intent_exec text;
  v_release jsonb := NULL;
  v_now timestamptz := now();
BEGIN
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

  SELECT * INTO v_item FROM public.payout_items WHERE id = p_payout_item_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PAYOUT_ITEM_NOT_FOUND');
  END IF;

  SELECT * INTO v_batch FROM public.payout_batches WHERE id = v_item.batch_id FOR UPDATE;
  IF NOT FOUND OR v_batch.kind IS DISTINCT FROM 'EARLY_CASHOUT' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_EARLY_CASHOUT');
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
         AND l.type IN ('EARLY_CASHOUT', 'CASHOUT_FEE')
     ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'ALREADY_APPLIED_REQUIRES_REVERSAL_REVIEW',
      'payout_item_id', v_item.id
    );
  END IF;

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

  SELECT * INTO v_res
  FROM public.driver_payout_reservations
  WHERE payout_item_id = v_item.id
  ORDER BY CASE WHEN status = 'ACTIVE' THEN 0 ELSE 1 END, created_at DESC
  LIMIT 1;

  IF FOUND AND v_res.status = 'CONSUMED' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'RESERVATION_ALREADY_CONSUMED');
  END IF;

  IF FOUND AND v_res.status = 'ACTIVE' THEN
    v_release := public.release_driver_payout_reservation(v_res.id, NULL, v_code);
    IF COALESCE((v_release ->> 'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'EARLY_CASHOUT_RELEASE_FAILED: %', v_release;
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
      failure_reason = format('Revolut reported %s; reservation released', v_state),
      error_message = format('Revolut reported %s', v_state),
      failed_at = COALESCE(failed_at, v_now),
      updated_at = v_now
  WHERE id = v_item.id;

  UPDATE public.payout_batches
  SET status = 'FAILED',
      failure_code = v_code,
      failure_reason = format('Revolut reported %s', v_state),
      failed_at = COALESCE(failed_at, v_now),
      updated_at = v_now
  WHERE id = v_batch.id
    AND status IS DISTINCT FROM 'COMPLETED';

  INSERT INTO public.payout_audit_log (
    driver_id, payout_type, event_type, requested_amount_pence, provider_error_code, metadata
  ) VALUES (
    v_item.driver_id,
    'EARLY_CASHOUT',
    'EARLY_CASHOUT_PROVIDER_FAILED_RELEASED',
    v_item.amount_pence,
    v_code,
    jsonb_build_object(
      'payout_item_id', v_item.id,
      'provider_payment_id', v_pay_id,
      'provider_state', v_state,
      'reservation_id', v_res.id,
      'released_pence', CASE WHEN v_release IS NULL THEN 0 ELSE v_res.amount_pence END
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'failed', true,
    'payout_item_id', v_item.id,
    'failure_code', v_code,
    'reservation_released', v_release IS NOT NULL,
    'released_pence', CASE WHEN v_release IS NULL THEN 0 ELSE v_res.amount_pence END,
    'wallet_debited', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fail_submitted_early_cashout(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_submitted_early_cashout(uuid, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_submitted_early_cashout(uuid, text, text, jsonb) TO postgres;

-- ---------------------------------------------------------------------------
-- 4) Reconciliation view (read-only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.early_cashout_invariant_audit
WITH (security_invoker = true) AS
SELECT
  pi.id AS payout_item_id,
  pi.driver_id,
  pi.completed_at,
  i.provider_payment_id,
  pi.amount_pence::bigint AS gross_wallet_consumed_pence,
  COALESCE(pi.net_driver_payout_pence, pi.amount_pence)::bigint AS net_transfer_pence,
  public.payout_item_early_cashout_fee_pence(pi.eligibility_snapshot) AS fee_pence,
  COALESCE(led.debit_pence, 0) AS ledger_debit_pence,
  COALESCE(led.fee_ledger_pence, 0) AS ledger_fee_pence,
  COALESCE(led.fee_rows, 0) AS ledger_fee_rows,
  (
    COALESCE(pi.net_driver_payout_pence, pi.amount_pence)
      + public.payout_item_early_cashout_fee_pence(pi.eligibility_snapshot) = pi.amount_pence
    AND COALESCE(led.debit_pence, 0) = -COALESCE(pi.net_driver_payout_pence, pi.amount_pence)
    AND COALESCE(led.fee_ledger_pence, 0) = -public.payout_item_early_cashout_fee_pence(pi.eligibility_snapshot)
    AND COALESCE(led.fee_rows, 0) = CASE
      WHEN public.payout_item_early_cashout_fee_pence(pi.eligibility_snapshot) > 0 THEN 1 ELSE 0 END
  ) AS invariant_holds
FROM public.payout_items pi
JOIN public.payout_batches pb ON pb.id = pi.batch_id AND pb.kind = 'EARLY_CASHOUT'
JOIN public.driver_payout_payment_intents i
  ON i.payout_item_id = pi.id AND i.financially_applied_at IS NOT NULL
LEFT JOIN LATERAL (
  SELECT
    SUM(l.amount_pence) FILTER (WHERE l.type = 'EARLY_CASHOUT')::bigint AS debit_pence,
    SUM(l.amount_pence) FILTER (WHERE l.type = 'CASHOUT_FEE')::bigint AS fee_ledger_pence,
    count(*) FILTER (WHERE l.type = 'CASHOUT_FEE')::integer AS fee_rows
  FROM public.driver_wallet_ledger l
  WHERE l.driver_id = pi.driver_id
    AND l.provider_payout_id = i.provider_payment_id
) led ON true
WHERE upper(pi.status) = 'COMPLETED';

REVOKE ALL ON public.early_cashout_invariant_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.early_cashout_invariant_audit TO service_role;
GRANT SELECT ON public.early_cashout_invariant_audit TO postgres;
