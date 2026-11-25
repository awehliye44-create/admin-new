-- #92A real PostgreSQL integration checks (local only).
-- Run via payment_ssot_92a_integration_isolated.sh against an isolated DB with
-- Stage A–D migrations applied. No live Revolut. No production mutations.
-- Synthetic ids: 00000000-0000-4000-9200-* / client_action_id TEST-92A-*

\set ON_ERROR_STOP on
\timing off

DO $$
DECLARE
  v_trip uuid := '00000000-0000-4000-9200-000000000001';
  v_sess uuid := '00000000-0000-4000-9200-000000000010';
  v_sess_fee uuid := '00000000-0000-4000-9200-000000000011';
  v_pass int := 0;
  v_fail int := 0;
  v_msg text;
  v_ok boolean;
  v_cnt int;
  v_id1 uuid;
  v_id2 uuid;
  v_fence uuid := '00000000-0000-4000-9200-00000000f001';
  v_fence_stale uuid := '00000000-0000-4000-9200-00000000f002';
  v_exec text;
  v_state text;
  v_cutover_stage text;
  v_strict boolean;
BEGIN
  -- Cleanup leftovers
  DELETE FROM public.payment_financial_events
    WHERE payment_session_id IN (v_sess, v_sess_fee)
       OR trip_id = v_trip;
  DELETE FROM public.payment_financial_operations
    WHERE payment_session_id IN (v_sess, v_sess_fee) OR trip_id = v_trip;
  DELETE FROM public.payment_payable_snapshots WHERE trip_id = v_trip;
  DELETE FROM public.payment_sessions WHERE id IN (v_sess, v_sess_fee);
  DELETE FROM public.trips WHERE id = v_trip;

  INSERT INTO public.trips (id, final_customer_fare_pence, locked_base_fare_pence, financial_model)
  VALUES (v_trip, 1000, 1000, 'PLATFORM_COLLECTED');

  INSERT INTO public.payment_sessions (id, trip_id, purpose, authorised_amount_pence, captured_amount_pence)
  VALUES
    (v_sess, v_trip, 'TRIP_FARE', 1000, NULL),
    (v_sess_fee, v_trip, 'TERMINAL_FEE', 500, NULL);

  -- ── 1. Unique logical operation (active) ───────────────────────────────────
  INSERT INTO public.payment_financial_operations (
    execution_id, fence, payment_session_id, trip_id, op_type,
    logical_idempotency_key, state, requested_amount_pence, provider_order_id,
    lease_expires_at, provider_post_inflight
  ) VALUES (
    'CAPTURE:' || v_trip::text || ':a1',
    gen_random_uuid(), v_sess, v_trip, 'CAPTURE',
    'CAPTURE:fare:' || v_sess::text || ':ord1:1000:v1:e0',
    'CAPTURE_REQUESTED', 1000, 'ord1',
    now() + interval '2 minutes', false
  );
  BEGIN
    INSERT INTO public.payment_financial_operations (
      execution_id, fence, payment_session_id, trip_id, op_type,
      logical_idempotency_key, state, requested_amount_pence, provider_order_id,
      lease_expires_at, provider_post_inflight
    ) VALUES (
      'CAPTURE:' || v_trip::text || ':a2',
      gen_random_uuid(), v_sess, v_trip, 'CAPTURE',
      'CAPTURE:fare:' || v_sess::text || ':ord1:1000:v1:e0',
      'CAPTURE_REQUESTED', 1000, 'ord1',
      now() + interval '2 minutes', false
    );
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL unique_logical_active (duplicate allowed)';
  EXCEPTION WHEN unique_violation THEN
    v_pass := v_pass + 1;
    RAISE NOTICE 'PASS unique_logical_active';
  END;

  -- ── 2. Unique execution_id ─────────────────────────────────────────────────
  BEGIN
    INSERT INTO public.payment_financial_operations (
      execution_id, fence, payment_session_id, trip_id, op_type,
      logical_idempotency_key, state, requested_amount_pence, provider_order_id,
      lease_expires_at, provider_post_inflight
    ) VALUES (
      'CAPTURE:' || v_trip::text || ':a1',
      gen_random_uuid(), v_sess, v_trip, 'CAPTURE',
      'CAPTURE:fare:' || v_sess::text || ':ord1:1000:v2:e0',
      'CAPTURE_REQUESTED', 1000, 'ord1',
      now() + interval '2 minutes', false
    );
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL unique_execution_id (duplicate allowed)';
  EXCEPTION WHEN unique_violation THEN
    v_pass := v_pass + 1;
    RAISE NOTICE 'PASS unique_execution_id';
  END;

  -- ── 3. Active claim unique when provider_post_inflight ─────────────────────
  UPDATE public.payment_financial_operations
  SET provider_post_inflight = true, state = 'CAPTURE_PENDING'
  WHERE execution_id = 'CAPTURE:' || v_trip::text || ':a1';

  BEGIN
    INSERT INTO public.payment_financial_operations (
      execution_id, fence, payment_session_id, trip_id, op_type,
      logical_idempotency_key, state, requested_amount_pence, provider_order_id,
      lease_expires_at, provider_post_inflight
    ) VALUES (
      'CAPTURE:' || v_trip::text || ':inflight2',
      gen_random_uuid(), v_sess, v_trip, 'CAPTURE',
      'CAPTURE:fare:' || v_sess::text || ':ord1:1100:v1:e0',
      'CAPTURE_PENDING', 1100, 'ord1',
      now() + interval '2 minutes', true
    );
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL session_active_claim_inflight (duplicate allowed)';
  EXCEPTION WHEN unique_violation THEN
    v_pass := v_pass + 1;
    RAISE NOTICE 'PASS session_active_claim_inflight';
  END;

  -- ── 4. Fare vs non-fare capture on same provider order (distinct logical keys) ─
  INSERT INTO public.payment_financial_operations (
    execution_id, fence, payment_session_id, trip_id, op_type,
    logical_idempotency_key, state, requested_amount_pence, provider_order_id,
    lease_expires_at, provider_post_inflight
  ) VALUES (
    'CAPTURE:' || v_trip::text || ':fee1',
    gen_random_uuid(), v_sess_fee, v_trip, 'CAPTURE',
    'CAPTURE:terminal_fee:' || v_sess_fee::text || ':ord1:250:v1:e0',
    'CAPTURE_REQUESTED', 250, 'ord1',
    now() + interval '2 minutes', false
  );
  SELECT count(*) INTO v_cnt FROM public.payment_financial_operations
  WHERE provider_order_id = 'ord1' AND trip_id = v_trip;
  IF v_cnt >= 2 THEN
    v_pass := v_pass + 1;
    RAISE NOTICE 'PASS fare_vs_nonfare_same_order';
  ELSE
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL fare_vs_nonfare_same_order cnt=%', v_cnt;
  END IF;

  -- ── 5. Concurrent snapshot version uniqueness ──────────────────────────────
  INSERT INTO public.payment_payable_snapshots (
    trip_id, version, source, total_payable_pence, waiting_basis
  ) VALUES (v_trip, 1, 'booking', 1000, 'none');
  BEGIN
    INSERT INTO public.payment_payable_snapshots (
      trip_id, version, source, total_payable_pence, waiting_basis
    ) VALUES (v_trip, 1, 'completion', 1000, 'columns');
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL snapshot_version_unique (duplicate allowed)';
  EXCEPTION WHEN unique_violation THEN
    v_pass := v_pass + 1;
    RAISE NOTICE 'PASS snapshot_version_unique';
  END;
  INSERT INTO public.payment_payable_snapshots (
    trip_id, version, source, total_payable_pence, waiting_basis, waiting_pence
  ) VALUES (v_trip, 2, 'completion', 1032, 'columns', 32);
  SELECT count(*) INTO v_cnt FROM public.payment_payable_snapshots WHERE trip_id = v_trip;
  IF v_cnt = 2 THEN
    v_pass := v_pass + 1;
    RAISE NOTICE 'PASS snapshot_version_monotonic';
  ELSE
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL snapshot_version_monotonic cnt=%', v_cnt;
  END IF;

  -- ── 6. Expired lease + provider_post_inflight still blocks second claim index ─
  UPDATE public.payment_financial_operations
  SET lease_expires_at = now() - interval '1 minute',
      provider_post_inflight = true,
      state = 'CAPTURE_PENDING'
  WHERE execution_id = 'CAPTURE:' || v_trip::text || ':a1';
  BEGIN
    INSERT INTO public.payment_financial_operations (
      execution_id, fence, payment_session_id, trip_id, op_type,
      logical_idempotency_key, state, requested_amount_pence, provider_order_id,
      lease_expires_at, provider_post_inflight
    ) VALUES (
      'CAPTURE:' || v_trip::text || ':after_lease',
      gen_random_uuid(), v_sess, v_trip, 'CAPTURE',
      'CAPTURE:fare:' || v_sess::text || ':ord1:1000:v3:e0',
      'CAPTURE_PENDING', 1000, 'ord1',
      now() + interval '2 minutes', true
    );
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL expired_lease_inflight_blocks (duplicate allowed)';
  EXCEPTION WHEN unique_violation THEN
    v_pass := v_pass + 1;
    RAISE NOTICE 'PASS expired_lease_inflight_blocks';
  END;

  -- ── 7. Stale fence rejection (update affects 0 rows) ───────────────────────
  SELECT id INTO v_id1 FROM public.payment_financial_operations
  WHERE execution_id = 'CAPTURE:' || v_trip::text || ':a1';
  UPDATE public.payment_financial_operations
  SET fence = v_fence, provider_post_inflight = false, state = 'CAPTURE_UNKNOWN'
  WHERE id = v_id1;

  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  UPDATE public.payment_financial_operations
  SET state = 'FULLY_CAPTURED', provider_confirmed_amount_pence = 1000, provider_post_inflight = false
  WHERE id = v_id1 AND fence = v_fence_stale;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt = 0 THEN
    v_pass := v_pass + 1;
    RAISE NOTICE 'PASS stale_fence_rejection';
  ELSE
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL stale_fence_rejection rows=%', v_cnt;
  END IF;

  UPDATE public.payment_financial_operations
  SET state = 'FULLY_CAPTURED', provider_confirmed_amount_pence = 1000, provider_post_inflight = false
  WHERE id = v_id1 AND fence = v_fence;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt = 1 THEN
    v_pass := v_pass + 1;
    RAISE NOTICE 'PASS correct_fence_complete';
  ELSE
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL correct_fence_complete rows=%', v_cnt;
  END IF;

  -- ── 8. Worker crash before POST: claim without inflight → reclaimable logical ─
  -- Terminalise prior, insert new claim (simulates crash before markDispatched).
  INSERT INTO public.payment_financial_operations (
    execution_id, fence, payment_session_id, trip_id, op_type,
    logical_idempotency_key, state, requested_amount_pence, provider_order_id,
    lease_expires_at, provider_post_inflight
  ) VALUES (
    'CAPTURE:' || v_trip::text || ':pre_post',
    gen_random_uuid(), v_sess, v_trip, 'CAPTURE',
    'CAPTURE:fare:' || v_sess::text || ':ord2:1000:v2:e0',
    'CAPTURE_REQUESTED', 1000, 'ord2',
    now() - interval '1 minute', false
  );
  -- Same logical key while still non-terminal → blocked (duplicate settlement attempt)
  BEGIN
    INSERT INTO public.payment_financial_operations (
      execution_id, fence, payment_session_id, trip_id, op_type,
      logical_idempotency_key, state, requested_amount_pence, provider_order_id,
      lease_expires_at, provider_post_inflight
    ) VALUES (
      'CAPTURE:' || v_trip::text || ':dup_settle',
      gen_random_uuid(), v_sess, v_trip, 'CAPTURE',
      'CAPTURE:fare:' || v_sess::text || ':ord2:1000:v2:e0',
      'CAPTURE_REQUESTED', 1000, 'ord2',
      now() + interval '2 minutes', false
    );
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL duplicate_settlement_attempt (allowed)';
  EXCEPTION WHEN unique_violation THEN
    v_pass := v_pass + 1;
    RAISE NOTICE 'PASS duplicate_settlement_attempt';
  END;

  -- Mark cancelled (crash recovery path) then allow new claim
  UPDATE public.payment_financial_operations
  SET state = 'CANCELLED'
  WHERE execution_id = 'CAPTURE:' || v_trip::text || ':pre_post';
  INSERT INTO public.payment_financial_operations (
    execution_id, fence, payment_session_id, trip_id, op_type,
    logical_idempotency_key, state, requested_amount_pence, provider_order_id,
    lease_expires_at, provider_post_inflight
  ) VALUES (
    'CAPTURE:' || v_trip::text || ':after_cancel',
    gen_random_uuid(), v_sess, v_trip, 'CAPTURE',
    'CAPTURE:fare:' || v_sess::text || ':ord2:1000:v2:e0',
    'CAPTURE_REQUESTED', 1000, 'ord2',
    now() + interval '2 minutes', false
  );
  v_pass := v_pass + 1;
  RAISE NOTICE 'PASS reclaim_after_cancelled_pre_post';

  -- ── 9. Strict confirmed-only trip mirror (Stage D) ─────────────────────────
  SELECT stage, strict_trip_capture_mirror INTO v_cutover_stage, v_strict
  FROM public.payment_ssot_cutover WHERE id = 1;
  IF v_strict IS TRUE THEN
    BEGIN
      UPDATE public.trips SET capture_amount_pence = 999 WHERE id = v_trip;
      v_fail := v_fail + 1;
      RAISE NOTICE 'FAIL strict_trip_mirror (false capture allowed)';
    EXCEPTION WHEN check_violation OR raise_exception THEN
      v_pass := v_pass + 1;
      RAISE NOTICE 'PASS strict_trip_mirror_rejects_unconfirmed';
    END;
    -- Project confirmed then allow matching mirror
    UPDATE public.payment_sessions
    SET capture_confirmed_pence = 1000,
        capture_confirmation_state = 'FULLY_CAPTURED',
        provider_state = 'COMPLETED',
        provider_state_verified_at = now(),
        captured_amount_pence = 1000
    WHERE id = v_sess;
    UPDATE public.trips SET capture_amount_pence = 1000 WHERE id = v_trip;
    v_pass := v_pass + 1;
    RAISE NOTICE 'PASS strict_trip_mirror_allows_confirmed';
  ELSE
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL strict_flag_expected_on stage=% strict=%', v_cutover_stage, v_strict;
  END IF;

  -- ── 10. Diagnostics sanitize strips secrets ────────────────────────────────
  INSERT INTO public.payment_financial_events (
    payment_session_id, trip_id, event_type, detail
  ) VALUES (
    v_sess, v_trip, 'test_sanitize',
    jsonb_build_object('token', 'secret123', 'ok', true, 'password', 'x')
  );
  SELECT detail INTO v_msg FROM public.payment_financial_events
  WHERE payment_session_id = v_sess AND event_type = 'test_sanitize'
  ORDER BY id DESC LIMIT 1;
  IF (v_msg::jsonb ? 'token') OR (v_msg::jsonb ? 'password') THEN
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL events_sanitize detail=%', v_msg;
  ELSIF (v_msg::jsonb ->> 'ok') = 'true' THEN
    v_pass := v_pass + 1;
    RAISE NOTICE 'PASS events_sanitize';
  ELSE
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL events_sanitize_unexpected detail=%', v_msg;
  END IF;

  -- ── 11. Completion gate never blocks (ok=true) + uses snapshot when present ─
  SELECT (assert_trip_completion_customer_payment_gate(v_trip)->>'ok')::boolean INTO v_ok;
  IF v_ok IS TRUE THEN
    v_pass := v_pass + 1;
    RAISE NOTICE 'PASS completion_gate_non_blocking';
  ELSE
    v_fail := v_fail + 1;
    RAISE NOTICE 'FAIL completion_gate_non_blocking';
  END IF;

  -- Cleanup synthetic
  DELETE FROM public.payment_financial_events
    WHERE payment_session_id IN (v_sess, v_sess_fee) OR trip_id = v_trip;
  DELETE FROM public.payment_financial_operations
    WHERE payment_session_id IN (v_sess, v_sess_fee) OR trip_id = v_trip;
  DELETE FROM public.payment_payable_snapshots WHERE trip_id = v_trip;
  DELETE FROM public.payment_sessions WHERE id IN (v_sess, v_sess_fee);
  DELETE FROM public.trips WHERE id = v_trip;

  RAISE NOTICE 'TOTAL fail=% pass=% skipped=0', v_fail, v_pass;
  IF v_fail > 0 THEN
    RAISE EXCEPTION 'payment_ssot_92a_integration FAILED fail=% pass=%', v_fail, v_pass;
  END IF;
  RAISE NOTICE 'ALL payment_ssot_92a_integration CHECKS PASSED';
END $$;
