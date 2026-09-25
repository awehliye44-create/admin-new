-- Atomic capture-composition acquire (PR #80 transactional certification).
-- Single SECURITY DEFINER RPC: advisory_xact_lock → FOR UPDATE session →
-- reload RESERVED → resume or create frozen plan → CAPTURING.
-- Rollback: supabase/migrations/rollback/rollback_20260925130000_payment_session_acquire_capture_composition.sql
--
-- Depends on: 20260925120000_capture_composition_components.sql

CREATE OR REPLACE FUNCTION public.payment_session_acquire_capture_composition(
  p_payment_session_id uuid,
  p_provider_order_id text,
  p_trip_fare_component_pence integer,
  p_tip_component_pence integer DEFAULT 0,
  p_preauth_buffer_component_pence integer DEFAULT 0,
  p_authorised_total_pence integer DEFAULT 0,
  p_lock_owner text DEFAULT 'capture',
  p_operation_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_session public.payment_sessions%ROWTYPE;
  v_reserved integer := 0;
  v_meta jsonb;
  v_meta_recv integer := 0;
  v_fare integer;
  v_tip integer;
  v_buffer integer;
  v_auth integer;
  v_target integer;
  v_key text;
  v_now timestamptz := now();
  v_order text;
  v_owner text;
  v_updated int;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_payment_session_id IS NULL OR nullif(trim(p_provider_order_id), '') IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'PAYMENT_SESSION_MISSING',
      'error', 'payment_session_id_and_provider_order_id_required'
    );
  END IF;

  v_owner := coalesce(nullif(trim(p_lock_owner), ''), 'capture');
  v_order := trim(p_provider_order_id);
  v_fare := greatest(0, coalesce(p_trip_fare_component_pence, 0));
  v_tip := greatest(0, coalesce(p_tip_component_pence, 0));
  v_buffer := greatest(0, coalesce(p_preauth_buffer_component_pence, 0));
  v_auth := greatest(0, coalesce(p_authorised_total_pence, 0));

  -- Transaction-scoped lock: held until this RPC's statement/transaction commits.
  -- Lock key: capture_composition:<payment_session_id>
  PERFORM pg_advisory_xact_lock(
    hashtext('capture_composition:' || p_payment_session_id::text)
  );

  SELECT * INTO v_session
  FROM public.payment_sessions
  WHERE id = p_payment_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'PAYMENT_SESSION_MISSING',
      'error', 'payment_session_not_found'
    );
  END IF;

  IF v_session.provider_order_id IS NOT NULL
     AND nullif(trim(v_session.provider_order_id), '') IS NOT NULL
     AND trim(v_session.provider_order_id) IS DISTINCT FROM v_order THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'CAPTURE_COMPOSITION_LINEAGE_MISMATCH',
      'error', 'session_provider_order_id_mismatch'
    );
  END IF;

  v_meta := coalesce(v_session.metadata, '{}'::jsonb);
  v_auth := greatest(
    v_auth,
    coalesce(v_session.total_authorised_amount_pence, 0),
    coalesce(v_session.authorised_amount_pence, 0)
  );
  IF v_buffer = 0 THEN
    v_buffer := greatest(0, coalesce(v_session.buffer_pence, 0));
  END IF;

  -- Resume frozen plan — never recompute.
  IF v_session.capture_idempotency_key IS NOT NULL
     AND v_session.provider_capture_target_pence IS NOT NULL THEN
    IF v_session.provider_capture_target_pence
         <> coalesce(v_session.trip_fare_component_pence, 0)
           + coalesce(v_session.tip_component_pence, 0)
           + coalesce(v_session.receivable_component_pence, 0) THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'CAPTURE_COMPOSITION_MISMATCH',
        'error', 'frozen_plan_component_sum_mismatch'
      );
    END IF;
    IF v_auth > 0 AND v_session.provider_capture_target_pence > v_auth THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'CAPTURE_TARGET_EXCEEDS_AUTHORISED',
        'error', 'frozen_target_exceeds_authorised'
      );
    END IF;

    UPDATE public.payment_sessions
    SET
      financial_operation_state = 'CAPTURING',
      financial_operation_owner = v_owner,
      financial_operation_started_at = v_now,
      metadata = v_meta || jsonb_build_object(
        'financial_operation_state', 'CAPTURING',
        'financial_operation_owner', v_owner,
        'financial_operation_started_at', v_now,
        'financial_operation_key', coalesce(p_operation_key, v_meta->>'financial_operation_key')
      ),
      updated_at = v_now
    WHERE id = p_payment_session_id;

    RETURN jsonb_build_object(
      'ok', true,
      'kind', 'resumed',
      'provider_capture_target_pence', v_session.provider_capture_target_pence,
      'capture_idempotency_key', v_session.capture_idempotency_key,
      'trip_fare_component_pence', v_session.trip_fare_component_pence,
      'tip_component_pence', v_session.tip_component_pence,
      'receivable_component_pence', v_session.receivable_component_pence,
      'preauth_buffer_component_pence', coalesce((v_meta->>'preauth_buffer_component_pence')::int, v_buffer),
      'capture_composition_frozen_at', v_session.capture_composition_frozen_at,
      'lock_owner', v_owner,
      'payment_session_id', p_payment_session_id,
      'provider_order_id', v_order
    );
  END IF;

  -- RESERVED allocations under same transaction (locked via session + advisory).
  -- Lock rows first (FOR UPDATE cannot combine with aggregate), then sum.
  PERFORM 1
  FROM public.payment_session_receivable_allocations a
  WHERE a.payment_session_id = p_payment_session_id
    AND a.status = 'RESERVED'
  FOR UPDATE OF a;

  SELECT coalesce(sum(a.allocated_amount_pence), 0)::integer
  INTO v_reserved
  FROM public.payment_session_receivable_allocations a
  WHERE a.payment_session_id = p_payment_session_id
    AND a.status = 'RESERVED';

  v_meta_recv := greatest(
    0,
    coalesce((v_meta->>'customer_receivables_pence')::int, 0),
    coalesce((v_meta->>'folded_receivable_pence')::int, 0)
  );

  IF v_meta_recv > 0 AND v_reserved <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'RECEIVABLE_ALLOCATION_STATE_UNKNOWN',
      'error', 'metadata_receivables_without_reserved_allocations'
    );
  END IF;

  IF (
    (v_meta ? 'preauth_receivable_ordering' OR v_meta ? 'customer_receivable_ids')
    AND v_meta_recv <= 0
    AND v_reserved <= 0
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'RECEIVABLE_ALLOCATION_STATE_UNKNOWN',
      'error', 'fold_metadata_without_proven_allocations'
    );
  END IF;

  -- Legacy path: no receivable evidence.
  IF v_reserved <= 0 AND v_meta_recv <= 0 THEN
    UPDATE public.payment_sessions
    SET
      financial_operation_state = 'CAPTURING',
      financial_operation_owner = v_owner,
      financial_operation_started_at = v_now,
      metadata = v_meta || jsonb_build_object(
        'financial_operation_state', 'CAPTURING',
        'financial_operation_owner', v_owner,
        'financial_operation_started_at', v_now,
        'financial_operation_key', p_operation_key
      ),
      updated_at = v_now
    WHERE id = p_payment_session_id;

    RETURN jsonb_build_object(
      'ok', true,
      'kind', 'legacy_fare_tip',
      'provider_capture_target_pence', v_fare + v_tip,
      'capture_idempotency_key', NULL,
      'trip_fare_component_pence', v_fare,
      'tip_component_pence', v_tip,
      'receivable_component_pence', 0,
      'preauth_buffer_component_pence', v_buffer,
      'lock_owner', v_owner,
      'payment_session_id', p_payment_session_id,
      'provider_order_id', v_order
    );
  END IF;

  IF v_meta_recv > 0 AND v_reserved > 0 AND v_meta_recv IS DISTINCT FROM v_reserved THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'CAPTURE_COMPOSITION_MISMATCH',
      'error', 'metadata_receivables_disagree_with_reserved'
    );
  END IF;

  v_target := v_fare + v_tip + v_reserved;
  IF v_auth > 0 AND v_target > v_auth THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'CAPTURE_TARGET_EXCEEDS_AUTHORISED',
      'error', 'capture_target_exceeds_authorised',
      'provider_capture_target_pence', v_target,
      'authorised_total_pence', v_auth
    );
  END IF;
  IF v_target <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'CAPTURE_COMPOSITION_REQUIRED',
      'error', 'capture_target_zero'
    );
  END IF;

  v_key := 'capture_composition:v1:' || p_payment_session_id::text || ':' || v_order || ':' || v_target::text;

  UPDATE public.payment_sessions
  SET
    trip_fare_component_pence = v_fare,
    tip_component_pence = v_tip,
    receivable_component_pence = v_reserved,
    provider_capture_target_pence = v_target,
    capture_composition_version = 'capture_composition:v1',
    capture_idempotency_key = v_key,
    capture_composition_frozen_at = v_now,
    financial_operation_state = 'CAPTURING',
    financial_operation_owner = v_owner,
    financial_operation_started_at = v_now,
    metadata = v_meta || jsonb_build_object(
      'trip_fare_component_pence', v_fare,
      'tip_component_pence', v_tip,
      'receivable_component_pence', v_reserved,
      'provider_capture_target_pence', v_target,
      'preauth_buffer_component_pence', v_buffer,
      'capture_idempotency_key', v_key,
      'capture_composition_version', 'capture_composition:v1',
      'capture_composition_frozen_at', v_now,
      'capture_composition_immutable', true,
      'financial_operation_state', 'CAPTURING',
      'financial_operation_owner', v_owner,
      'financial_operation_started_at', v_now,
      'financial_operation_key', p_operation_key
    ),
    updated_at = v_now
  WHERE id = p_payment_session_id
    AND capture_idempotency_key IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    -- Concurrent winner froze first — adopt under same advisory lock.
    SELECT * INTO v_session
    FROM public.payment_sessions
    WHERE id = p_payment_session_id
    FOR UPDATE;

    IF v_session.capture_idempotency_key IS NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'CAPTURE_COMPOSITION_REQUIRED',
        'error', 'plan_persist_race_unresolved'
      );
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'kind', 'resumed',
      'provider_capture_target_pence', v_session.provider_capture_target_pence,
      'capture_idempotency_key', v_session.capture_idempotency_key,
      'trip_fare_component_pence', v_session.trip_fare_component_pence,
      'tip_component_pence', v_session.tip_component_pence,
      'receivable_component_pence', v_session.receivable_component_pence,
      'preauth_buffer_component_pence', v_buffer,
      'capture_composition_frozen_at', v_session.capture_composition_frozen_at,
      'lock_owner', v_owner,
      'payment_session_id', p_payment_session_id,
      'provider_order_id', v_order
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'kind', 'created',
    'provider_capture_target_pence', v_target,
    'capture_idempotency_key', v_key,
    'trip_fare_component_pence', v_fare,
    'tip_component_pence', v_tip,
    'receivable_component_pence', v_reserved,
    'preauth_buffer_component_pence', v_buffer,
    'capture_composition_frozen_at', v_now,
    'lock_owner', v_owner,
    'payment_session_id', p_payment_session_id,
    'provider_order_id', v_order
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.payment_session_acquire_capture_composition(
  uuid, text, integer, integer, integer, integer, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.payment_session_acquire_capture_composition(
  uuid, text, integer, integer, integer, integer, text, text
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payment_session_acquire_capture_composition(
  uuid, text, integer, integer, integer, integer, text, text
) TO service_role;

COMMENT ON FUNCTION public.payment_session_acquire_capture_composition(
  uuid, text, integer, integer, integer, integer, text, text
) IS
  'Atomic capture composition: advisory_xact_lock(session) + FOR UPDATE + freeze/resume plan. Edge must call only this RPC before provider POST.';
