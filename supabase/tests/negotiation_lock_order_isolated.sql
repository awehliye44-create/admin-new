-- ============================================================================
-- Negotiation lock-order / concurrency harness  --  VERIFY
--   (run by negotiation_lock_order_concurrency_isolated.sh after every race has finished)
--
-- Reads neg_iso.worker_out (what each parallel session observed) + the final trip/offer rows,
-- writes verdicts to neg_iso.verdict, and RAISES (=> non-zero exit) on any FAIL / SKIPPED /
-- failed worker. Scenario M (bounded retry + domain error) is executed here with a fault-injected
-- REAL 40P01 inside the core UPDATE.
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);

CREATE FUNCTION neg_iso.v(p_scn text, p_name text, p_ok boolean, p_evidence text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO neg_iso.verdict(scenario, check_name, verdict, evidence)
  VALUES (p_scn, p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_evidence) $$;

-- Final-state invariants shared by every race (one row per violating trip).
CREATE VIEW neg_iso.trip_violations AS
SELECT s.scn, s.iter, t.id AS trip_id,
  concat_ws('; ',
    CASE WHEN t.driver_id IS NOT NULL AND t.confirmed_driver_id IS DISTINCT FROM t.driver_id
         THEN 'driver_id <> confirmed_driver_id' END,
    CASE WHEN t.driver_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.ride_offers o WHERE o.trip_id = t.id AND o.driver_id = t.driver_id AND o.status = 'accepted')
         THEN 'assigned driver has no accepted offer' END,
    CASE WHEN t.driver_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM public.ride_offers o WHERE o.trip_id = t.id AND o.status IN ('pending', 'countered'))
         THEN 'assigned trip still has live (pending/countered) offers' END,
    CASE WHEN public.is_trip_terminal_cancel_status(t.status) AND (t.driver_id IS NOT NULL OR EXISTS (
           SELECT 1 FROM public.ride_offers o WHERE o.trip_id = t.id AND o.status IN ('pending', 'countered')))
         THEN 'cancelled trip has a driver or live offers' END,
    CASE WHEN t.status = 'negotiating' AND (t.driver_id IS NOT NULL OR NOT EXISTS (
           SELECT 1 FROM public.ride_offers o
            WHERE o.trip_id = t.id AND o.id = t.current_negotiation_id AND o.status = 'countered'))
         THEN 'negotiating trip without a live negotiation offer (or with a driver)' END,
    CASE WHEN (SELECT count(*) FROM public.ride_offers o WHERE o.trip_id = t.id AND o.status = 'accepted'
                  AND o.negotiation_status = 'confirmed' AND o.revoked_reason IS NULL) > 1
         THEN 'more than one accepted offer' END,
    CASE WHEN t.status = 'negotiating' AND EXISTS (
           SELECT 1 FROM public.ride_offers o WHERE o.trip_id = t.id AND o.status = 'accepted' AND o.revoked_reason IS NULL)
         THEN 'negotiating trip with an accepted offer' END
  ) AS violation
FROM neg_iso.trip_scn s
JOIN public.trips t ON t.id = s.trip_id;

-- One row per worker with a flattened outcome label.
CREATE VIEW neg_iso.outcomes AS
SELECT w.scn, w.iter, w.worker, w.action,
  CASE
    WHEN (w.result ->> 'threw') = 'true' THEN 'threw:' || (w.result ->> 'sqlstate') || ':' || (w.result ->> 'message')
    WHEN (w.result ->> 'ok') = 'true' THEN 'ok'
    ELSE 'err:' || coalesce(w.result -> 'res' ->> 'error', w.result -> 'res' ->> 'reason', 'unknown')
  END AS outcome,
  coalesce((w.result ->> 'raw_contention')::boolean, false) AS raw_contention,
  (w.result ->> 'sqlstate') AS sqlstate,
  (w.result ->> 'dur_ms')::numeric AS dur_ms,
  w.result
FROM neg_iso.worker_out w;

DO $v$
DECLARE
  s text;
  r record;
  v_n int;
  v_expected int;
  v_txt text;
