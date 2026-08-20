-- ============================================================
-- Migration: 20260930150000_provider_refund_ledger_idempotency.sql
-- Purpose  : REFUND_DEBIT provider lineage + atomic refund RPC.
--            Replaces broad unique_trip_ledger_entry with typed partial
--            singleton indexes; allows multiple REFUND_DEBIT per trip
--            only when provider_refund_id lineage differs.
-- After    : 20260930140000_fix_payout_rls_recursion.sql
--
-- Does NOT backfill historical REFUND_DEBIT rows.
-- Never calls Revolut.
-- ============================================================

-- ── 1. Ledger lineage columns ───────────────────────────────────────────────

ALTER TABLE public.driver_wallet_ledger
  ADD COLUMN IF NOT EXISTS provider_refund_id text,
  ADD COLUMN IF NOT EXISTS payment_provider text;

COMMENT ON COLUMN public.driver_wallet_ledger.provider_refund_id IS
  'Authoritative provider refund identity for REFUND_DEBIT rows. NULL on historical rows only.';
COMMENT ON COLUMN public.driver_wallet_ledger.payment_provider IS
  'Payment provider namespace for REFUND_DEBIT lineage (e.g. revolut).';

-- ── 2. Preflight: production rows must satisfy singleton-per-trip contract ──

DO $$
DECLARE
  v_dup_count integer;
BEGIN
  SELECT count(*)::integer INTO v_dup_count
  FROM (
    SELECT related_trip_id, type
    FROM public.driver_wallet_ledger
    WHERE related_trip_id IS NOT NULL
      AND type <> 'REFUND_DEBIT'
    GROUP BY related_trip_id, type
    HAVING count(*) > 1
  ) d;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT FAILED: % duplicate (related_trip_id,type) pairs for non-REFUND_DEBIT rows',
      v_dup_count;
  END IF;

  SELECT count(*)::integer INTO v_dup_count
  FROM (
    SELECT related_trip_id
    FROM public.driver_wallet_ledger
    WHERE type = 'REFUND_DEBIT'
      AND related_trip_id IS NOT NULL
      AND provider_refund_id IS NULL
    GROUP BY related_trip_id
    HAVING count(*) > 1
  ) d;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT FAILED: % trips have multiple NULL-lineage REFUND_DEBIT rows',
      v_dup_count;
  END IF;
END $$;

-- ── 3. Replacement partial singleton indexes (before dropping broad unique) ─

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_cash_trip_earning_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'CASH_TRIP_EARNING' AND related_trip_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_platform_commission_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'PLATFORM_COMMISSION' AND related_trip_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_driver_tip_credit_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'DRIVER_TIP_CREDIT' AND related_trip_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_tip_credit_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'TIP_CREDIT' AND related_trip_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_ledger_reversal_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'LEDGER_REVERSAL' AND related_trip_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_commission_recovered_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'COMMISSION_RECOVERED' AND related_trip_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_ops_driver_compensation_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'OPS_DRIVER_COMPENSATION' AND related_trip_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_trip_adjustment_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'ADJUSTMENT' AND related_trip_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_debt_recovery_trip_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'DEBT_RECOVERY' AND related_trip_id IS NOT NULL;

-- TRIP_EARNING_NET + CASH_COMMISSION_DEBT already have dedicated partial indexes.
-- Preserve at most one historical NULL-lineage REFUND_DEBIT per trip (no backfill).
CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_refund_debit_null_lineage_trip_unique
  ON public.driver_wallet_ledger (related_trip_id)
  WHERE type = 'REFUND_DEBIT'
    AND provider_refund_id IS NULL
    AND related_trip_id IS NOT NULL;

-- Provider-refund lineage idempotency (multiple REFUND_DEBIT per trip allowed).
CREATE UNIQUE INDEX IF NOT EXISTS driver_wallet_ledger_refund_debit_provider_refund_unique
  ON public.driver_wallet_ledger (payment_provider, provider_refund_id, driver_id)
  WHERE type = 'REFUND_DEBIT'
    AND provider_refund_id IS NOT NULL;

