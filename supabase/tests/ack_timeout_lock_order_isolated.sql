-- ============================================================================
-- process_ride_offer_ack_timeouts lock-order / concurrency harness  --  VERIFY
--   (run by ack_timeout_lock_order_concurrency_isolated.sh after every race has finished)
--
-- Reads neg_iso.worker_out (what each parallel session observed) + the final trip / offer rows,
-- writes verdicts to neg_iso.verdict and RAISES (=> non-zero exit) on any FAIL / SKIPPED /
-- failed worker.
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);

-- One last sweep, as the next cron run would: every offer a race left due-but-pending is picked up.
SELECT neg_iso.rec('FINAL', 1, 'cron', 'sweep', neg_iso.ack_act('sweep',
         (SELECT trip_id FROM neg_iso.trip_scn ORDER BY trip_id LIMIT 1), NULL, NULL, 0), clock_timestamp()) \gset

CREATE FUNCTION neg_iso.v(p_scn text, p_name text, p_ok boolean, p_evidence text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO neg_iso.verdict(scenario, check_name, verdict, evidence)
  VALUES (p_scn, p_name, CASE WHEN p_ok THEN 'PASS' ELSE 'FAIL' END, p_evidence) $$;

-- One row per worker with a flattened outcome label.
CREATE VIEW neg_iso.ack_outcomes AS
SELECT w.scn, w.iter, w.worker, w.action,
  CASE
    WHEN (w.result ->> 'threw') = 'true' THEN 'threw:' || (w.result ->> 'sqlstate') || ':' || (w.result ->> 'message')
    WHEN (w.result ->> 'ok') = 'true' THEN 'ok'
    ELSE 'err:' || coalesce(w.result -> 'res' ->> 'error', w.result -> 'res' ->> 'reason', 'unknown')
  END AS outcome,
  coalesce((w.result ->> 'raw_contention')::boolean, false) AS raw_contention,
  (w.result ->> 'sqlstate') AS sqlstate,
  (w.result ->> 'dur_ms')::numeric AS dur_ms,
  (w.result ->> 'ours')::boolean AS swept_ours,
  (w.result ->> 'offer_status_after') AS offer_status_after,
  w.result
FROM neg_iso.worker_out w;

-- Final-state invariants for every ack-timeout trip (one row per violating trip).
CREATE VIEW neg_iso.ack_violations AS
SELECT s.scn, s.iter, t.id AS trip_id,
  concat_ws('; ',
    -- A sweep-expired offer never carries responded_at. (decline_ride_offer_core has no status guard, so a
    -- driver decline that COMMITS AFTER the sweep legitimately overwrites expired -> declined and keeps the
    -- stale delivery_phase; that sequential order is pre-existing decline behaviour, not a lock defect.)
    CASE WHEN o.status = 'expired' AND o.delivery_phase = 'ack_timeout' AND o.responded_at IS NOT NULL
         THEN 'ack_timeout expiry carries responded_at=' || o.responded_at::text END,
    CASE WHEN o.status = 'declined' AND o.responded_at IS NULL
         THEN 'declined offer without responded_at' END,
    CASE WHEN o.status NOT IN ('expired', 'declined', 'accepted', 'pending', 'countered', 'revoked')
         THEN 'unknown offer status ' || o.status END,
    CASE WHEN o.status = 'expired' AND o.delivery_phase = 'ack_timeout'
              AND (o.delivery_trace ->> 'non_driver_fault') IS DISTINCT FROM 'true'
         THEN 'ack_timeout expiry not flagged non_driver_fault' END,
    CASE WHEN t.driver_id IS NOT NULL AND o.status = 'expired' AND o.delivery_phase = 'ack_timeout'
              AND t.driver_id = o.driver_id
         THEN 'assigned driver''s offer was ack_timeout-expired' END,
    CASE WHEN t.driver_id IS NOT NULL AND t.confirmed_driver_id IS DISTINCT FROM t.driver_id
         THEN 'driver_id <> confirmed_driver_id' END,
    CASE WHEN t.driver_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.ride_offers x WHERE x.trip_id = t.id AND x.driver_id = t.driver_id AND x.status = 'accepted')
         THEN 'assigned driver has no accepted offer' END,
    CASE WHEN t.driver_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM public.ride_offers x WHERE x.trip_id = t.id AND x.status IN ('pending', 'countered'))
         THEN 'assigned trip still has live offers' END,
    CASE WHEN public.is_trip_terminal_cancel_status(t.status) AND (t.driver_id IS NOT NULL OR EXISTS (
           SELECT 1 FROM public.ride_offers x WHERE x.trip_id = t.id AND x.status IN ('pending', 'countered')))
         THEN 'cancelled trip has a driver or live offers' END,
    CASE WHEN (SELECT count(*) FROM public.ride_offers x WHERE x.trip_id = t.id AND x.status = 'accepted') > 1
         THEN 'more than one accepted offer' END
  ) AS violation