BEGIN
  -- ---------------------------------------------------------------- common
  FOREACH s IN ARRAY ARRAY['L', 'N1', 'N2', 'N3', 'N4', 'N5'] LOOP
    v_expected := CASE s WHEN 'L' THEN 12 WHEN 'N1' THEN 24 WHEN 'N2' THEN 30 WHEN 'N3' THEN 18 WHEN 'N4' THEN 24 WHEN 'N5' THEN 24 END;
    SELECT count(*) INTO v_n FROM neg_iso.worker_out WHERE scn = s;
    PERFORM neg_iso.v(s, 'workers_all_reported', v_n = v_expected, format('%s of %s worker results recorded', v_n, v_expected));

    SELECT count(*), string_agg(DISTINCT coalesce(sqlstate, '?') || ':' || (result ->> 'message'), ' | ')
      INTO v_n, v_txt FROM neg_iso.outcomes WHERE scn = s AND raw_contention;
    PERFORM neg_iso.v(s, 'no_raw_40P01_40001_55P03', v_n = 0,
      CASE WHEN v_n = 0 THEN 'no worker ever saw a raw lock/serialization error'
           ELSE v_n || ' worker(s) received a raw lock error: ' || v_txt END);

    SELECT count(*), string_agg(DISTINCT sqlstate || ':' || (result ->> 'message'), ' | ')
      INTO v_n, v_txt FROM neg_iso.outcomes
     WHERE scn = s AND (result ->> 'threw') = 'true' AND sqlstate IS DISTINCT FROM 'P0001';
    PERFORM neg_iso.v(s, 'only_domain_errors', v_n = 0,
      CASE WHEN v_n = 0 THEN 'every thrown error was a domain (RAISE EXCEPTION) message'
           ELSE v_n || ' non-domain error(s): ' || v_txt END);

    IF s <> 'L' THEN
      SELECT count(*), string_agg(scn || '#' || iter || ': ' || violation, ' | ')
        INTO v_n, v_txt FROM neg_iso.trip_violations WHERE scn = s AND violation <> '';
      PERFORM neg_iso.v(s, 'final_state_consistent', v_n = 0,
        CASE WHEN v_n = 0 THEN 'every trip ended consistent (single assignment, no live offers on assigned/cancelled trips, negotiating => live negotiation offer)'
             ELSE v_n || ' inconsistent trip(s): ' || left(v_txt, 600) END);
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------- L: lock order proof
  SELECT count(*) FILTER (WHERE (p.result ->> 'probe') = 'free'),
         string_agg(a.action || '=' || coalesce(p.result ->> 'probe', '?'), ', ' ORDER BY p.iter)
    INTO v_n, v_txt
  FROM neg_iso.worker_out p
  JOIN neg_iso.worker_out a ON a.scn = 'L' AND a.iter = p.iter AND a.worker = 'rpc'
  WHERE p.scn = 'L' AND p.worker = 'probe';
  PERFORM neg_iso.v('L', 'offer_row_free_while_rpc_waits_on_trip_lock', v_n = 6,
    format('NOWAIT probe on the offer row while the RPC was queued behind the trip lock: %s', coalesce(v_txt, 'no probe rows')));

  SELECT count(*), string_agg(action || '=' || dur_ms::int || 'ms', ', ' ORDER BY iter)
    INTO v_n, v_txt
  FROM neg_iso.outcomes WHERE scn = 'L' AND worker = 'rpc' AND dur_ms >= 900;
  PERFORM neg_iso.v('L', 'rpc_really_waited_for_the_trip_lock', v_n = 6,
    format('%s/6 RPCs blocked >= 900ms behind the held trip lock (%s)', v_n, coalesce(v_txt, 'none')));

  SELECT count(*) INTO v_n FROM neg_iso.outcomes WHERE scn = 'L' AND worker = 'rpc' AND outcome = 'ok';
  PERFORM neg_iso.v('L', 'rpc_completes_after_trip_lock_released', v_n = 6, format('%s/6 RPCs completed successfully once the trip lock was released', v_n));

  -- ---------------------------------------------------------------- N1
  SELECT count(*) INTO v_n FROM neg_iso.outcomes
   WHERE scn = 'N1' AND worker = 'counter' AND outcome NOT IN ('ok') AND outcome NOT LIKE 'threw:P0001:%';
  PERFORM neg_iso.v('N1', 'counter_outcome_is_ok_or_domain_error', v_n = 0,
    (SELECT string_agg(DISTINCT outcome, ' | ') FROM neg_iso.outcomes WHERE scn = 'N1' AND worker = 'counter'));

  -- Same-offer race (iter 1-6): never BOTH a committed counter and a committed customer acceptance
  -- (that would sell the trip at the driver fare after the fare was already re-negotiated).
  SELECT count(*) INTO v_n
  FROM neg_iso.outcomes c JOIN neg_iso.outcomes a ON a.scn = 'N1' AND a.iter = c.iter AND a.worker = 'accept'
  WHERE c.scn = 'N1' AND c.worker = 'counter' AND c.iter <= 6 AND c.outcome = 'ok' AND a.outcome = 'ok'
    AND EXISTS (SELECT 1 FROM neg_iso.trip_scn ts JOIN public.trips t ON t.id = ts.trip_id
                 WHERE ts.scn = 'N1' AND ts.iter = c.iter AND t.driver_id IS NOT NULL AND t.final_fare_pence <> 570
                   AND t.final_customer_fare_pence <> 570);
  PERFORM neg_iso.v('N1', 'no_assignment_at_a_stale_fare_after_counter', v_n = 0,
    'where both succeeded, the assigned fare is the committed counter (570)');

  SELECT count(*) INTO v_n FROM neg_iso.outcomes WHERE scn = 'N1' AND worker = 'accept' AND iter > 6 AND outcome = 'ok';
  PERFORM neg_iso.v('N1', 'competing_driver_never_assigned_while_negotiation_holds_trip', v_n = 0,
    (SELECT string_agg(DISTINCT outcome, ' | ') FROM neg_iso.outcomes WHERE scn = 'N1' AND worker = 'accept' AND iter > 6));
  SELECT count(*) INTO v_n FROM (
    SELECT iter FROM neg_iso.outcomes WHERE scn = 'N1' AND iter <= 6 GROUP BY iter HAVING count(*) FILTER (WHERE outcome = 'ok') >= 1) x;
  PERFORM neg_iso.v('N1', 'same_offer_race_always_has_a_winner', v_n = 6, format('%s/6 races resolved by at least one successful action', v_n));

  SELECT string_agg(x, '; ' ORDER BY x) INTO v_txt FROM (
    SELECT (CASE WHEN c.iter <= 6 THEN 'same-offer' ELSE 'other-driver' END) || ' counter=' || c.outcome
           || ' accept=' || a.outcome || ' x' || count(*) AS x
      FROM neg_iso.outcomes c JOIN neg_iso.outcomes a ON a.scn = 'N1' AND a.iter = c.iter AND a.worker = 'accept'
     WHERE c.scn = 'N1' AND c.worker = 'counter'
     GROUP BY (c.iter <= 6), c.outcome, a.outcome) q;
  INSERT INTO neg_iso.verdict VALUES (DEFAULT, 'N1', 'outcome_matrix', 'INFO', v_txt);

  -- ---------------------------------------------------------------- N2
  SELECT count(*) INTO v_n FROM neg_iso.trip_scn s JOIN public.trips t ON t.id = s.trip_id
   WHERE s.scn = 'N2' AND NOT public.is_trip_terminal_cancel_status(t.status);
  PERFORM neg_iso.v('N2', 'cancellation_always_wins_final_state', v_n = 0,
    'every N2 trip ended in a terminal cancel status (cancelled / customer_cancelled) with all offers closed — no negotiation survived a cancellation');
  SELECT count(*) INTO v_n FROM neg_iso.outcomes
   WHERE scn = 'N2' AND worker IN ('admin_cancel', 'customer_cancel') AND outcome <> 'ok';
  PERFORM neg_iso.v('N2', 'cancellation_itself_never_fails', v_n = 0,
    (SELECT string_agg(DISTINCT outcome, ' | ') FROM neg_iso.outcomes WHERE scn = 'N2' AND worker IN ('admin_cancel', 'customer_cancel')));
  SELECT count(*) INTO v_n FROM neg_iso.outcomes
   WHERE scn = 'N2' AND worker IN ('counter', 'send_preset') AND outcome <> 'ok'
     AND outcome NOT IN ('threw:P0001:not_waiting_customer', 'threw:P0001:offer_not_pending', 'threw:P0001:trip_already_assigned');
  PERFORM neg_iso.v('N2', 'negotiation_loser_gets_domain_error', v_n = 0,
    (SELECT string_agg(DISTINCT outcome, ' | ') FROM neg_iso.outcomes WHERE scn = 'N2' AND worker IN ('counter', 'send_preset')));

  -- ---------------------------------------------------------------- N3
  SELECT count(*) INTO v_n FROM neg_iso.outcomes WHERE scn = 'N3' AND worker = 'counter' AND outcome = 'ok';
  PERFORM neg_iso.v('N3', 'stale_counter_never_resurrects_a_reassigned_offer', v_n = 0,
    'a counter on the stale waiting_customer offer was never accepted (offer revoked by the rematch / trip already assigned)');
  SELECT count(*) INTO v_n FROM neg_iso.outcomes WHERE scn = 'N3' AND worker = 'counter' AND outcome <> 'threw:P0001:not_waiting_customer';
  PERFORM neg_iso.v('N3', 'stale_counter_domain_error', v_n = 0, 'every stale counter got not_waiting_customer');
  SELECT count(*) INTO v_n FROM neg_iso.outcomes WHERE scn = 'N3' AND worker = 'rematch' AND outcome = 'ok';
  PERFORM neg_iso.v('N3', 'rematch_always_completes', v_n = 9, format('%s/9 rematches completed', v_n));
  SELECT count(*) INTO v_n FROM neg_iso.trip_scn s JOIN public.trips t ON t.id = s.trip_id
   WHERE s.scn = 'N3' AND (t.status <> 'searching_new_driver' OR t.driver_id IS NOT NULL OR t.confirmed_driver_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM public.ride_offers o WHERE o.trip_id = t.id AND o.status IN ('pending', 'countered')));
  PERFORM neg_iso.v('N3', 'reassigned_trip_back_to_searching', v_n = 0,
    'every trip ended searching_new_driver with no driver and no live offer (never negotiating with an excluded driver)');

  -- ---------------------------------------------------------------- N4
  -- 2x counter (iter 1-4): exactly one wins, the duplicate is rejected, one fare commit (570).
  SELECT count(*) INTO v_n FROM (
    SELECT iter FROM neg_iso.outcomes WHERE scn = 'N4' AND iter BETWEEN 1 AND 4
     GROUP BY iter HAVING count(*) FILTER (WHERE outcome = 'ok') = 1
        AND count(*) FILTER (WHERE outcome = 'threw:P0001:not_waiting_customer') = 1) x;
  PERFORM neg_iso.v('N4', 'duplicate_counter_exactly_one_wins', v_n = 4, format('%s/4 trips: exactly 1 counter ok + 1 not_waiting_customer', v_n));
  SELECT count(*) INTO v_n FROM neg_iso.trip_scn s JOIN public.trips t ON t.id = s.trip_id
   WHERE s.scn = 'N4' AND s.iter BETWEEN 1 AND 4 AND (t.final_fare_pence <> 570 OR t.status <> 'negotiating');
  PERFORM neg_iso.v('N4', 'duplicate_counter_single_fare_commit', v_n = 0, 'committed fare 570 once; trip negotiating; no double/stale commit');

  -- 2x driver preset (iter 5-8): idempotent re-send is fine; no raw error; one live negotiation; sibling revoked.
  SELECT count(*) INTO v_n FROM neg_iso.outcomes
   WHERE scn = 'N4' AND iter BETWEEN 5 AND 8 AND outcome <> 'ok' AND outcome NOT LIKE 'threw:P0001:offer_not_pending';
  PERFORM neg_iso.v('N4', 'duplicate_preset_idempotent_or_domain_error', v_n = 0,
    (SELECT string_agg(DISTINCT outcome, ' | ') FROM neg_iso.outcomes WHERE scn = 'N4' AND iter BETWEEN 5 AND 8));
  SELECT count(*) INTO v_n FROM neg_iso.trip_scn s JOIN public.trips t ON t.id = s.trip_id
   WHERE s.scn = 'N4' AND s.iter BETWEEN 5 AND 8 AND NOT (
     t.status = 'negotiating'
     AND (SELECT count(*) FROM public.ride_offers o WHERE o.trip_id = t.id AND o.status = 'countered') = 1
     AND (SELECT count(*) FROM public.ride_offers o WHERE o.trip_id = t.id AND o.status = 'revoked'
             AND o.revoked_reason = 'negotiation_locked') = 1);
  PERFORM neg_iso.v('N4', 'duplicate_preset_single_negotiation_owner', v_n = 0,
    'one countered offer owns the negotiation; the sibling offer was revoked (negotiation_locked) exactly once');

  -- 2x decline grace (iter 9-12): first applies, duplicate is the idempotent already=true.
  SELECT count(*) INTO v_n FROM (
    SELECT iter FROM neg_iso.worker_out WHERE scn = 'N4' AND iter BETWEEN 9 AND 12
     GROUP BY iter HAVING count(*) FILTER (WHERE result -> 'res' ->> 'already' = 'false') = 1
        AND count(*) FILTER (WHERE result -> 'res' ->> 'already' = 'true') = 1) x;
  PERFORM neg_iso.v('N4', 'duplicate_decline_grace_idempotent', v_n = 4, format('%s/4 trips: one already=false + one already=true', v_n));
  SELECT count(*) INTO v_n FROM neg_iso.trip_scn s JOIN public.ride_offers o ON o.trip_id = s.trip_id AND o.driver_id = neg_iso.uid('d', 1)
   WHERE s.scn = 'N4' AND s.iter BETWEEN 9 AND 12 AND o.negotiation_status = 'declined_customer_awaiting_driver';
  PERFORM neg_iso.v('N4', 'duplicate_decline_grace_single_state', v_n = 4, format('%s/4 offers in declined_customer_awaiting_driver', v_n));

  -- ---------------------------------------------------------------- N5
  SELECT count(*) INTO v_n FROM (
    SELECT s.iter,
      (t.driver_id IS NOT NULL AND o.status = 'accepted') AS accepted_path,
      (t.driver_id IS NULL AND o.status = 'expired' AND t.status = 'searching_new_driver') AS expired_path
    FROM neg_iso.trip_scn s JOIN public.trips t ON t.id = s.trip_id
    JOIN public.ride_offers o ON o.trip_id = t.id AND o.driver_id = neg_iso.uid('d', 1)
    WHERE s.scn = 'N5') z
  WHERE accepted_path <> expired_path;       -- exactly one path
  PERFORM neg_iso.v('N5', 'exactly_one_of_accepted_or_expired', v_n = 12,
    format('%s/12 trips ended in EXACTLY one terminal path (accepted+assigned XOR expired+searching_new_driver)', v_n));
  SELECT count(*) INTO v_n FROM neg_iso.outcomes
   WHERE scn = 'N5' AND worker IN ('accept', 'expire') AND outcome <> 'ok'
     AND outcome NOT IN ('err:OFFER_NOT_PENDING', 'err:OFFER_NOT_FOUND', 'err:TRIP_NOT_AVAILABLE', 'err:ALREADY_RESOLVED', 'err:already_resolved',
                         'err:NEGOTIATION_HELD', 'err:TRIP_ALREADY_ASSIGNED');
  PERFORM neg_iso.v('N5', 'loser_gets_domain_outcome', v_n = 0,
    (SELECT string_agg(DISTINCT worker || '=' || outcome, ' | ') FROM neg_iso.outcomes WHERE scn = 'N5'));
  SELECT count(*) INTO v_n FROM neg_iso.outcomes WHERE scn = 'N5' AND worker = 'accept' AND outcome = 'ok';
  SELECT count(*) INTO v_expected FROM neg_iso.outcomes WHERE scn = 'N5' AND worker = 'expire' AND (result -> 'res' ->> 'success') = 'true' AND (result -> 'res' ->> 'reason') IS NULL;
  INSERT INTO neg_iso.verdict VALUES (DEFAULT, 'N5', 'winner_split', 'INFO', format('accept won %s, expire won %s of 12', v_n, v_expected));