-- Fail closed if production index exists with wrong definition (name-only IF NOT EXISTS is insufficient).
DO $$
DECLARE
  v_indexdef text;
  v_condef text;
  v_is_unique boolean;
  v_dup_count integer;
BEGIN
  SELECT indexdef, indisunique
  INTO v_indexdef, v_is_unique
  FROM pg_indexes i
  JOIN pg_class c ON c.relname = i.indexname
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.schemaname
  JOIN pg_index ix ON ix.indexrelid = c.oid
  WHERE i.schemaname = 'public'
    AND i.indexname = 'payment_session_refunds_provider_refund_unique'
  LIMIT 1;

  IF v_indexdef IS NOT NULL THEN
    IF v_is_unique IS DISTINCT FROM true THEN
      RAISE EXCEPTION
        'PREFLIGHT FAILED: payment_session_refunds_provider_refund_unique exists but is not UNIQUE';
    END IF;
    IF v_indexdef !~* 'UNIQUE.*\(payment_provider,\s*provider_refund_id\)' THEN
      RAISE EXCEPTION
        'PREFLIGHT FAILED: payment_session_refunds_provider_refund_unique has unexpected definition: %',
        v_indexdef;
    END IF;
    IF v_indexdef ~* 'WHERE\s' THEN
      RAISE EXCEPTION
        'PREFLIGHT FAILED: payment_session_refunds_provider_refund_unique must not be partial (found predicate)';
    END IF;
  END IF;

  SELECT pg_get_constraintdef(c.oid)
  INTO v_condef
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'payment_session_refunds'
    AND c.conname = 'payment_session_refunds_provider_refund_unique'
  LIMIT 1;

  IF v_condef IS NOT NULL AND v_condef !~* 'UNIQUE\s*\(payment_provider,\s*provider_refund_id\)' THEN
    RAISE EXCEPTION
      'PREFLIGHT FAILED: payment_session_refunds_provider_refund_unique constraint mismatch: %',
      v_condef;
  END IF;

  SELECT count(*)::integer INTO v_dup_count
  FROM (
    SELECT payment_provider, provider_refund_id
    FROM public.payment_session_refunds
    WHERE provider_refund_id IS NOT NULL
    GROUP BY payment_provider, provider_refund_id
    HAVING count(*) > 1
  ) d;

  IF v_dup_count > 0 THEN
    RAISE EXCEPTION
      'PREFLIGHT FAILED: % duplicate (payment_provider, provider_refund_id) groups in payment_session_refunds',
      v_dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_session_refunds_provider_refund_unique
  ON public.payment_session_refunds (payment_provider, provider_refund_id);

-- ── 4. Drop broad (related_trip_id, type) uniqueness — REFUND_DEBIT incompatible ─

ALTER TABLE public.driver_wallet_ledger
  DROP CONSTRAINT IF EXISTS unique_trip_ledger_entry;

DROP INDEX IF EXISTS public.unique_trip_ledger_entry;