FROM neg_iso.trip_scn s
JOIN public.trips t ON t.id = s.trip_id
JOIN public.ride_offers o ON o.trip_id = t.id AND o.driver_id = neg_iso.uid('d', 1)
WHERE s.scn IN ('L', 'LB', 'A1', 'A1b', 'A2', 'A3');

DO $v$
DECLARE
  s text;
  v_n int;
  v_expected int;
  v_txt text;
BEGIN
  -- ---------------------------------------------------------------- common
  FOREACH s IN ARRAY ARRAY['L', 'LB', 'A1', 'A1b', 'A2', 'A3'] LOOP
    v_expected := CASE s WHEN 'L' THEN 9 WHEN 'LB' THEN 6 WHEN 'A1' THEN 18 WHEN 'A1b' THEN 6 WHEN 'A2' THEN 12 WHEN 'A3' THEN 24 END;
    SELECT count(*) INTO v_n FROM neg_iso.worker_out WHERE scn = s;
    PERFORM neg_iso.v(s, 'workers_all_reported', v_n = v_expected, format('%s of %s worker results recorded', v_n, v_expected));

    SELECT count(*), string_agg(DISTINCT coalesce(sqlstate, '?') || ':' || (result ->> 'message'), ' | ')
      INTO v_n, v_txt FROM neg_iso.ack_outcomes WHERE scn = s AND raw_contention;
    PERFORM neg_iso.v(s, 'no_raw_40P01_40001_55P03', v_n = 0,
      CASE WHEN v_n = 0 THEN 'no worker (sweep or competitor) ever saw a raw lock/serialization error'
           ELSE v_n || ' worker(s) received a raw lock error: ' || v_txt END);

    SELECT count(*), string_agg(DISTINCT sqlstate || ':' || (result ->> 'message'), ' | ')
      INTO v_n, v_txt FROM neg_iso.ack_outcomes
     WHERE scn = s AND (result ->> 'threw') = 'true' AND sqlstate IS DISTINCT FROM 'P0001';
    PERFORM neg_iso.v(s, 'only_domain_errors', v_n = 0,
      CASE WHEN v_n = 0 THEN 'every thrown error was a domain (RAISE EXCEPTION) message'
           ELSE v_n || ' non-domain error(s): ' || v_txt END);

    SELECT count(*) INTO v_n FROM neg_iso.ack_outcomes WHERE scn = s AND action = 'sweep' AND (result ->> 'threw') = 'true';
    PERFORM neg_iso.v(s, 'sweep_never_throws', v_n = 0, format('%s sweep call(s) threw', v_n));

    SELECT count(*), string_agg(scn || '#' || iter || ': ' || violation, ' | ')
      INTO v_n, v_txt FROM neg_iso.ack_violations WHERE scn = s AND violation <> '';
    PERFORM neg_iso.v(s, 'final_state_consistent', v_n = 0,
      CASE WHEN v_n = 0 THEN 'every trip ended consistent (single terminal offer state, ack_timeout => expired + no responded_at + non_driver_fault, no live offers on assigned/cancelled trips)'
           ELSE v_n || ' inconsistent trip(s): ' || left(v_txt, 600) END);
  END LOOP;

  -- ---------------------------------------------------------------- L: trip lock held elsewhere
  SELECT count(*) FILTER (WHERE (p.result ->> 'probe') = 'free'),
         string_agg(coalesce(p.result ->> 'probe', '?'), ', ' ORDER BY p.iter)
    INTO v_n, v_txt
  FROM neg_iso.worker_out p WHERE p.scn = 'L' AND p.worker = 'probe';
  PERFORM neg_iso.v('L', 'offer_row_free_while_trip_lock_is_held_elsewhere', v_n = 3,
    format('NOWAIT probe on the offer row during the sweep: %s (old offer->trip order: locked)', coalesce(v_txt, 'no probe rows')));

  SELECT count(*), string_agg(dur_ms::int || 'ms', ', ' ORDER BY iter)
    INTO v_n, v_txt
  FROM neg_iso.ack_outcomes WHERE scn = 'L' AND worker = 'sweep' AND dur_ms < 600;
  PERFORM neg_iso.v('L', 'sweep_did_not_wait_for_the_trip_lock', v_n = 3,
    format('%s/3 sweeps returned < 600ms while the trip lock was held ~1.6s (%s)', v_n, coalesce(v_txt, 'none')));

  SELECT count(*) INTO v_n FROM neg_iso.ack_outcomes
   WHERE scn = 'L' AND worker = 'sweep' AND swept_ours IS NOT TRUE AND offer_status_after = 'pending';
  PERFORM neg_iso.v('L', 'busy_trip_skipped_offer_left_pending', v_n = 3, format('%s/3 sweeps skipped the busy trip and left the offer pending', v_n));

  SELECT count(*) INTO v_n FROM neg_iso.ack_outcomes WHERE scn = 'L' AND worker = 'sweep2' AND swept_ours IS TRUE;
  PERFORM neg_iso.v('L', 'next_sweep_expires_it', v_n = 3, format('%s/3 follow-up sweeps expired the offer once the trip lock was free', v_n));

  -- ---------------------------------------------------------------- LB: offer lock held elsewhere
  SELECT count(*), string_agg(dur_ms::int || 'ms', ', ' ORDER BY iter)
    INTO v_n, v_txt
  FROM neg_iso.ack_outcomes WHERE scn = 'LB' AND worker = 'sweep' AND dur_ms < 600 AND swept_ours IS NOT TRUE;
  PERFORM neg_iso.v('LB', 'sweep_skipped_locked_offer_without_waiting', v_n = 3,
    format('%s/3 sweeps skipped the locked offer in < 600ms (%s)', v_n, coalesce(v_txt, 'none')));

  SELECT count(*) INTO v_n FROM neg_iso.ack_outcomes WHERE scn = 'LB' AND worker = 'sweep2' AND swept_ours IS TRUE;
  PERFORM neg_iso.v('LB', 'next_sweep_expires_it', v_n = 3, format('%s/3 follow-up sweeps expired the offer', v_n));

  -- ---------------------------------------------------------------- ack_timeout semantics (L / LB / A1)
  SELECT count(*) INTO v_n
  FROM neg_iso.trip_scn s
  JOIN public.ride_offers o ON o.trip_id = s.trip_id AND o.driver_id = neg_iso.uid('d', 1)
  JOIN public.trips t ON t.id = s.trip_id
  WHERE s.scn IN ('L', 'LB') AND o.status = 'expired' AND o.delivery_phase = 'ack_timeout'
    AND o.responded_at IS NULL AND o.revoked_reason = 'ack_timeout'
    AND (o.delivery_trace ->> 'non_driver_fault') = 'true'
    AND (o.delivery_trace ->> 'responded_at_suppressed') = 'true'
    AND t.current_offer_driver_id IS NULL;
  PERFORM neg_iso.v('L', 'ack_timeout_semantics_preserved', v_n = 6,
    format('%s/6 expired offers: status=expired, delivery_phase=ack_timeout, responded_at NULL, revoked_reason=ack_timeout, non_driver_fault, trip pointer cleared', v_n));

  -- ---------------------------------------------------------------- A1: due offer vs accept
  SELECT count(*) INTO v_n FROM neg_iso.ack_outcomes WHERE scn = 'A1' AND worker = 'accept' AND outcome = 'ok';
  PERFORM neg_iso.v('A1', 'due_offer_never_accepted', v_n = 0,
    (SELECT string_agg(DISTINCT outcome, ' | ') FROM neg_iso.ack_outcomes WHERE scn = 'A1' AND worker = 'accept'));

  SELECT count(*) INTO v_n
  FROM neg_iso.trip_scn s
  JOIN public.ride_offers o ON o.trip_id = s.trip_id AND o.driver_id = neg_iso.uid('d', 1)
  JOIN public.trips t ON t.id = s.trip_id
  WHERE s.scn = 'A1' AND o.status = 'expired' AND o.delivery_phase = 'ack_timeout' AND o.responded_at IS NULL AND t.driver_id IS NULL;
  PERFORM neg_iso.v('A1', 'due_offer_ends_ack_timeout_expired_trip_unassigned', v_n = 9,
    format('%s/9 trips: offer expired by ack_timeout (after the follow-up sweep), responded_at NULL, no driver assigned', v_n));

  -- ---------------------------------------------------------------- A1b: accept at the expiry boundary
  SELECT count(*) INTO v_n FROM neg_iso.ack_outcomes WHERE scn = 'A1b' AND worker = 'accept' AND outcome = 'ok';
  PERFORM neg_iso.v('A1b', 'accept_started_before_expiry_wins', v_n = 3,
    (SELECT string_agg(DISTINCT outcome, ' | ') FROM neg_iso.ack_outcomes WHERE scn = 'A1b' AND worker = 'accept'));

  SELECT count(*) INTO v_n FROM neg_iso.ack_outcomes WHERE scn = 'A1b' AND worker = 'sweep' AND swept_ours IS NOT TRUE;
  PERFORM neg_iso.v('A1b', 'sweep_skipped_the_offer_being_accepted', v_n = 3, format('%s/3 sweeps did not expire the offer under acceptance', v_n));

  SELECT count(*) INTO v_n
  FROM neg_iso.trip_scn s
  JOIN public.ride_offers o ON o.trip_id = s.trip_id AND o.driver_id = neg_iso.uid('d', 1)
  JOIN public.trips t ON t.id = s.trip_id
  WHERE s.scn = 'A1b' AND o.status = 'accepted' AND o.delivery_phase IS DISTINCT FROM 'ack_timeout' AND t.driver_id = o.driver_id;
  PERFORM neg_iso.v('A1b', 'accepted_offer_and_assignment_survive_the_sweep', v_n = 3,
    format('%s/3 trips: offer accepted, never ack_timeout-expired, driver assigned', v_n));

  -- ---------------------------------------------------------------- A2: cancellation
  SELECT count(*) INTO v_n FROM neg_iso.ack_outcomes WHERE scn = 'A2' AND worker = 'cancel' AND outcome = 'ok';
  PERFORM neg_iso.v('A2', 'cancellation_always_succeeds', v_n = 6,
    (SELECT string_agg(DISTINCT outcome, ' | ') FROM neg_iso.ack_outcomes WHERE scn = 'A2' AND worker = 'cancel'));

  SELECT count(*) INTO v_n
  FROM neg_iso.trip_scn s JOIN public.trips t ON t.id = s.trip_id
  WHERE s.scn = 'A2' AND public.is_trip_terminal_cancel_status(t.status);
  PERFORM neg_iso.v('A2', 'trips_end_cancelled', v_n = 6, format('%s/6 trips cancelled', v_n));

  -- ---------------------------------------------------------------- A3: negotiation
  SELECT count(*) INTO v_n
  FROM neg_iso.trip_scn s
  JOIN public.ride_offers o ON o.trip_id = s.trip_id AND o.driver_id = neg_iso.uid('d', 1)
  WHERE s.scn = 'A3' AND o.status IN ('expired', 'declined', 'countered', 'revoked', 'pending');
  PERFORM neg_iso.v('A3', 'every_offer_ended_in_one_known_state', v_n = 12, format('%s/12 offers in a single known state', v_n));

  SELECT count(*) INTO v_n
  FROM neg_iso.trip_scn s
  JOIN public.ride_offers o ON o.trip_id = s.trip_id AND o.driver_id = neg_iso.uid('d', 1)
  WHERE s.scn = 'A3' AND s.iter > 6 AND o.status = 'declined' AND o.responded_at IS NOT NULL AND o.delivery_phase IS DISTINCT FROM 'ack_timeout';
  PERFORM neg_iso.v('A3', 'decline_keeps_responded_at_ack_timeout_never_sets_it',
    (SELECT count(*) FROM neg_iso.trip_scn s JOIN public.ride_offers o ON o.trip_id = s.trip_id AND o.driver_id = neg_iso.uid('d', 1)
      WHERE s.scn = 'A3' AND s.iter > 6 AND o.status = 'expired' AND o.responded_at IS NOT NULL) = 0,
    format('%s declined offers carry responded_at; no ack_timeout expiry carries one', v_n));

  -- ---------------------------------------------------------------- FINAL sweep touched nothing it must not
  SELECT count(*) INTO v_n FROM neg_iso.ack_outcomes WHERE scn = 'FINAL' AND (result ->> 'threw') = 'false';
  PERFORM neg_iso.v('FINAL', 'follow_up_sweep_ran_clean', v_n = 1, 'the next cron run completed without error');
END
$v$;

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
    RAISE EXCEPTION 'ACK-TIMEOUT HARNESS FAILED: fail=% skipped=%', v_fail, v_skip;
  END IF;
  IF v_pass < 40 THEN
    RAISE EXCEPTION 'ACK-TIMEOUT HARNESS: only % checks ran (expected >= 40) — scenarios were skipped?', v_pass;
  END IF;
END
$final$;
