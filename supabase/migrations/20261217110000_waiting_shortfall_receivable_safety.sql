-- HISTORY PARITY ONLY. Already applied on linked production.
-- Restored so local migration list matches remote. Do not re-apply via db push.
-- ============================================================
-- Waiting-time shortfall receivable safety
--
-- A partial capture after a declined increment leaves a shortfall that the
-- customer receivable SSOT recovers on the next booking. When that receivable
-- cannot be saved, the shortfall must still be durable and visible:
--
--   1. finance_shortfall_exceptions — one row per trip (idempotency key),
--      written through its own RPC, independent of the failed receivable write.
--   2. finance_resolve_shortfall_exception_receivable — closes the exception
--      once the receivable is recorded on a retry.
--   3. finance_write_off_shortfall_exception — finance-approved write-off
--      (ONECAB absorbs the shortfall). Refused while a receivable exists.
--   4. customer_receivable_release_reservations — refuses to reopen a debt
--      whose payment session capture already collected it (prevents a second
--      collection on a later booking). Settlement must clear it instead.
--
-- Driver entitlement, TEN, commission, Revolut increment and capture are not
-- touched. Forward-only. Do NOT apply without approval.
-- ============================================================

BEGIN;

-- ─── Table ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.finance_shortfall_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  trip_id uuid NOT NULL REFERENCES public.trips(id),
  -- No FKs below: the safety net must not fail on the same data that broke the receivable write.
  payment_session_id uuid NULL,
  provider_order_id text NULL,
  customer_id uuid NULL,
  currency text NOT NULL DEFAULT 'gbp',
  expected_fare_pence integer NOT NULL,
  captured_pence integer NOT NULL,
  shortfall_pence integer NOT NULL,
  failure_phase text NOT NULL,
  failure_message text NULL,
  status text NOT NULL DEFAULT 'OPEN',
  occurrence_count integer NOT NULL DEFAULT 1,
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at timestamptz NOT NULL DEFAULT now(),
  receivable_id uuid NULL REFERENCES public.customer_receivables(id),
  resolved_at timestamptz NULL,
  resolved_by uuid NULL,
  resolution_note text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_shortfall_exceptions_amounts_chk CHECK (
    expected_fare_pence >= 0
    AND captured_pence >= 0
    AND shortfall_pence > 0
    AND shortfall_pence <= expected_fare_pence
  ),
  CONSTRAINT finance_shortfall_exceptions_status_chk CHECK (
    status IN ('OPEN', 'RESOLVED_RECEIVABLE_RECORDED', 'WRITTEN_OFF')
  ),
  CONSTRAINT finance_shortfall_exceptions_resolved_chk CHECK (
    status = 'OPEN' OR resolved_at IS NOT NULL
  ),
  CONSTRAINT finance_shortfall_exceptions_receivable_chk CHECK (
    status <> 'RESOLVED_RECEIVABLE_RECORDED' OR receivable_id IS NOT NULL
  ),
  CONSTRAINT finance_shortfall_exceptions_write_off_chk CHECK (
    status <> 'WRITTEN_OFF'
    OR (resolved_by IS NOT NULL AND char_length(trim(coalesce(resolution_note, ''))) >= 10)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_shortfall_exceptions_idempotency_key_uidx
  ON public.finance_shortfall_exceptions (idempotency_key);

CREATE INDEX IF NOT EXISTS finance_shortfall_exceptions_open_idx
  ON public.finance_shortfall_exceptions (status, first_detected_at)
  WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS finance_shortfall_exceptions_trip_idx
  ON public.finance_shortfall_exceptions (trip_id);

COMMENT ON TABLE public.finance_shortfall_exceptions IS
  'Partial-capture shortfall whose customer receivable could not be saved. Written via finance_record_shortfall_exception only. Never mutates TEN / commission / payout.';

ALTER TABLE public.finance_shortfall_exceptions ENABLE ROW LEVEL SECURITY;
-- No authenticated policies: service_role edge functions and SECURITY DEFINER RPCs only.

-- ─── Write guard (GUC gate, same pattern as customer_receivables) ─

CREATE OR REPLACE FUNCTION public.require_finance_shortfall_exception_write_guc()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $trig$
BEGIN
  IF current_setting('onecab.allow_finance_shortfall_exception_write', true) = '1' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'direct_finance_shortfall_exception_mutation_denied'
    USING ERRCODE = '42501',
          HINT = 'Use finance_*_shortfall_exception SECURITY DEFINER RPCs';
END;
$trig$;

DROP TRIGGER IF EXISTS trg_guard_finance_shortfall_exception_insert ON public.finance_shortfall_exceptions;
CREATE TRIGGER trg_guard_finance_shortfall_exception_insert
  BEFORE INSERT ON public.finance_shortfall_exceptions
  FOR EACH ROW
  EXECUTE FUNCTION public.require_finance_shortfall_exception_write_guc();

DROP TRIGGER IF EXISTS trg_guard_finance_shortfall_exception_update ON public.finance_shortfall_exceptions;
CREATE TRIGGER trg_guard_finance_shortfall_exception_update
  BEFORE UPDATE ON public.finance_shortfall_exceptions
  FOR EACH ROW
  EXECUTE FUNCTION public.require_finance_shortfall_exception_write_guc();

CREATE OR REPLACE FUNCTION public.deny_finance_shortfall_exception_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $trig$
BEGIN
  RAISE EXCEPTION 'finance_shortfall_exceptions_delete_denied'
    USING ERRCODE = '42501',
          HINT = 'Resolve or write off; never delete';
END;
$trig$;

DROP TRIGGER IF EXISTS trg_deny_finance_shortfall_exception_delete ON public.finance_shortfall_exceptions;
CREATE TRIGGER trg_deny_finance_shortfall_exception_delete
  BEFORE DELETE ON public.finance_shortfall_exceptions
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_finance_shortfall_exception_delete();

-- Amounts and identity are immutable once recorded.
CREATE OR REPLACE FUNCTION public.freeze_finance_shortfall_exception_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $trig$
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
    OR NEW.expected_fare_pence IS DISTINCT FROM OLD.expected_fare_pence
    OR NEW.captured_pence IS DISTINCT FROM OLD.captured_pence
    OR NEW.shortfall_pence IS DISTINCT FROM OLD.shortfall_pence
  THEN
    RAISE EXCEPTION 'finance_shortfall_exception_evidence_immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'OPEN' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'finance_shortfall_exception_already_resolved' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$trig$;

DROP TRIGGER IF EXISTS trg_freeze_finance_shortfall_exception_evidence ON public.finance_shortfall_exceptions;
CREATE TRIGGER trg_freeze_finance_shortfall_exception_evidence
  BEFORE UPDATE ON public.finance_shortfall_exceptions
  FOR EACH ROW
  EXECUTE FUNCTION public.freeze_finance_shortfall_exception_evidence();

-- ─── RPC: record (idempotent) ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.finance_record_shortfall_exception(
  p_idempotency_key text,
  p_trip_id uuid,
  p_payment_session_id uuid,
  p_provider_order_id text,
  p_customer_id uuid,
  p_currency text,
  p_expected_fare_pence integer,
  p_captured_pence integer,
  p_shortfall_pence integer,
  p_failure_phase text,
  p_failure_message text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_id uuid;
  v_status text;
  v_shortfall integer;
  v_occurrences integer;
  v_created boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF coalesce(trim(p_idempotency_key), '') = '' THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;
  IF p_trip_id IS NULL THEN
    RAISE EXCEPTION 'trip_id_required' USING ERRCODE = '22023';
  END IF;
  IF p_shortfall_pence IS NULL OR p_shortfall_pence <= 0 THEN
    RAISE EXCEPTION 'positive_shortfall_required' USING ERRCODE = '22023';
  END IF;
  IF coalesce(trim(p_failure_phase), '') = '' THEN
    RAISE EXCEPTION 'failure_phase_required' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('onecab.allow_finance_shortfall_exception_write', '1', true);

  INSERT INTO public.finance_shortfall_exceptions AS fse (
    idempotency_key, trip_id, payment_session_id, provider_order_id, customer_id,
    currency, expected_fare_pence, captured_pence, shortfall_pence,
    failure_phase, failure_message, metadata
  ) VALUES (
    p_idempotency_key, p_trip_id, p_payment_session_id, nullif(trim(coalesce(p_provider_order_id, '')), ''),
    p_customer_id, lower(coalesce(nullif(trim(p_currency), ''), 'gbp')),
    greatest(coalesce(p_expected_fare_pence, 0), 0), greatest(coalesce(p_captured_pence, 0), 0),
    p_shortfall_pence, upper(trim(p_failure_phase)), left(p_failure_message, 1000),
    coalesce(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (idempotency_key) DO UPDATE
    SET occurrence_count = fse.occurrence_count + 1,
        last_detected_at = now(),
        failure_message = coalesce(left(EXCLUDED.failure_message, 1000), fse.failure_message),
        updated_at = now()
  RETURNING fse.id, fse.status, fse.shortfall_pence, fse.occurrence_count, (fse.xmax = 0)
  INTO v_id, v_status, v_shortfall, v_occurrences, v_created;

  RETURN jsonb_build_object(
    'ok', true,
    'created', v_created,
    'exception_id', v_id,
    'status', v_status,
    'shortfall_pence', v_shortfall,
    'occurrence_count', v_occurrences,
    'amount_matches', v_shortfall = p_shortfall_pence
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.finance_record_shortfall_exception(
  text, uuid, uuid, text, uuid, text, integer, integer, integer, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finance_record_shortfall_exception(
  text, uuid, uuid, text, uuid, text, integer, integer, integer, text, text, jsonb
) TO service_role;

-- ─── RPC: resolve once the receivable exists ──────────────────

CREATE OR REPLACE FUNCTION public.finance_resolve_shortfall_exception_receivable(
  p_trip_id uuid,
  p_receivable_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_trip_id IS NULL OR p_receivable_id IS NULL THEN
    RAISE EXCEPTION 'trip_and_receivable_required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.customer_receivables r
    WHERE r.id = p_receivable_id AND r.source_trip_id = p_trip_id
  ) THEN
    RAISE EXCEPTION 'receivable_trip_mismatch' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('onecab.allow_finance_shortfall_exception_write', '1', true);

  UPDATE public.finance_shortfall_exceptions
  SET status = 'RESOLVED_RECEIVABLE_RECORDED',
      receivable_id = p_receivable_id,
      resolved_at = now(),
      resolution_note = 'Customer receivable recorded on retry',
      updated_at = now()
  WHERE trip_id = p_trip_id
    AND status = 'OPEN';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'resolved', v_count);
END;
$fn$;

REVOKE ALL ON FUNCTION public.finance_resolve_shortfall_exception_receivable(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finance_resolve_shortfall_exception_receivable(uuid, uuid)
  TO service_role;

-- ─── RPC: approved write-off (finance access, named approver) ─

CREATE OR REPLACE FUNCTION public.finance_write_off_shortfall_exception(
  p_exception_id uuid,
  p_note text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_row public.finance_shortfall_exceptions%ROWTYPE;
BEGIN
  PERFORM public.assert_finance_payout_ledger_access();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'approver_required' USING ERRCODE = '42501';
  END IF;
  IF char_length(trim(coalesce(p_note, ''))) < 10 THEN
    RAISE EXCEPTION 'write_off_note_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
  FROM public.finance_shortfall_exceptions
  WHERE id = p_exception_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exception_not_found' USING ERRCODE = '22023';
  END IF;
  IF v_row.status <> 'OPEN' THEN
    RAISE EXCEPTION 'exception_not_open' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.customer_receivables r
    WHERE r.source_trip_id = v_row.trip_id AND r.status <> 'WAIVED'
  ) THEN
    RAISE EXCEPTION 'receivable_exists_resolve_instead' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('onecab.allow_finance_shortfall_exception_write', '1', true);

  UPDATE public.finance_shortfall_exceptions
  SET status = 'WRITTEN_OFF',
      resolved_at = now(),
      resolved_by = v_actor,
      resolution_note = trim(p_note),
      updated_at = now()
  WHERE id = p_exception_id;

  INSERT INTO public.audit_logs (event_type, user_id, trip_id, details, created_at)
  VALUES (
    'FINANCE_SHORTFALL_WRITTEN_OFF',
    v_actor,
    v_row.trip_id,
    jsonb_build_object(
      'exception_id', v_row.id,
      'shortfall_pence', v_row.shortfall_pence,
      'currency', v_row.currency,
      'note', trim(p_note),
      'money_moved', false
    ),
    now()
  );

  RETURN jsonb_build_object('ok', true, 'exception_id', v_row.id, 'written_off_pence', v_row.shortfall_pence);
END;
$fn$;

REVOKE ALL ON FUNCTION public.finance_write_off_shortfall_exception(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_write_off_shortfall_exception(uuid, text)
  TO authenticated, service_role;

-- ─── Release guard: never reopen a debt the capture already collected ─
-- Identical to 20261127150000 except for the v_debt_captured refusal.

CREATE OR REPLACE FUNCTION public.customer_receivable_release_reservations(
  p_payment_session_id uuid,
  p_reason text DEFAULT 'session_cancelled'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_alloc record;
  v_released integer := 0;
  v_refused integer := 0;
  v_debt_captured boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_payment_session_id IS NULL THEN
    RAISE EXCEPTION 'payment_session_id_required' USING ERRCODE = '22023';
  END IF;

  -- Capture beyond the frozen fare + tip components means the reserved debt was collected.
  SELECT coalesce(ps.receivable_component_pence, 0) > 0
         AND coalesce(ps.captured_amount_pence, 0)
             > coalesce(ps.trip_fare_component_pence, 0) + coalesce(ps.tip_component_pence, 0)
  INTO v_debt_captured
  FROM public.payment_sessions ps
  WHERE ps.id = p_payment_session_id;
  v_debt_captured := coalesce(v_debt_captured, false);

  PERFORM set_config('onecab.allow_customer_receivable_write', '1', true);

  FOR v_alloc IN
    SELECT a.*
    FROM public.payment_session_receivable_allocations a
    WHERE a.payment_session_id = p_payment_session_id
      AND a.status = 'RESERVED'
    FOR UPDATE
  LOOP
    IF v_debt_captured THEN
      INSERT INTO public.customer_receivable_events (
        receivable_id, event_type, amount_pence, payment_session_id, actor_role, note, metadata
      ) VALUES (
        v_alloc.receivable_id,
        'MANUAL_REVIEW',
        0,
        p_payment_session_id,
        'system',
        'Release refused — capture already collected this debt; settle instead',
        jsonb_build_object('reason', p_reason, 'release_refused', 'debt_captured')
      );
      v_refused := v_refused + 1;
      CONTINUE;
    END IF;

    UPDATE public.payment_session_receivable_allocations
    SET
      status = 'RELEASED',
      released_at = now(),
      updated_at = now(),
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('release_reason', p_reason)
    WHERE id = v_alloc.id
      AND status = 'RESERVED';

    UPDATE public.customer_receivables
    SET
      status = 'OPEN',
      reserved_payment_session_id = NULL,
      updated_at = now()
    WHERE id = v_alloc.receivable_id
      AND status = 'RESERVED';

    INSERT INTO public.customer_receivable_events (
      receivable_id, event_type, amount_pence, payment_session_id, actor_role, note, metadata
    ) VALUES (
      v_alloc.receivable_id,
      'RELEASED',
      v_alloc.allocated_amount_pence,
      p_payment_session_id,
      'system',
      'Reservation released — receivable reopened',
      jsonb_build_object('reason', p_reason)
    );

    v_released := v_released + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'released', v_released, 'refused_debt_captured', v_refused);
END;
$fn$;

REVOKE ALL ON FUNCTION public.customer_receivable_release_reservations(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_receivable_release_reservations(uuid, text)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_receivable_release_reservations(uuid, text)
  TO service_role;

COMMIT;