-- ── 5. Atomic local application RPC ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_confirmed_provider_refund_atomic(
  p_trip_id uuid,
  p_payment_provider text,
  p_provider_refund_id text,
  p_event_refund_amount_pence integer,
  p_cumulative_refunded_pence integer,
  p_provider_order_id text DEFAULT NULL,
  p_provider_payment_id text DEFAULT NULL,
  p_refund_reason text DEFAULT NULL,
  p_source text DEFAULT 'admin_refund',
  p_skip_driver_wallet_reversal boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_ps public.payment_sessions%ROWTYPE;
  v_rb_count integer;
  v_captured_pence integer;
  v_commission_pence integer;
  v_driver_net_pence integer;
  v_now timestamptz := now();
  v_child_id uuid;
  v_existing_child_id uuid;
  v_existing_debit_id uuid;
  v_existing_debit_pence integer;
  v_ps_refunded_sum integer;
  v_refund_status text;
  v_payment_status text;
  v_ratio numeric;
  v_target_reversal integer;
  v_authoritative_debit_sum integer;
  v_missing_reversal integer;
  v_credited_pence integer;
  v_insert_debit_pence integer;
  v_ledger_id uuid;
  v_net_captured integer;
  v_adjusted_commission integer;
  v_adjusted_driver_net integer;
BEGIN
  IF p_trip_id IS NULL THEN
    RAISE EXCEPTION 'trip_id_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_provider_refund_id IS NULL OR btrim(p_provider_refund_id) = '' THEN
    RAISE EXCEPTION 'provider_refund_id_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_payment_provider IS NULL OR btrim(p_payment_provider) = '' THEN
    RAISE EXCEPTION 'payment_provider_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_event_refund_amount_pence IS NULL OR p_event_refund_amount_pence <= 0 THEN
    RAISE EXCEPTION 'event_refund_amount_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_cumulative_refunded_pence IS NULL OR p_cumulative_refunded_pence <= 0 THEN
    RAISE EXCEPTION 'cumulative_refund_amount_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'trip_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  IF upper(coalesce(v_trip.financial_model::text, '')) = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.driver_wallet_ledger dwl
    WHERE dwl.related_trip_id = p_trip_id
      AND dwl.type = 'REFUND_DEBIT'
      AND dwl.provider_refund_id IS NULL
  ) THEN
    RAISE EXCEPTION 'HISTORICAL_REFUND_DEBIT_REQUIRES_MANUAL_RECONCILIATION'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::integer INTO v_rb_count
  FROM public.payment_sessions ps
  WHERE ps.trip_id = p_trip_id
    AND ps.purpose = 'RIDE_BOOKING';

  IF v_rb_count = 0 THEN
    RAISE EXCEPTION 'PAYMENT_SESSION_MISSING' USING ERRCODE = 'check_violation';
  END IF;

  IF v_rb_count > 1 THEN
    RAISE EXCEPTION 'CAPTURE_AMBIGUOUS' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_ps
  FROM public.payment_sessions ps
  WHERE ps.trip_id = p_trip_id
    AND ps.purpose = 'RIDE_BOOKING'
  FOR UPDATE;

  SELECT id INTO v_existing_child_id
  FROM public.payment_session_refunds psr
  WHERE psr.payment_provider = p_payment_provider
    AND psr.provider_refund_id = p_provider_refund_id;

  SELECT id, abs(dwl.amount_pence)::integer
    INTO v_existing_debit_id, v_existing_debit_pence
  FROM public.driver_wallet_ledger dwl
  WHERE dwl.payment_provider = p_payment_provider
    AND dwl.provider_refund_id = p_provider_refund_id
    AND dwl.driver_id = v_trip.driver_id
    AND dwl.type = 'REFUND_DEBIT';

  IF v_existing_child_id IS NOT NULL AND v_existing_debit_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'already_applied',
      'trip_id', p_trip_id,
      'payment_session_id', v_ps.id,
      'provider_refund_id', p_provider_refund_id,
      'refund_child_id', v_existing_child_id,
      'ledger_debit_id', v_existing_debit_id,
      'cumulative_refunded_pence', p_cumulative_refunded_pence
    );
  END IF;

  v_captured_pence := greatest(
    0,
    coalesce(v_trip.capture_amount_pence, v_ps.captured_amount_pence, v_ps.authorised_amount_pence, 0)
  );
  v_commission_pence := greatest(0, coalesce(v_trip.commission_pence, 0));
  v_driver_net_pence := greatest(0, coalesce(v_trip.driver_net_pence, 0));

  IF v_captured_pence <= 0 THEN
    RAISE EXCEPTION 'captured_amount_missing' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.payment_session_refunds (
    payment_session_id,
    payment_provider,
    provider_refund_id,
    provider_payment_id,
    amount_pence,
    currency,
    status,
    confirmed_at,
    metadata
  ) VALUES (
    v_ps.id,
    p_payment_provider,
    p_provider_refund_id,
    coalesce(p_provider_payment_id, p_provider_order_id, v_ps.provider_order_id),
    p_event_refund_amount_pence,
    lower(coalesce(v_ps.currency, 'gbp')),
    'confirmed',
    v_now,
    jsonb_build_object('source', coalesce(p_source, 'admin_refund'))
  )
  ON CONFLICT (payment_provider, provider_refund_id) DO NOTHING
  RETURNING id INTO v_child_id;

  IF v_child_id IS NULL THEN
    SELECT id INTO v_child_id
    FROM public.payment_session_refunds psr
    WHERE psr.payment_provider = p_payment_provider
      AND psr.provider_refund_id = p_provider_refund_id;
  END IF;

  SELECT coalesce(sum(psr.amount_pence), 0)::integer INTO v_ps_refunded_sum
  FROM public.payment_session_refunds psr
  WHERE psr.payment_session_id = v_ps.id
    AND psr.amount_pence > 0;

  IF v_ps_refunded_sum <> p_cumulative_refunded_pence THEN
    RAISE EXCEPTION 'cumulative_refund_mismatch: expected % got %',
      p_cumulative_refunded_pence, v_ps_refunded_sum
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_cumulative_refunded_pence >= v_captured_pence THEN
    v_refund_status := 'refunded';
    v_payment_status := 'refunded';
  ELSE
    v_refund_status := 'partially_refunded';
    v_payment_status := 'partially_refunded';
  END IF;

  v_net_captured := greatest(0, v_captured_pence - p_cumulative_refunded_pence);
  v_ratio := v_net_captured::numeric / v_captured_pence::numeric;
  v_adjusted_commission := greatest(0, round(v_commission_pence * v_ratio)::integer);
  v_adjusted_driver_net := greatest(0, round(v_driver_net_pence * v_ratio)::integer);
  v_target_reversal := greatest(0, v_driver_net_pence - v_adjusted_driver_net);

  SELECT coalesce(sum(abs(dwl.amount_pence)), 0)::integer INTO v_authoritative_debit_sum
  FROM public.driver_wallet_ledger dwl
  WHERE dwl.related_trip_id = p_trip_id
    AND dwl.type = 'REFUND_DEBIT'
    AND dwl.provider_refund_id IS NOT NULL;

  v_missing_reversal := greatest(0, v_target_reversal - v_authoritative_debit_sum);
  v_insert_debit_pence := 0;

  IF v_missing_reversal > 0
     AND NOT coalesce(p_skip_driver_wallet_reversal, false)
     AND v_trip.driver_id IS NOT NULL
     AND v_existing_debit_id IS NULL THEN
    SELECT coalesce(sum(greatest(0, dwl.amount_pence)), 0)::integer INTO v_credited_pence
    FROM public.driver_wallet_ledger dwl
    WHERE dwl.driver_id = v_trip.driver_id
      AND dwl.related_trip_id = p_trip_id
      AND dwl.type IN ('TRIP_EARNING_NET', 'DRIVER_TIP_CREDIT');

    IF v_credited_pence > 0 THEN
      v_insert_debit_pence := least(v_credited_pence - v_authoritative_debit_sum, v_missing_reversal);
      v_insert_debit_pence := greatest(0, v_insert_debit_pence);
    ELSE
      v_insert_debit_pence := v_missing_reversal;
    END IF;

    IF v_insert_debit_pence > 0 THEN
      INSERT INTO public.driver_wallet_ledger (
        driver_id,
        related_trip_id,
        type,
        amount_pence,
        currency,
        description,
        payment_provider,
        provider_refund_id
      ) VALUES (
        v_trip.driver_id,
        p_trip_id,
        'REFUND_DEBIT',
        -v_insert_debit_pence,
        coalesce(v_trip.currency, 'GBP'),
        format('provider refund reversal (%s) — %s', p_provider_refund_id, coalesce(p_source, 'admin_refund')),
        p_payment_provider,
        p_provider_refund_id
      )
      RETURNING id INTO v_ledger_id;
    END IF;
  ELSIF v_existing_debit_id IS NOT NULL THEN
    v_ledger_id := v_existing_debit_id;
  END IF;

  UPDATE public.payment_sessions
  SET
    refunded_amount_pence = v_ps_refunded_sum,
    refunded_at = v_now,
    provider_refund_id = p_provider_refund_id,
    updated_at = v_now
  WHERE id = v_ps.id;

  UPDATE public.trips
  SET
    payment_status = v_payment_status,
    refund_amount_pence = p_cumulative_refunded_pence,
    refunded_at = v_now,
    updated_at = v_now,
    refund_reason = coalesce(p_refund_reason, refund_reason)
  WHERE id = p_trip_id;

  UPDATE public.payments pay
  SET
    status = v_payment_status,
    refunded_amount_pence = p_cumulative_refunded_pence,
    refund_status = v_refund_status,
    refunded_at = v_now,
    updated_at = v_now,
    provider_refund_id = p_provider_refund_id,
    last_error = format('provider_refund:%s:%s', p_provider_refund_id, p_cumulative_refunded_pence)
  WHERE pay.trip_id = p_trip_id;

  UPDATE public.trip_finance tf
  SET
    refund_amount_pence = p_cumulative_refunded_pence,
    refund_status = v_refund_status,
    net_card_revenue_after_refund_pence = v_net_captured,
    driver_wallet_reversal_pence = v_target_reversal,
    commission_reversal_pence = greatest(0, v_commission_pence - v_adjusted_commission),
    financial_status = CASE WHEN v_refund_status = 'refunded' THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END,
    updated_at = v_now
  WHERE tf.trip_id = p_trip_id;

  RETURN jsonb_build_object(
    'status', 'applied',
    'trip_id', p_trip_id,
    'payment_session_id', v_ps.id,
    'provider_refund_id', p_provider_refund_id,
    'refund_child_id', v_child_id,
    'ledger_debit_id', v_ledger_id,
    'cumulative_refunded_pence', p_cumulative_refunded_pence,
    'target_driver_reversal_pence', v_target_reversal,
    'authoritative_debit_sum_pence', v_authoritative_debit_sum + coalesce(v_insert_debit_pence, 0),
    'inserted_debit_pence', coalesce(v_insert_debit_pence, 0),
    'payment_status', v_payment_status,
    'refund_status', v_refund_status
  );