END
$v$;

-- ----------------------------------------------------------------------------
-- M. Bounded retry + domain error (fault-injected REAL 40P01 inside the core UPDATE)
-- ----------------------------------------------------------------------------
CREATE TRIGGER neg_iso_fault BEFORE UPDATE ON public.ride_offers
  FOR EACH ROW WHEN (OLD.trip_id::text LIKE '00000000-0000-4000-8100-%')
  EXECUTE FUNCTION neg_iso.fault_fn();

DO $m$
DECLARE
  v_trip uuid;
  v_o uuid;
  v_res jsonb;
  v_attempts bigint;
  v_n int := 700;
BEGIN
  -- helper: fresh trip -> (trip, offer D1)
  -- ===== counter: 2 injected deadlocks, then success (3rd attempt) =====
  v_n := v_n + 1; v_trip := neg_iso.mk_trip(v_n, 'negotiating', 'M', 1); v_o := neg_iso.offer_of(v_trip, 1);
  PERFORM setval('neg_iso.fault_seq', 1, false); PERFORM set_config('neg_iso.fault_limit', '2', false);
  v_res := neg_iso.act('counter', v_trip, v_o, neg_iso.uid('d', 1), 570);
  SELECT last_value INTO v_attempts FROM neg_iso.fault_seq; PERFORM set_config('neg_iso.fault_limit', '0', false);
  PERFORM neg_iso.v('M', 'counter_retries_two_real_deadlocks_then_succeeds', (v_res ->> 'ok') = 'true' AND v_attempts >= 3,
    format('ok=%s attempts=%s (2 injected 40P01 + 1 success)', v_res ->> 'ok', v_attempts));
  PERFORM neg_iso.v('M', 'counter_retry_result_fully_applied',
    (SELECT final_fare_pence = 570 FROM public.trips WHERE id = v_trip)
    AND (SELECT negotiation_status = 'waiting_driver_final' FROM public.ride_offers WHERE id = v_o),
    'the retried counter committed fare 570 and waiting_driver_final exactly once');

  -- ===== counter: always deadlocks -> bounded 3 attempts -> DOMAIN error, nothing half applied =====
  v_n := v_n + 1; v_trip := neg_iso.mk_trip(v_n, 'negotiating', 'M', 2); v_o := neg_iso.offer_of(v_trip, 1);
  PERFORM setval('neg_iso.fault_seq', 1, false); PERFORM set_config('neg_iso.fault_limit', '100000', false);
  v_res := neg_iso.act('counter', v_trip, v_o, neg_iso.uid('d', 1), 570);
  SELECT last_value INTO v_attempts FROM neg_iso.fault_seq; PERFORM set_config('neg_iso.fault_limit', '0', false);
  PERFORM neg_iso.v('M', 'counter_exhausted_is_domain_error_not_40P01',
    (v_res ->> 'threw') = 'true' AND (v_res ->> 'sqlstate') = 'P0001' AND (v_res ->> 'message') = 'negotiation_contention',
    format('sqlstate=%s message=%s', v_res ->> 'sqlstate', v_res ->> 'message'));
  PERFORM neg_iso.v('M', 'counter_retry_budget_is_exactly_3', v_attempts = 3, format('attempts=%s', v_attempts));
  PERFORM neg_iso.v('M', 'counter_exhausted_changes_nothing',
    (SELECT final_fare_pence = 600 AND status = 'negotiating' FROM public.trips WHERE id = v_trip)
    AND (SELECT negotiation_status = 'waiting_customer' AND status = 'countered' FROM public.ride_offers WHERE id = v_o),
    'trip fare 600 and offer waiting_customer untouched after the exhausted retries');

  -- ===== driver_send_preset_offer: retry success + exhaustion =====
  v_n := v_n + 1; v_trip := neg_iso.mk_trip(v_n, 'preset_pending', 'M', 3); v_o := neg_iso.offer_of(v_trip, 1);
  PERFORM setval('neg_iso.fault_seq', 1, false); PERFORM set_config('neg_iso.fault_limit', '2', false);
  v_res := neg_iso.act('send_preset', v_trip, v_o, neg_iso.uid('d', 1), 570);
  SELECT last_value INTO v_attempts FROM neg_iso.fault_seq; PERFORM set_config('neg_iso.fault_limit', '0', false);
  PERFORM neg_iso.v('M', 'send_preset_retries_then_succeeds', (v_res ->> 'ok') = 'true' AND v_attempts >= 3
    AND (SELECT negotiation_status = 'waiting_customer' FROM public.ride_offers WHERE id = v_o),
    format('ok=%s attempts=%s', v_res ->> 'ok', v_attempts));
  v_n := v_n + 1; v_trip := neg_iso.mk_trip(v_n, 'preset_pending', 'M', 4); v_o := neg_iso.offer_of(v_trip, 1);
  PERFORM setval('neg_iso.fault_seq', 1, false); PERFORM set_config('neg_iso.fault_limit', '100000', false);
  v_res := neg_iso.act('send_preset', v_trip, v_o, neg_iso.uid('d', 1), 570);
  SELECT last_value INTO v_attempts FROM neg_iso.fault_seq; PERFORM set_config('neg_iso.fault_limit', '0', false);
  PERFORM neg_iso.v('M', 'send_preset_exhausted_is_domain_error',
    (v_res ->> 'threw') = 'true' AND (v_res ->> 'sqlstate') = 'P0001' AND (v_res ->> 'message') = 'negotiation_contention' AND v_attempts = 3,
    format('sqlstate=%s message=%s attempts=%s', v_res ->> 'sqlstate', v_res ->> 'message', v_attempts));
  PERFORM neg_iso.v('M', 'send_preset_exhausted_changes_nothing',
    (SELECT negotiation_status IS NULL AND status = 'pending' FROM public.ride_offers WHERE id = v_o)
    AND (SELECT status = 'searching' FROM public.trips WHERE id = v_trip),
    'offer still plain pending and trip still searching');

  -- ===== jsonb RPCs: exhausted => {success:false,error:NEGOTIATION_CONTENTION}, never a raw error =====
  v_n := v_n + 1; v_trip := neg_iso.mk_trip(v_n, 'negotiating', 'M', 5); v_o := neg_iso.offer_of(v_trip, 1);
  PERFORM setval('neg_iso.fault_seq', 1, false); PERFORM set_config('neg_iso.fault_limit', '100000', false);
  v_res := neg_iso.act('decline', v_trip, v_o, neg_iso.uid('d', 1), 0);
  SELECT last_value INTO v_attempts FROM neg_iso.fault_seq; PERFORM set_config('neg_iso.fault_limit', '0', false);
  PERFORM neg_iso.v('M', 'decline_exhausted_is_domain_outcome',
    (v_res ->> 'threw') = 'false' AND (v_res -> 'res' ->> 'success') = 'false' AND (v_res -> 'res' ->> 'error') = 'NEGOTIATION_CONTENTION' AND v_attempts = 3,
    format('res=%s attempts=%s', left((v_res -> 'res')::text, 160), v_attempts));

  v_n := v_n + 1; v_trip := neg_iso.mk_trip(v_n, 'negotiating', 'M', 6); v_o := neg_iso.offer_of(v_trip, 1);
  PERFORM setval('neg_iso.fault_seq', 1, false); PERFORM set_config('neg_iso.fault_limit', '100000', false);
  v_res := neg_iso.act('expire', v_trip, v_o, NULL, 0);
  SELECT last_value INTO v_attempts FROM neg_iso.fault_seq; PERFORM set_config('neg_iso.fault_limit', '0', false);
  PERFORM neg_iso.v('M', 'expire_exhausted_is_domain_outcome',
    (v_res ->> 'threw') = 'false' AND (v_res -> 'res' ->> 'success') = 'false' AND (v_res -> 'res' ->> 'error') = 'NEGOTIATION_CONTENTION' AND v_attempts = 3,
    format('res=%s attempts=%s', left((v_res -> 'res')::text, 160), v_attempts));

  v_n := v_n + 1; v_trip := neg_iso.mk_trip(v_n, 'negotiating', 'M', 7); v_o := neg_iso.offer_of(v_trip, 1);
  PERFORM setval('neg_iso.fault_seq', 1, false); PERFORM set_config('neg_iso.fault_limit', '100000', false);
  v_res := neg_iso.act('grace', v_trip, v_o, NULL, 0);
  SELECT last_value INTO v_attempts FROM neg_iso.fault_seq; PERFORM set_config('neg_iso.fault_limit', '0', false);
  PERFORM neg_iso.v('M', 'decline_grace_exhausted_is_domain_outcome',
    (v_res ->> 'threw') = 'false' AND (v_res -> 'res' ->> 'success') = 'false' AND (v_res -> 'res' ->> 'error') = 'NEGOTIATION_CONTENTION' AND v_attempts = 3,
    format('res=%s attempts=%s', left((v_res -> 'res')::text, 160), v_attempts));

  v_n := v_n + 1; v_trip := neg_iso.mk_trip(v_n, 'negotiating', 'M', 8); v_o := neg_iso.offer_of(v_trip, 1);
  PERFORM setval('neg_iso.fault_seq', 1, false); PERFORM set_config('neg_iso.fault_limit', '100000', false);
  v_res := neg_iso.act('driver_cancel_neg', v_trip, v_o, neg_iso.uid('d', 1), 0);
  SELECT last_value INTO v_attempts FROM neg_iso.fault_seq; PERFORM set_config('neg_iso.fault_limit', '0', false);
  PERFORM neg_iso.v('M', 'driver_cancel_negotiation_exhausted_is_domain_outcome',
    (v_res ->> 'threw') = 'false' AND (v_res -> 'res' ->> 'success') = 'false' AND (v_res -> 'res' ->> 'error') = 'NEGOTIATION_CONTENTION' AND v_attempts = 3,
    format('res=%s attempts=%s', left((v_res -> 'res')::text, 160), v_attempts));

  -- Business exceptions are NOT swallowed by the retry wrapper.
  v_n := v_n + 1; v_trip := neg_iso.mk_trip(v_n, 'negotiating', 'M', 9); v_o := neg_iso.offer_of(v_trip, 1);
  v_res := neg_iso.act('counter', v_trip, v_o, neg_iso.uid('d', 1), 600);   -- == driver fare -> invalid_counter
  PERFORM neg_iso.v('M', 'business_exception_propagates_unchanged',
    (v_res ->> 'threw') = 'true' AND (v_res ->> 'message') = 'invalid_counter', format('message=%s', v_res ->> 'message'));
