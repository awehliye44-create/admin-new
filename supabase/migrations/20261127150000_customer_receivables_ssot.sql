-- ============================================================
-- Customer Receivable SSOT
-- Lifecycle:
--   DECLINED ADDITIONAL AUTHORISATION
--   → customer_receivables (OPEN)
--   → RESERVE FOR NEXT BOOKING (before Revolut preauth)
--   → FOLD INTO NEXT PREAUTHORISATION
--   → PROVIDER-CONFIRMED CAPTURE (COMPLETED/CAPTURED + amount)
--   → CLEAR RECEIVABLE EXACTLY ONCE (SETTLED / partial reopen)
--
-- Partial capture allocation order (canonical):
--   1) historical receivables first (created_at ASC)
--   2) current trip fare second
-- Example: reserved debt 36, captured 20 → settle 20 of receivables,
--   leave 16 OPEN, trip fare gets 0.
--
-- Never creates standalone Revolut payments for micro shortfalls.
-- Does not mutate driver wallet / TEN / commission / payout.
-- Forward-only. Do NOT apply unless explicitly approved.
-- ============================================================

BEGIN;

-- ─── Tables ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.customer_receivables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  currency text NOT NULL DEFAULT 'gbp',
  source_trip_id uuid NOT NULL REFERENCES public.trips(id),
  source_payment_session_id uuid NULL REFERENCES public.payment_sessions(id),
  source_authorisation_id text NULL,
  source_type text NOT NULL,
  reason_code text NOT NULL,
  original_amount_pence integer NOT NULL,
  outstanding_amount_pence integer NOT NULL,
  status text NOT NULL,
  idempotency_key text NOT NULL,
  reserved_payment_session_id uuid NULL REFERENCES public.payment_sessions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz NULL,
  waived_at timestamptz NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT customer_receivables_source_type_chk CHECK (
    source_type IN (
      'DECLINED_INCREMENTAL_AUTHORISATION',
      'CAPTURE_SHORTFALL',
      'MANUAL'
    )
  ),
  CONSTRAINT customer_receivables_reason_code_chk CHECK (
    char_length(trim(reason_code)) > 0
  ),
  CONSTRAINT customer_receivables_status_chk CHECK (
    status IN ('OPEN', 'RESERVED', 'SETTLED', 'WAIVED', 'MANUAL_REVIEW')
  ),
  CONSTRAINT customer_receivables_original_positive_chk CHECK (
    original_amount_pence > 0
  ),
  CONSTRAINT customer_receivables_outstanding_nonneg_chk CHECK (
    outstanding_amount_pence >= 0
  ),
  CONSTRAINT customer_receivables_outstanding_lte_original_chk CHECK (
    outstanding_amount_pence <= original_amount_pence
  ),
  CONSTRAINT customer_receivables_settled_invariant_chk CHECK (
    status <> 'SETTLED'
    OR (outstanding_amount_pence = 0 AND settled_at IS NOT NULL)
  ),
  CONSTRAINT customer_receivables_waived_invariant_chk CHECK (
    status <> 'WAIVED'
    OR (outstanding_amount_pence = 0 AND waived_at IS NOT NULL)
  ),
  CONSTRAINT customer_receivables_open_outstanding_chk CHECK (
    status NOT IN ('OPEN', 'RESERVED', 'MANUAL_REVIEW')
    OR outstanding_amount_pence > 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_receivables_idempotency_key_uidx
  ON public.customer_receivables (idempotency_key);

-- One active OPEN/RESERVED per (source_trip_id, source_type, reason_code).
CREATE UNIQUE INDEX IF NOT EXISTS customer_receivables_one_active_open_reserved_uidx
  ON public.customer_receivables (source_trip_id, source_type, reason_code)
  WHERE status IN ('OPEN', 'RESERVED');

CREATE INDEX IF NOT EXISTS customer_receivables_customer_open_idx
  ON public.customer_receivables (customer_id, status, created_at)
  WHERE status IN ('OPEN', 'RESERVED');

CREATE INDEX IF NOT EXISTS customer_receivables_source_trip_idx
  ON public.customer_receivables (source_trip_id);

CREATE TABLE IF NOT EXISTS public.customer_receivable_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receivable_id uuid NOT NULL REFERENCES public.customer_receivables(id),
  event_type text NOT NULL,
  amount_pence integer NOT NULL DEFAULT 0,
  payment_session_id uuid NULL REFERENCES public.payment_sessions(id),
  trip_id uuid NULL REFERENCES public.trips(id),
  actor_role text NOT NULL DEFAULT 'system',
  note text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_receivable_events_type_chk CHECK (
    event_type IN (
      'CREATED',
      'RESERVED',
      'RELEASED',
      'SETTLED',
      'WAIVED',
      'MANUAL_REVIEW',
      'AMOUNT_ADJUSTED',
      'PARTIAL_SETTLED'
    )
  ),
  CONSTRAINT customer_receivable_events_amount_nonneg_chk CHECK (
    amount_pence >= 0
  )
);