EXCEPTION
  WHEN unique_violation THEN
    SELECT id INTO v_existing_child_id
    FROM public.payment_session_refunds psr
    WHERE psr.payment_provider = p_payment_provider
      AND psr.provider_refund_id = p_provider_refund_id;

    SELECT id, abs(dwl.amount_pence)::integer
      INTO v_existing_debit_id, v_existing_debit_pence
    FROM public.driver_wallet_ledger dwl
    WHERE dwl.payment_provider = p_payment_provider
      AND dwl.provider_refund_id = p_provider_refund_id
      AND dwl.driver_id = v_trip.driver_id
      AND dwl.type = 'REFUND_DEBIT';

    SELECT coalesce(sum(psr.amount_pence), 0)::integer INTO v_ps_refunded_sum
    FROM public.payment_session_refunds psr
    WHERE psr.payment_session_id = v_ps.id
      AND psr.amount_pence > 0;

    IF v_existing_child_id IS NOT NULL
       AND v_existing_debit_id IS NOT NULL
       AND v_ps_refunded_sum = p_cumulative_refunded_pence THEN
      RETURN jsonb_build_object(
        'status', 'already_applied',
        'trip_id', p_trip_id,
        'payment_session_id', v_ps.id,
        'provider_refund_id', p_provider_refund_id,
        'refund_child_id', v_existing_child_id,
        'ledger_debit_id', v_existing_debit_id,
        'cumulative_refunded_pence', p_cumulative_refunded_pence,
        'recovered_from', 'unique_violation'
      );
    END IF;

    RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_confirmed_provider_refund_atomic(
  uuid, text, text, integer, integer, text, text, text, text, boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.apply_confirmed_provider_refund_atomic(
  uuid, text, text, integer, integer, text, text, text, text, boolean
) TO service_role;

COMMENT ON FUNCTION public.apply_confirmed_provider_refund_atomic IS
  'Atomically applies a confirmed provider refund. Never calls Revolut.';

-- ── 6. Verification ─────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'unique_trip_ledger_entry'
      AND conrelid = 'public.driver_wallet_ledger'::regclass
  ) THEN
    RAISE EXCEPTION 'unique_trip_ledger_entry still present after migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'driver_wallet_ledger_refund_debit_provider_refund_unique'
  ) THEN
    RAISE EXCEPTION 'driver_wallet_ledger_refund_debit_provider_refund_unique missing';
  END IF;

  RAISE NOTICE 'Migration 20260930150000: provider refund atomic RPC verified OK';
END $$;