END
$m$;

DROP TRIGGER neg_iso_fault ON public.ride_offers;

\if :{?bad_workers}
\else
  \set bad_workers 0
\endif
INSERT INTO neg_iso.verdict(scenario, check_name, verdict, evidence)
VALUES ('H', 'psql_workers_exited_cleanly', CASE WHEN :bad_workers = 0 THEN 'PASS' ELSE 'FAIL' END,
        :bad_workers || ' worker(s) exited non-zero');

-- ----------------------------------------------------------------------------
-- Report + hard verdict
-- ----------------------------------------------------------------------------
\set QUIET off
\pset format unaligned
\pset tuples_only on
SELECT rpad(verdict, 7) || ' ' || scenario || '.' || check_name || CASE WHEN evidence IS NOT NULL THEN ' — ' || evidence ELSE '' END
  FROM neg_iso.verdict ORDER BY seq;

\echo
\echo '--- scenario summary ---------------------------------------------------------'
SELECT 'SCENARIO ' || scenario || ' => ' || CASE WHEN count(*) FILTER (WHERE verdict IN ('FAIL', 'SKIPPED')) = 0 THEN 'PASS' ELSE 'FAIL' END
       || format('   (pass=%s fail=%s skipped=%s info=%s)', count(*) FILTER (WHERE verdict = 'PASS'),
                 count(*) FILTER (WHERE verdict = 'FAIL'), count(*) FILTER (WHERE verdict = 'SKIPPED'),
                 count(*) FILTER (WHERE verdict = 'INFO'))
  FROM neg_iso.verdict GROUP BY scenario ORDER BY scenario;
SELECT 'TOTAL fail=' || count(*) FILTER (WHERE verdict = 'FAIL') || ' pass=' || count(*) FILTER (WHERE verdict = 'PASS')
       || ' skipped=' || count(*) FILTER (WHERE verdict = 'SKIPPED') FROM neg_iso.verdict;

DO $final$
DECLARE v_fail int; v_skip int; v_pass int;
BEGIN
  SELECT count(*) FILTER (WHERE verdict = 'FAIL'), count(*) FILTER (WHERE verdict = 'SKIPPED'), count(*) FILTER (WHERE verdict = 'PASS')
    INTO v_fail, v_skip, v_pass FROM neg_iso.verdict;
  IF v_fail > 0 OR v_skip > 0 THEN
    RAISE EXCEPTION 'NEGOTIATION HARNESS FAILED: fail=% skipped=%', v_fail, v_skip;
  END IF;
  IF v_pass < 40 THEN
    RAISE EXCEPTION 'NEGOTIATION HARNESS: only % checks ran (expected >= 40) — scenarios were skipped?', v_pass;
  END IF;
END
$final$;