CREATE INDEX IF NOT EXISTS customer_receivable_events_receivable_idx
  ON public.customer_receivable_events (receivable_id, created_at);

CREATE TABLE IF NOT EXISTS public.payment_session_receivable_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_session_id uuid NOT NULL REFERENCES public.payment_sessions(id),
  receivable_id uuid NOT NULL REFERENCES public.customer_receivables(id),
  recovery_trip_id uuid NULL REFERENCES public.trips(id),
  allocated_amount_pence integer NOT NULL,
  settled_amount_pence integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  captured_at timestamptz NULL,
  released_at timestamptz NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT payment_session_receivable_allocations_amount_positive_chk CHECK (
    allocated_amount_pence > 0
  ),
  CONSTRAINT payment_session_receivable_allocations_settled_nonneg_chk CHECK (
    settled_amount_pence >= 0
  ),
  CONSTRAINT payment_session_receivable_allocations_settled_lte_alloc_chk CHECK (
    settled_amount_pence <= allocated_amount_pence
  ),
  CONSTRAINT payment_session_receivable_allocations_status_chk CHECK (
    status IN ('RESERVED', 'CAPTURED', 'RELEASED', 'PARTIAL')
  ),
  CONSTRAINT payment_session_receivable_allocations_captured_chk CHECK (
    status NOT IN ('CAPTURED', 'PARTIAL')
    OR (captured_at IS NOT NULL)
  ),
  CONSTRAINT payment_session_receivable_allocations_released_chk CHECK (
    status <> 'RELEASED'
    OR (released_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_session_receivable_allocations_session_recv_uidx
  ON public.payment_session_receivable_allocations (payment_session_id, receivable_id);

CREATE UNIQUE INDEX IF NOT EXISTS payment_session_receivable_allocations_one_active_recv_uidx
  ON public.payment_session_receivable_allocations (receivable_id)
  WHERE status = 'RESERVED';

CREATE INDEX IF NOT EXISTS payment_session_receivable_allocations_session_idx
  ON public.payment_session_receivable_allocations (payment_session_id, status);

COMMENT ON TABLE public.customer_receivables IS
  'Customer debt from declined incremental auth / capture shortfall. Recover via next-booking preauth fold only — never standalone micro Revolut charges. Policy A: no TEN/commission/payout mutation.';
COMMENT ON TABLE public.customer_receivable_events IS
  'Append-only audit trail for customer_receivables lifecycle.';
COMMENT ON TABLE public.payment_session_receivable_allocations IS
  'Links OPEN receivables reserved into a next-booking payment session. Partial capture: historical receivables first, then current trip fare.';

-- ─── RLS ──────────────────────────────────────────────────────

ALTER TABLE public.customer_receivables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_receivable_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_session_receivable_allocations ENABLE ROW LEVEL SECURITY;

-- No authenticated INSERT/UPDATE/DELETE. SELECT own via policy + list RPC.
DROP POLICY IF EXISTS customer_receivables_select_own ON public.customer_receivables;
CREATE POLICY customer_receivables_select_own
  ON public.customer_receivables
  FOR SELECT
  TO authenticated
  USING (
    customer_id IN (
      SELECT c.id FROM public.customers c WHERE c.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS customer_receivable_events_select_own ON public.customer_receivable_events;
CREATE POLICY customer_receivable_events_select_own
  ON public.customer_receivable_events
  FOR SELECT
  TO authenticated
  USING (
    receivable_id IN (
      SELECT r.id
      FROM public.customer_receivables r
      JOIN public.customers c ON c.id = r.customer_id
      WHERE c.user_id = auth.uid()
    )
  );

-- Allocations: no authenticated policies (service_role / RPCs only).

-- ─── Mutation deny triggers (GUC gate) ────────────────────────

CREATE OR REPLACE FUNCTION public.deny_direct_customer_receivable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $trig$
BEGIN
  IF current_setting('onecab.allow_customer_receivable_write', true) = '1' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'direct_customer_receivable_mutation_denied'
    USING ERRCODE = '42501',
          HINT = 'Use customer_receivable_* SECURITY DEFINER RPCs';
END;
$trig$;

DROP TRIGGER IF EXISTS trg_deny_customer_receivable_update ON public.customer_receivables;
CREATE TRIGGER trg_deny_customer_receivable_update
  BEFORE UPDATE ON public.customer_receivables
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_direct_customer_receivable_mutation();

DROP TRIGGER IF EXISTS trg_deny_customer_receivable_delete ON public.customer_receivables;
CREATE TRIGGER trg_deny_customer_receivable_delete
  BEFORE DELETE ON public.customer_receivables
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_direct_customer_receivable_mutation();

CREATE OR REPLACE FUNCTION public.deny_customer_receivable_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $trig$
BEGIN
  RAISE EXCEPTION 'customer_receivable_events_append_only'
    USING ERRCODE = '42501',
          HINT = 'customer_receivable_events allows INSERT only';
END;
$trig$;

DROP TRIGGER IF EXISTS trg_deny_customer_receivable_event_update ON public.customer_receivable_events;
CREATE TRIGGER trg_deny_customer_receivable_event_update
  BEFORE UPDATE ON public.customer_receivable_events
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_customer_receivable_event_mutation();

DROP TRIGGER IF EXISTS trg_deny_customer_receivable_event_delete ON public.customer_receivable_events;
CREATE TRIGGER trg_deny_customer_receivable_event_delete
  BEFORE DELETE ON public.customer_receivable_events
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_customer_receivable_event_mutation();

CREATE OR REPLACE FUNCTION public.deny_direct_receivable_allocation_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $trig$
BEGIN
  IF current_setting('onecab.allow_customer_receivable_write', true) = '1' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'direct_receivable_allocation_mutation_denied'
    USING ERRCODE = '42501',
          HINT = 'Use customer_receivable_* SECURITY DEFINER RPCs';
END;
$trig$;

DROP TRIGGER IF EXISTS trg_deny_receivable_allocation_update ON public.payment_session_receivable_allocations;
CREATE TRIGGER trg_deny_receivable_allocation_update
  BEFORE UPDATE ON public.payment_session_receivable_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_direct_receivable_allocation_mutation();

DROP TRIGGER IF EXISTS trg_deny_receivable_allocation_delete ON public.payment_session_receivable_allocations;
CREATE TRIGGER trg_deny_receivable_allocation_delete
  BEFORE DELETE ON public.payment_session_receivable_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_direct_receivable_allocation_mutation();

-- Inserts into receivables / allocations also require GUC (RPCs set it).
CREATE OR REPLACE FUNCTION public.require_customer_receivable_write_guc()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $trig$
BEGIN
  IF current_setting('onecab.allow_customer_receivable_write', true) = '1' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'direct_customer_receivable_insert_denied'
    USING ERRCODE = '42501',
          HINT = 'Use customer_receivable_* SECURITY DEFINER RPCs';
END;
$trig$;

DROP TRIGGER IF EXISTS trg_require_guc_customer_receivable_insert ON public.customer_receivables;
CREATE TRIGGER trg_require_guc_customer_receivable_insert
  BEFORE INSERT ON public.customer_receivables
  FOR EACH ROW
  EXECUTE FUNCTION public.require_customer_receivable_write_guc();

DROP TRIGGER IF EXISTS trg_require_guc_allocation_insert ON public.payment_session_receivable_allocations;
CREATE TRIGGER trg_require_guc_allocation_insert
  BEFORE INSERT ON public.payment_session_receivable_allocations
  FOR EACH ROW
  EXECUTE FUNCTION public.require_customer_receivable_write_guc();

-- Events INSERT allowed only with GUC (RPCs); UPDATE/DELETE already denied.
DROP TRIGGER IF EXISTS trg_require_guc_receivable_event_insert ON public.customer_receivable_events;
CREATE TRIGGER trg_require_guc_receivable_event_insert
  BEFORE INSERT ON public.customer_receivable_events
  FOR EACH ROW
  EXECUTE FUNCTION public.require_customer_receivable_write_guc();

-- ─── RPC: record declined increment ───────────────────────────

CREATE OR REPLACE FUNCTION public.customer_receivable_record_declined_increment(
  p_customer_id uuid,
  p_source_trip_id uuid,
  p_source_payment_session_id uuid,
  p_source_authorisation_id text,
  p_source_type text,
  p_reason_code text,
  p_original_amount_pence integer,
  p_currency text,
  p_idempotency_key text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_existing public.customer_receivables%ROWTYPE;
  v_row public.customer_receivables%ROWTYPE;
  v_created boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_customer_id IS NULL OR p_source_trip_id IS NULL THEN
    RAISE EXCEPTION 'customer_and_trip_required' USING ERRCODE = '22023';
  END IF;
  IF p_original_amount_pence IS NULL OR p_original_amount_pence <= 0 THEN
    RAISE EXCEPTION 'positive_amount_required' USING ERRCODE = '22023';
  END IF;
  IF coalesce(trim(p_idempotency_key), '') = '' THEN
    RAISE EXCEPTION 'idempotency_key_required' USING ERRCODE = '22023';
  END IF;
  IF coalesce(trim(p_source_type), '') = '' OR coalesce(trim(p_reason_code), '') = '' THEN
    RAISE EXCEPTION 'source_type_and_reason_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
  FROM public.customer_receivables
  WHERE idempotency_key = p_idempotency_key
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'created', false,
      'receivable_id', v_existing.id,
      'status', v_existing.status,
      'outstanding_amount_pence', v_existing.outstanding_amount_pence
    );
  END IF;

  PERFORM set_config('onecab.allow_customer_receivable_write', '1', true);

  INSERT INTO public.customer_receivables (
    customer_id,
    currency,
    source_trip_id,
    source_payment_session_id,
    source_authorisation_id,
    source_type,
    reason_code,
    original_amount_pence,
    outstanding_amount_pence,
    status,
    idempotency_key,
    metadata
  ) VALUES (
    p_customer_id,
    lower(coalesce(nullif(trim(p_currency), ''), 'gbp')),
    p_source_trip_id,
    p_source_payment_session_id,
    nullif(trim(coalesce(p_source_authorisation_id, '')), ''),
    upper(trim(p_source_type)),
    upper(trim(p_reason_code)),
    p_original_amount_pence,
    p_original_amount_pence,
    'OPEN',
    p_idempotency_key,
    coalesce(p_metadata, '{}'::jsonb)
  )
  RETURNING * INTO v_row;

  v_created := true;

  INSERT INTO public.customer_receivable_events (
    receivable_id, event_type, amount_pence, payment_session_id, trip_id, actor_role, note, metadata
  ) VALUES (
    v_row.id,
    'CREATED',
    p_original_amount_pence,
    p_source_payment_session_id,
    p_source_trip_id,
    'system',
    'Declined incremental authorisation → customer receivable',
    coalesce(p_metadata, '{}'::jsonb)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'created', v_created,
    'receivable_id', v_row.id,
    'status', v_row.status,
    'outstanding_amount_pence', v_row.outstanding_amount_pence
  );
EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO v_existing
    FROM public.customer_receivables
    WHERE idempotency_key = p_idempotency_key
    LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true,
        'created', false,
        'receivable_id', v_existing.id,
        'status', v_existing.status,
        'outstanding_amount_pence', v_existing.outstanding_amount_pence
      );
    END IF;
    RAISE;
END;
$fn$;

REVOKE ALL ON FUNCTION public.customer_receivable_record_declined_increment(
  uuid, uuid, uuid, text, text, text, integer, text, text, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_receivable_record_declined_increment(
  uuid, uuid, uuid, text, text, text, integer, text, text, jsonb
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_receivable_record_declined_increment(
  uuid, uuid, uuid, text, text, text, integer, text, text, jsonb
) TO service_role;

-- ─── RPC: reserve OPEN for preauth (atomic, FOR UPDATE) ───────
-- Concurrent second caller: already-RESERVED rows skipped → zero new allocations.

CREATE OR REPLACE FUNCTION public.customer_receivable_reserve_for_preauth(
  p_customer_id uuid,
  p_payment_session_id uuid,
  p_recovery_trip_id uuid DEFAULT NULL,
  p_currency text DEFAULT 'gbp'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_rec public.customer_receivables%ROWTYPE;
  v_alloc_id uuid;
  v_total integer := 0;
  v_ids uuid[] := ARRAY[]::uuid[];
  v_allocations jsonb := '[]'::jsonb;
  v_currency text := lower(coalesce(nullif(trim(p_currency), ''), 'gbp'));
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_customer_id IS NULL OR p_payment_session_id IS NULL THEN
    RAISE EXCEPTION 'customer_and_session_required' USING ERRCODE = '22023';
  END IF;

  -- Customer-scoped advisory lock so two concurrent bookings cannot both fold.
  PERFORM pg_advisory_xact_lock(hashtext('customer_receivable:' || p_customer_id::text));

  PERFORM set_config('onecab.allow_customer_receivable_write', '1', true);

  FOR v_rec IN
    SELECT *
    FROM public.customer_receivables r
    WHERE r.customer_id = p_customer_id
      AND r.status = 'OPEN'
      AND r.outstanding_amount_pence > 0
      AND lower(r.currency) = v_currency
    ORDER BY r.created_at ASC
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.customer_receivables
    SET
      status = 'RESERVED',
      reserved_payment_session_id = p_payment_session_id,
      updated_at = now()
    WHERE id = v_rec.id
      AND status = 'OPEN';

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    INSERT INTO public.payment_session_receivable_allocations (
      payment_session_id,
      receivable_id,
      recovery_trip_id,
      allocated_amount_pence,
      settled_amount_pence,
      status,
      metadata
    ) VALUES (
      p_payment_session_id,
      v_rec.id,
      p_recovery_trip_id,
      v_rec.outstanding_amount_pence,
      0,
      'RESERVED',
      jsonb_build_object('source_trip_id', v_rec.source_trip_id)
    )
    ON CONFLICT (payment_session_id, receivable_id) DO UPDATE
      SET
        allocated_amount_pence = EXCLUDED.allocated_amount_pence,
        status = 'RESERVED',
        released_at = NULL,
        updated_at = now()
    RETURNING id INTO v_alloc_id;

    INSERT INTO public.customer_receivable_events (
      receivable_id, event_type, amount_pence, payment_session_id, trip_id, actor_role, note
    ) VALUES (
      v_rec.id,
      'RESERVED',
      v_rec.outstanding_amount_pence,
      p_payment_session_id,
      p_recovery_trip_id,
      'system',
      'Reserved into next-booking preauthorisation (before provider call)'
    );

    v_total := v_total + v_rec.outstanding_amount_pence;
    v_ids := array_append(v_ids, v_rec.id);
    v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
      'allocation_id', v_alloc_id,
      'receivable_id', v_rec.id,
      'allocated_amount_pence', v_rec.outstanding_amount_pence,
      'created_at', v_rec.created_at
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'reserved_total_pence', v_total,
    'receivable_ids', to_jsonb(v_ids),
    'allocations', v_allocations,
    'allocation_count', coalesce(jsonb_array_length(v_allocations), 0)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.customer_receivable_reserve_for_preauth(uuid, uuid, uuid, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_receivable_reserve_for_preauth(uuid, uuid, uuid, text)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_receivable_reserve_for_preauth(uuid, uuid, uuid, text)
  TO service_role;

-- ─── RPC: release reservations ────────────────────────────────

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
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_payment_session_id IS NULL THEN
    RAISE EXCEPTION 'payment_session_id_required' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('onecab.allow_customer_receivable_write', '1', true);

  FOR v_alloc IN
    SELECT a.*
    FROM public.payment_session_receivable_allocations a
    WHERE a.payment_session_id = p_payment_session_id
      AND a.status = 'RESERVED'
    FOR UPDATE
  LOOP
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

  RETURN jsonb_build_object('ok', true, 'released', v_released);
END;
$fn$;

REVOKE ALL ON FUNCTION public.customer_receivable_release_reservations(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_receivable_release_reservations(uuid, text)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_receivable_release_reservations(uuid, text)
  TO service_role;

-- ─── RPC: settle from provider-confirmed capture ──────────────
-- Requires provider order id, terminal COMPLETED/CAPTURED, confirmed amount.
-- Partial capture: historical receivables (created_at ASC) first, then trip fare.

CREATE OR REPLACE FUNCTION public.customer_receivable_settle_from_provider_capture(
  p_payment_session_id uuid,
  p_provider_order_id text,
  p_terminal_state text,
  p_confirmed_captured_pence integer,
  p_current_trip_fare_pence integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_terminal text := upper(trim(coalesce(p_terminal_state, '')));
  v_remaining integer;
  v_alloc record;
  v_settle integer;
  v_left integer;
  v_settled_count integer := 0;
  v_partial_count integer := 0;
  v_debt_applied integer := 0;
  v_fare_allocation integer := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_payment_session_id IS NULL THEN
    RAISE EXCEPTION 'payment_session_id_required' USING ERRCODE = '22023';
  END IF;
  IF coalesce(trim(p_provider_order_id), '') = '' THEN
    RAISE EXCEPTION 'provider_order_id_required' USING ERRCODE = '22023';
  END IF;
  IF v_terminal NOT IN ('COMPLETED', 'CAPTURED') THEN
    RAISE EXCEPTION 'provider_terminal_state_required'
      USING ERRCODE = '22023',
            HINT = 'Only COMPLETED/CAPTURED settles receivables';
  END IF;
  IF p_confirmed_captured_pence IS NULL OR p_confirmed_captured_pence < 0 THEN
    RAISE EXCEPTION 'confirmed_captured_pence_required' USING ERRCODE = '22023';
  END IF;

  -- Lineage: session must reference this provider order (or null→set not required here).
  IF NOT EXISTS (
    SELECT 1 FROM public.payment_sessions ps
    WHERE ps.id = p_payment_session_id
      AND (
        ps.provider_order_id IS NULL
        OR ps.provider_order_id = p_provider_order_id
      )
  ) THEN
    RAISE EXCEPTION 'payment_session_order_mismatch' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('onecab.allow_customer_receivable_write', '1', true);

  v_remaining := p_confirmed_captured_pence;

  -- Historical receivables first (allocation join receivable created_at ASC).
  FOR v_alloc IN
    SELECT
      a.id AS allocation_id,
      a.receivable_id,
      a.allocated_amount_pence,
      a.status,
      r.outstanding_amount_pence,
      r.created_at AS receivable_created_at
    FROM public.payment_session_receivable_allocations a
    JOIN public.customer_receivables r ON r.id = a.receivable_id
    WHERE a.payment_session_id = p_payment_session_id
      AND a.status = 'RESERVED'
    ORDER BY r.created_at ASC
    FOR UPDATE OF a, r
  LOOP
    IF v_remaining <= 0 THEN
      -- No capture left for this receivable — release reservation back to OPEN.
      UPDATE public.payment_session_receivable_allocations
      SET status = 'RELEASED', released_at = now(), updated_at = now()
      WHERE id = v_alloc.allocation_id AND status = 'RESERVED';

      UPDATE public.customer_receivables
      SET status = 'OPEN', reserved_payment_session_id = NULL, updated_at = now()
      WHERE id = v_alloc.receivable_id AND status = 'RESERVED';

      INSERT INTO public.customer_receivable_events (
        receivable_id, event_type, amount_pence, payment_session_id, actor_role, note, metadata
      ) VALUES (
        v_alloc.receivable_id, 'RELEASED', 0, p_payment_session_id, 'system',
        'Partial capture exhausted — reservation released',
        jsonb_build_object('provider_order_id', p_provider_order_id)
      );
      CONTINUE;
    END IF;

    v_settle := LEAST(v_alloc.allocated_amount_pence, v_remaining, v_alloc.outstanding_amount_pence);
    v_left := v_alloc.outstanding_amount_pence - v_settle;
    v_remaining := v_remaining - v_settle;
    v_debt_applied := v_debt_applied + v_settle;

    IF v_left = 0 THEN
      UPDATE public.payment_session_receivable_allocations
      SET
        status = 'CAPTURED',
        settled_amount_pence = v_settle,
        captured_at = now(),
        updated_at = now()
      WHERE id = v_alloc.allocation_id AND status = 'RESERVED';

      UPDATE public.customer_receivables
      SET
        status = 'SETTLED',
        outstanding_amount_pence = 0,
        settled_at = now(),
        updated_at = now()
      WHERE id = v_alloc.receivable_id
        AND status IN ('RESERVED', 'OPEN');

      INSERT INTO public.customer_receivable_events (
        receivable_id, event_type, amount_pence, payment_session_id, actor_role, note, metadata
      ) VALUES (
        v_alloc.receivable_id, 'SETTLED', v_settle, p_payment_session_id, 'system',
        'Provider-confirmed capture cleared receivable',
        jsonb_build_object(
          'provider_order_id', p_provider_order_id,
          'terminal_state', v_terminal,
          'confirmed_captured_pence', p_confirmed_captured_pence
        )
      );
      v_settled_count := v_settled_count + 1;
    ELSE
      UPDATE public.payment_session_receivable_allocations
      SET
        status = 'PARTIAL',
        settled_amount_pence = v_settle,
        captured_at = now(),
        updated_at = now()
      WHERE id = v_alloc.allocation_id AND status = 'RESERVED';

      UPDATE public.customer_receivables
      SET
        status = 'OPEN',
        outstanding_amount_pence = v_left,
        reserved_payment_session_id = NULL,
        updated_at = now()
      WHERE id = v_alloc.receivable_id
        AND status IN ('RESERVED', 'OPEN');

      INSERT INTO public.customer_receivable_events (
        receivable_id, event_type, amount_pence, payment_session_id, actor_role, note, metadata
      ) VALUES (
        v_alloc.receivable_id, 'PARTIAL_SETTLED', v_settle, p_payment_session_id, 'system',
        'Partial capture — remaining outstanding reopened',
        jsonb_build_object(
          'provider_order_id', p_provider_order_id,
          'settled_pence', v_settle,
          'remaining_outstanding_pence', v_left
        )
      );
      v_partial_count := v_partial_count + 1;
    END IF;
  END LOOP;

  -- Remainder of capture (if any) is attributable to current trip fare (documented order).
  v_fare_allocation := LEAST(
    greatest(coalesce(p_current_trip_fare_pence, 0), 0),
    greatest(v_remaining, 0)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'settled_count', v_settled_count,
    'partial_count', v_partial_count,
    'debt_applied_pence', v_debt_applied,
    'current_trip_fare_allocation_pence', v_fare_allocation,
    'capture_remainder_pence', greatest(v_remaining - v_fare_allocation, 0),
    'provider_order_id', p_provider_order_id,
    'terminal_state', v_terminal
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.customer_receivable_settle_from_provider_capture(
  uuid, text, text, integer, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_receivable_settle_from_provider_capture(
  uuid, text, text, integer, integer
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.customer_receivable_settle_from_provider_capture(
  uuid, text, text, integer, integer
) TO service_role;

-- ─── RPC: customer list own ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.customer_list_my_receivables()
RETURNS TABLE (
  id uuid,
  source_trip_id uuid,
  source_type text,
  reason_code text,
  original_amount_pence integer,
  outstanding_amount_pence integer,
  status text,
  currency text,
  reserved_payment_session_id uuid,
  created_at timestamptz,
  settled_at timestamptz,
  waived_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_customer_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT c.id INTO v_customer_id
  FROM public.customers c
  WHERE c.user_id = auth.uid()
  LIMIT 1;

  IF v_customer_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    r.source_trip_id,
    r.source_type,
    r.reason_code,
    r.original_amount_pence,
    r.outstanding_amount_pence,
    r.status,
    r.currency,
    r.reserved_payment_session_id,
    r.created_at,
    r.settled_at,
    r.waived_at
  FROM public.customer_receivables r
  WHERE r.customer_id = v_customer_id
  ORDER BY r.created_at ASC;
END;
$fn$;

REVOKE ALL ON FUNCTION public.customer_list_my_receivables() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.customer_list_my_receivables() FROM anon;
GRANT EXECUTE ON FUNCTION public.customer_list_my_receivables() TO authenticated;
GRANT EXECUTE ON FUNCTION public.customer_list_my_receivables() TO service_role;

-- ─── RPC: admin/finance list ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_list_customer_receivables(
  p_customer_id uuid DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  id uuid,
  customer_id uuid,
  source_trip_id uuid,
  source_payment_session_id uuid,
  source_type text,
  reason_code text,
  original_amount_pence integer,
  outstanding_amount_pence integer,
  status text,
  currency text,
  reserved_payment_session_id uuid,
  idempotency_key text,
  created_at timestamptz,
  settled_at timestamptz,
  waived_at timestamptz,
  metadata jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public
AS $fn$
BEGIN
  -- Prefer existing finance ACL; service_role always allowed.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    PERFORM public.assert_finance_payout_ledger_access();
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    r.customer_id,
    r.source_trip_id,
    r.source_payment_session_id,
    r.source_type,
    r.reason_code,
    r.original_amount_pence,
    r.outstanding_amount_pence,
    r.status,
    r.currency,
    r.reserved_payment_session_id,
    r.idempotency_key,
    r.created_at,
    r.settled_at,
    r.waived_at,
    r.metadata
  FROM public.customer_receivables r
  WHERE (p_customer_id IS NULL OR r.customer_id = p_customer_id)
    AND (p_status IS NULL OR r.status = upper(trim(p_status)))
  ORDER BY r.created_at ASC
  LIMIT greatest(1, least(coalesce(p_limit, 100), 500));
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_list_customer_receivables(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_list_customer_receivables(uuid, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_list_customer_receivables(uuid, text, integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_customer_receivables(uuid, text, integer)
  TO service_role;

COMMIT;
