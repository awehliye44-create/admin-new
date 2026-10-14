-- Scenarios for 20261217110000_waiting_shortfall_receivable_safety on a throwaway cluster.
-- Run via run_waiting_shortfall_receivable_safety.sh (applies setup + real migrations first).

\set ON_ERROR_STOP 1

CREATE OR REPLACE FUNCTION pg_temp.as_role(p_role text, p_sub text DEFAULT NULL) RETURNS void
LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.role', coalesce(p_role, ''), false),
         set_config('request.jwt.claim.sub', coalesce(p_sub, ''), false);
$$;

CREATE OR REPLACE FUNCTION pg_temp.expect_error(p_sql text, p_fragment text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN others THEN
    IF position(p_fragment IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'expected error containing "%", got "%"', p_fragment, SQLERRM;
    END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'expected error containing "%", statement succeeded', p_fragment;
END $$;

INSERT INTO public.customers (id) VALUES ('00000000-0000-0000-0000-0000000000c1');
INSERT INTO public.trips (id, trip_code) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'SRC-1'),
  ('00000000-0000-0000-0000-0000000000a2', 'RECOVERY-1'),
  ('00000000-0000-0000-0000-0000000000a3', 'NEXT-1'),
  ('00000000-0000-0000-0000-0000000000a4', 'SRC-2'),
  ('00000000-0000-0000-0000-0000000000a5', 'RECOVERY-2'),
  ('00000000-0000-0000-0000-0000000000a6', 'CANCELLED-1'),
  ('00000000-0000-0000-0000-0000000000a7', 'NO-RECEIVABLE');
INSERT INTO public.payment_sessions (id, trip_id, provider_order_id) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'ord-src-1'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'ord-rec-1'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a3', 'ord-next-1'),
  ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000a4', 'ord-src-2'),
  ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000a5', 'ord-rec-2'),
  ('00000000-0000-0000-0000-0000000000b6', '00000000-0000-0000-0000-0000000000a6', 'ord-cancel-1'),
  ('00000000-0000-0000-0000-0000000000b7', '00000000-0000-0000-0000-0000000000a7', 'ord-none');

-- ─── 1. Receivable creation is idempotent (partial capture + retry / duplicate callback) ─
SELECT pg_temp.as_role('service_role');
DO $$
DECLARE r1 jsonb; r2 jsonb;
BEGIN
  r1 := public.customer_receivable_record_declined_increment(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000b1', NULL, 'DECLINED_INCREMENTAL_AUTHORISATION',
    'PICKUP_WAITING_DECLINED', 36, 'gbp',
    'receivable:trip:00000000-0000-0000-0000-0000000000a1:declined_waiting_v1', '{}'::jsonb);
  r2 := public.customer_receivable_record_declined_increment(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000b1', NULL, 'DECLINED_INCREMENTAL_AUTHORISATION',
    'PICKUP_WAITING_DECLINED', 36, 'gbp',
    'receivable:trip:00000000-0000-0000-0000-0000000000a1:declined_waiting_v1', '{}'::jsonb);
  ASSERT (r1->>'created')::boolean, '1: first record creates';
  ASSERT NOT (r2->>'created')::boolean, '1: retry does not create';
  ASSERT r1->>'receivable_id' = r2->>'receivable_id', '1: same receivable';
  ASSERT (SELECT count(*) FROM public.customer_receivables) = 1, '1: one row';
END $$;

-- ─── 2. Next-booking recovery: reserve → capture → settle → repeat settle no-op ─
DO $$
DECLARE res jsonb; s1 jsonb; s2 jsonb; again jsonb;
BEGIN
  res := public.customer_receivable_reserve_for_preauth(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b2',
    '00000000-0000-0000-0000-0000000000a2', 'gbp');
  ASSERT (res->>'reserved_total_pence')::int = 36, '2: reserved 36';
  UPDATE public.payment_sessions
  SET captured_amount_pence = 740, trip_fare_component_pence = 704, tip_component_pence = 0,
      receivable_component_pence = 36
  WHERE id = '00000000-0000-0000-0000-0000000000b2';

  s1 := public.customer_receivable_settle_from_provider_capture(
    '00000000-0000-0000-0000-0000000000b2', 'ord-rec-1', 'COMPLETED', 740, 704);
  ASSERT (s1->>'debt_applied_pence')::int = 36, '2: debt applied 36';
  ASSERT (s1->>'current_trip_fare_allocation_pence')::int = 704, '2: trip fare 704 kept separate';
  -- Duplicate provider callback.
  s2 := public.customer_receivable_settle_from_provider_capture(
    '00000000-0000-0000-0000-0000000000b2', 'ord-rec-1', 'COMPLETED', 740, 704);
  ASSERT (s2->>'debt_applied_pence')::int = 0, '2: repeat settle applies nothing';
  ASSERT (SELECT status FROM public.customer_receivables) = 'SETTLED', '2: settled';
  ASSERT (SELECT count(*) FROM public.customer_receivable_events WHERE event_type = 'SETTLED') = 1,
    '2: one SETTLED event';

  -- 3. Duplicate debt collection on a subsequent booking is impossible.
  again := public.customer_receivable_reserve_for_preauth(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b3',
    '00000000-0000-0000-0000-0000000000a3', 'gbp');
  ASSERT (again->>'reserved_total_pence')::int = 0, '3: settled debt never re-reserved';
END $$;

-- ─── 4. Release guard: capture already collected the debt → release refused, settle clears it ─
DO $$
DECLARE rel jsonb; s jsonb; nxt jsonb; v_status text;
BEGIN
  PERFORM public.customer_receivable_record_declined_increment(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a4',
    '00000000-0000-0000-0000-0000000000b4', NULL, 'DECLINED_INCREMENTAL_AUTHORISATION',
    'PICKUP_WAITING_DECLINED', 50, 'gbp',
    'receivable:trip:00000000-0000-0000-0000-0000000000a4:declined_waiting_v1', '{}'::jsonb);
  PERFORM public.customer_receivable_reserve_for_preauth(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b5',
    '00000000-0000-0000-0000-0000000000a5', 'gbp');
  UPDATE public.payment_sessions
  SET captured_amount_pence = 1050, trip_fare_component_pence = 1000, tip_component_pence = 0,
      receivable_component_pence = 50
  WHERE id = '00000000-0000-0000-0000-0000000000b5';

  -- A dispose/release racing ahead of settlement must not reopen captured debt.
  rel := public.customer_receivable_release_reservations('00000000-0000-0000-0000-0000000000b5', 'stale_dispose');
  ASSERT (rel->>'released')::int = 0, '4: nothing released';
  ASSERT (rel->>'refused_debt_captured')::int = 1, '4: release refused';
  SELECT status INTO v_status FROM public.customer_receivables
  WHERE source_trip_id = '00000000-0000-0000-0000-0000000000a4';
  ASSERT v_status = 'RESERVED', '4: still reserved, not reopened';
  ASSERT EXISTS (
    SELECT 1 FROM public.customer_receivable_events
    WHERE event_type = 'MANUAL_REVIEW' AND metadata->>'release_refused' = 'debt_captured'
  ), '4: refusal recorded';

  nxt := public.customer_receivable_reserve_for_preauth(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b3',
    '00000000-0000-0000-0000-0000000000a3', 'gbp');
  ASSERT (nxt->>'reserved_total_pence')::int = 0, '4: captured debt not offered to the next booking';

  s := public.customer_receivable_settle_from_provider_capture(
    '00000000-0000-0000-0000-0000000000b5', 'ord-rec-2', 'COMPLETED', 1050, 1000);
  ASSERT (s->>'debt_applied_pence')::int = 50, '4: settle clears it';
END $$;

-- ─── 5. Release still works when the session never captured (cancelled booking) ─
DO $$
DECLARE rel jsonb; v_status text;
BEGIN
  PERFORM public.customer_receivable_record_declined_increment(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a6',
    '00000000-0000-0000-0000-0000000000b6', NULL, 'DECLINED_INCREMENTAL_AUTHORISATION',
    'PICKUP_WAITING_DECLINED', 20, 'gbp',
    'receivable:trip:00000000-0000-0000-0000-0000000000a6:declined_waiting_v1', '{}'::jsonb);
  PERFORM public.customer_receivable_reserve_for_preauth(
    '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b3',
    '00000000-0000-0000-0000-0000000000a3', 'gbp');
  UPDATE public.payment_sessions
  SET captured_amount_pence = 0, trip_fare_component_pence = 900, tip_component_pence = 0,
      receivable_component_pence = 20
  WHERE id = '00000000-0000-0000-0000-0000000000b3';
  rel := public.customer_receivable_release_reservations('00000000-0000-0000-0000-0000000000b3', 'session_cancelled');
  ASSERT (rel->>'released')::int = 1, '5: released';
  SELECT status INTO v_status FROM public.customer_receivables
  WHERE source_trip_id = '00000000-0000-0000-0000-0000000000a6';
  ASSERT v_status = 'OPEN', '5: reopened for the next booking';
END $$;

-- ─── 6. Finance exception: idempotent, amounts frozen ─
DO $$
DECLARE e1 jsonb; e2 jsonb;
BEGIN
  e1 := public.finance_record_shortfall_exception(
    'shortfall_exception:trip:00000000-0000-0000-0000-0000000000a7:declined_waiting_v1',
    '00000000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-0000000000b7', 'ord-none',
    '00000000-0000-0000-0000-0000000000c1', 'GBP', 1240, 1200, 40,
    'receivable_persistence_unavailable', 'could not serialize access', '{}'::jsonb);
  e2 := public.finance_record_shortfall_exception(
    'shortfall_exception:trip:00000000-0000-0000-0000-0000000000a7:declined_waiting_v1',
    '00000000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-0000000000b7', 'ord-none',
    '00000000-0000-0000-0000-0000000000c1', 'GBP', 1240, 1200, 41,
    'RECEIVABLE_PERSISTENCE_UNAVAILABLE', 'retry', '{}'::jsonb);
  ASSERT (e1->>'created')::boolean, '6: created';
  ASSERT NOT (e2->>'created')::boolean, '6: retry not created';
  ASSERT e1->>'exception_id' = e2->>'exception_id', '6: same exception';
  ASSERT (e2->>'occurrence_count')::int = 2, '6: occurrence counted';
  ASSERT (e2->>'shortfall_pence')::int = 40, '6: original shortfall kept';
  ASSERT NOT (e2->>'amount_matches')::boolean, '6: mismatch surfaced';
  ASSERT (SELECT failure_phase FROM public.finance_shortfall_exceptions) = 'RECEIVABLE_PERSISTENCE_UNAVAILABLE',
    '6: phase normalised';
  ASSERT (SELECT currency FROM public.finance_shortfall_exceptions) = 'gbp', '6: currency normalised';
END $$;

SELECT pg_temp.expect_error($$
  INSERT INTO public.finance_shortfall_exceptions
    (idempotency_key, trip_id, expected_fare_pence, captured_pence, shortfall_pence, failure_phase)
  VALUES ('x', '00000000-0000-0000-0000-0000000000a7', 10, 0, 10, 'X')
$$, 'direct_finance_shortfall_exception_mutation_denied');
SELECT pg_temp.expect_error($$
  DELETE FROM public.finance_shortfall_exceptions
$$, 'finance_shortfall_exceptions_delete_denied');
SELECT pg_temp.expect_error($$
  DO $d$ BEGIN
    PERFORM set_config('onecab.allow_finance_shortfall_exception_write', '1', true);
    UPDATE public.finance_shortfall_exceptions SET shortfall_pence = 1;
  END $d$
$$, 'finance_shortfall_exception_evidence_immutable');
SELECT pg_temp.expect_error($$
  SELECT public.finance_record_shortfall_exception('k', '00000000-0000-0000-0000-0000000000a7',
    NULL, NULL, NULL, 'gbp', 100, 100, 0, 'X', NULL, '{}'::jsonb)
$$, 'positive_shortfall_required');

-- Only service_role may record or resolve.
SELECT pg_temp.as_role('authenticated', '00000000-0000-0000-0000-0000000000f1');
SELECT pg_temp.expect_error($$
  SELECT public.finance_record_shortfall_exception('k2', '00000000-0000-0000-0000-0000000000a7',
    NULL, NULL, NULL, 'gbp', 100, 90, 10, 'X', NULL, '{}'::jsonb)
$$, 'not authorized');
SELECT pg_temp.expect_error($$
  SELECT public.finance_resolve_shortfall_exception_receivable(
    '00000000-0000-0000-0000-0000000000a7', gen_random_uuid())
$$, 'not authorized');

-- ─── 7. Write-off: finance access + named approver + note; refused when a receivable exists ─
SELECT pg_temp.expect_error($$
  SELECT public.finance_write_off_shortfall_exception(
    (SELECT id FROM public.finance_shortfall_exceptions LIMIT 1), 'Customer unreachable, absorbed by ONECAB')
$$, 'finance_access_denied');

SELECT set_config('test.finance_access', '1', false);
SELECT pg_temp.expect_error($$
  SELECT public.finance_write_off_shortfall_exception(
    (SELECT id FROM public.finance_shortfall_exceptions LIMIT 1), 'short')
$$, 'write_off_note_required');

DO $$
DECLARE w jsonb;
BEGIN
  w := public.finance_write_off_shortfall_exception(
    (SELECT id FROM public.finance_shortfall_exceptions LIMIT 1), 'Customer unreachable, absorbed by ONECAB');
  ASSERT (w->>'written_off_pence')::int = 40, '7: 40p written off';
  ASSERT (SELECT status FROM public.finance_shortfall_exceptions) = 'WRITTEN_OFF', '7: status';
  ASSERT (SELECT resolved_by FROM public.finance_shortfall_exceptions) = '00000000-0000-0000-0000-0000000000f1',
    '7: approver recorded';
  ASSERT EXISTS (
    SELECT 1 FROM public.audit_logs
    WHERE event_type = 'FINANCE_SHORTFALL_WRITTEN_OFF' AND (details->>'money_moved')::boolean = false
  ), '7: audited, no money moved';
END $$;

SELECT pg_temp.expect_error($$
  SELECT public.finance_write_off_shortfall_exception(
    (SELECT id FROM public.finance_shortfall_exceptions LIMIT 1), 'Second attempt should be refused')
$$, 'exception_not_open');

-- Write-off refused while a receivable exists for the trip (resolve instead).
SELECT pg_temp.as_role('service_role');
SELECT public.finance_record_shortfall_exception(
  'shortfall_exception:trip:00000000-0000-0000-0000-0000000000a1:declined_waiting_v1',
  '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'ord-src-1',
  '00000000-0000-0000-0000-0000000000c1', 'gbp', 740, 704, 36, 'RECEIVABLE_PERSISTENCE_UNAVAILABLE', NULL, '{}'::jsonb);
SELECT pg_temp.as_role('authenticated', '00000000-0000-0000-0000-0000000000f1');
SELECT pg_temp.expect_error($$
  SELECT public.finance_write_off_shortfall_exception(
    (SELECT id FROM public.finance_shortfall_exceptions WHERE trip_id = '00000000-0000-0000-0000-0000000000a1'),
    'Should resolve against the receivable instead')
$$, 'receivable_exists_resolve_instead');

-- ─── 8. Resolve after the receivable is recorded on retry ─
SELECT pg_temp.as_role('service_role');
SELECT pg_temp.expect_error($$
  SELECT public.finance_resolve_shortfall_exception_receivable(
    '00000000-0000-0000-0000-0000000000a7',
    (SELECT id FROM public.customer_receivables WHERE source_trip_id = '00000000-0000-0000-0000-0000000000a1'))
$$, 'receivable_trip_mismatch');
DO $$
DECLARE r jsonb; again jsonb;
BEGIN
  r := public.finance_resolve_shortfall_exception_receivable(
    '00000000-0000-0000-0000-0000000000a1',
    (SELECT id FROM public.customer_receivables WHERE source_trip_id = '00000000-0000-0000-0000-0000000000a1'));
  ASSERT (r->>'resolved')::int = 1, '8: resolved';
  again := public.finance_resolve_shortfall_exception_receivable(
    '00000000-0000-0000-0000-0000000000a1',
    (SELECT id FROM public.customer_receivables WHERE source_trip_id = '00000000-0000-0000-0000-0000000000a1'));
  ASSERT (again->>'resolved')::int = 0, '8: resolve is idempotent';
  -- A late duplicate exception call after resolution only counts the occurrence.
  PERFORM public.finance_record_shortfall_exception(
    'shortfall_exception:trip:00000000-0000-0000-0000-0000000000a1:declined_waiting_v1',
    '00000000-0000-0000-0000-0000000000a1', NULL, NULL, NULL, 'gbp', 740, 704, 36, 'X', NULL, '{}'::jsonb);
  ASSERT (SELECT status FROM public.finance_shortfall_exceptions
          WHERE trip_id = '00000000-0000-0000-0000-0000000000a1') = 'RESOLVED_RECEIVABLE_RECORDED',
    '8: stays resolved';
END $$;

SELECT 'waiting_shortfall_receivable_safety: ALL SCENARIOS PASSED' AS result;
