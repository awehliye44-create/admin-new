-- ============================================================================
-- Scheduled rematch / waiting-segment concurrency harness  —  VERIFICATION
-- Reads what the parallel psql workers recorded in rmch_iso.worker_out / rmch_iso.state
-- plus the live synthetic trips, and emits one line per assertion:
--     PASS | FAIL | SKIPPED | INFO   <scenario>.<check> — <evidence>
-- Exits non-zero when any FAIL exists.
--   -v bad_workers=<n>   psql worker processes that exited non-zero (passed by the .sh)
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned

\if :{?bad_workers}
\else
  \set bad_workers 0
\endif

CREATE OR REPLACE FUNCTION pg_temp.emit(p_scn text, p_chk text, p_verdict text, p_ev text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO rmch_iso.verdict(scenario, check_name, verdict, evidence) VALUES (p_scn, p_chk, p_verdict, p_ev);
END $$;

-- bad = number of offending races; total = races examined.
CREATE OR REPLACE FUNCTION pg_temp.chk(p_scn text, p_chk text, p_bad int, p_total int, p_ok_ev text, p_bad_ev text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_total = 0 THEN
    PERFORM pg_temp.emit(p_scn, p_chk, 'FAIL', 'no races were recorded (harness produced nothing to assert)');
  ELSIF p_bad = 0 THEN
    PERFORM pg_temp.emit(p_scn, p_chk, 'PASS', p_ok_ev);
  ELSE
    PERFORM pg_temp.emit(p_scn, p_chk, 'FAIL', p_bad || '/' || p_total || ' offending: ' || p_bad_ev);
  END IF;
END $$;

SELECT set_config('rmch.bad_workers', :'bad_workers', false) \gset
\echo
\echo '--- config -----------------------------------------------------------------'
SELECT 'cas_statuses source = ' || rmch_iso.cfg('cas_statuses_source') || '  ' || rmch_iso.cfg('cas_statuses');
SELECT 'find window used by harness = ' || rmch_iso.cfg('find_minutes') || ' min  (local global_dispatch_settings.max_driver_find_time_minutes = '
       || rmch_iso.cfg('gds_max_find_minutes') || '; Edge code falls back to 6)';
\echo '--- assertions -------------------------------------------------------------'

DO $verify$
DECLARE
  d1 uuid := rmch_iso.uid('d', 1);
  d2 uuid := rmch_iso.uid('d', 2);
  d3 uuid := rmch_iso.uid('d', 3);
  d4 uuid := rmch_iso.uid('d', 4);
  v_find int := rmch_iso.cfg('find_minutes')::int;
  v_bad int; v_tot int; v_ev text; v_n int;
BEGIN
  -- ------------------------------------------------------------------ health
  PERFORM pg_temp.chk('H', 'worker_processes', current_setting('rmch.bad_workers')::int, 1, 'all parallel psql workers exited 0', current_setting('rmch.bad_workers') || ' psql workers exited non-zero');
  SELECT count(*) INTO v_n FROM rmch_iso.worker_out WHERE scn = 'A';
  PERFORM pg_temp.chk('H', 'A_workers_reported', (48 <> v_n)::int, 1, v_n || ' worker results (24 races x 2)', 'expected 48 got ' || v_n);
  SELECT count(*) INTO v_n FROM rmch_iso.worker_out WHERE scn = 'B';
  PERFORM pg_temp.chk('H', 'B_workers_reported', (22 <> v_n)::int, 1, v_n || ' worker results (11 races x 2)', 'expected 22 got ' || v_n);
  SELECT count(*) INTO v_n FROM rmch_iso.worker_out WHERE scn = 'C';
  PERFORM pg_temp.chk('H', 'C_workers_reported', (27 <> v_n)::int, 1, v_n || ' worker results (9 races x 3)', 'expected 27 got ' || v_n);
  SELECT count(*) INTO v_n FROM rmch_iso.worker_out WHERE scn = 'D';
  PERFORM pg_temp.chk('H', 'D_workers_reported', (78 <> v_n)::int, 1, v_n || ' worker results (6 trips x (4+2+4) + 18 probes)', 'expected 78 got ' || v_n);
  SELECT count(*) INTO v_n FROM rmch_iso.worker_out WHERE scn IN ('E', 'F');
  PERFORM pg_temp.chk('H', 'EF_workers_reported', (42 <> v_n)::int, 1, v_n || ' worker results (6 trips x (1+3+3))', 'expected 42 got ' || v_n);

  -- ======================================================================= A
  -- A.1 exactly one winner per race
  WITH r AS (
    SELECT iter,
      count(*) FILTER (WHERE outcome IN ('cas_won', 'start_won')) AS wins,
      max(outcome) FILTER (WHERE worker = 'cancel') AS c, max(outcome) FILTER (WHERE worker = 'start') AS s,
      max(detail ->> 'mode') AS mode
    FROM rmch_iso.worker_out WHERE scn = 'A' GROUP BY iter)
  SELECT count(*) FILTER (WHERE wins <> 1), count(*),
         'cancel_won=' || count(*) FILTER (WHERE c = 'cas_won') || ' start_won=' || count(*) FILTER (WHERE s = 'start_won')
    INTO v_bad, v_tot, v_ev FROM r;
  PERFORM pg_temp.chk('A', 'exactly_one_winner', v_bad, v_tot, v_tot || '/' || v_tot || ' races had exactly one winner (' || v_ev || ')', v_ev);

  -- A.2 final row state is coherent with the winner (never both, never neither)
  WITH r AS (
    SELECT iter, max(outcome) FILTER (WHERE worker = 'cancel') AS c, max(outcome) FILTER (WHERE worker = 'start') AS s
    FROM rmch_iso.worker_out WHERE scn = 'A' GROUP BY iter), j AS (
    SELECT r.*, t.status, t.started_at, t.confirmed_driver_id, t.driver_id, t.previous_driver_id, t.dispatch_mode
      FROM r JOIN public.trips t ON t.id = rmch_iso.uid('t', 100 + r.iter))
  SELECT count(*) FILTER (WHERE NOT (
           (c = 'cas_won' AND s <> 'start_won' AND status = 'searching_new_driver' AND started_at IS NULL
              AND confirmed_driver_id IS NULL AND driver_id IS NULL AND previous_driver_id = d1)
        OR (s = 'start_won' AND c <> 'cas_won' AND status = 'in_progress' AND started_at IS NOT NULL
              AND confirmed_driver_id = d1 AND driver_id = d1))),
         count(*) INTO v_bad, v_tot FROM j;
  PERFORM pg_temp.chk('A', 'final_state_coherent', v_bad, v_tot,
    'cancel-winner => searching_new_driver/no driver/started_at NULL; start-winner => in_progress/started_at set/D1 kept');

  -- A.3 deterministic ordering under a held row lock
  WITH r AS (
    SELECT iter, max(detail ->> 'mode') AS mode,
      max(outcome) FILTER (WHERE worker = 'cancel') AS c, max(outcome) FILTER (WHERE worker = 'start') AS s
    FROM rmch_iso.worker_out WHERE scn = 'A' GROUP BY iter)
  SELECT count(*) FILTER (WHERE (mode = 'start_holds' AND NOT (s = 'start_won' AND c = 'cas_miss'))
                             OR (mode = 'cancel_holds' AND NOT (c = 'cas_won' AND s = 'start_rejected'))),
         count(*) FILTER (WHERE mode IN ('start_holds', 'cancel_holds'))
    INTO v_bad, v_tot FROM r;
  PERFORM pg_temp.chk('A', 'lock_holder_wins_loser_reevaluates', v_bad, v_tot,
    'start-holds: Start wins & cancel CAS matches 0 rows (started_at no longer NULL); cancel-holds: cancel wins & Start rejected (driver_id NULL)');

  -- A.4 evidence that the loser really blocked on the row lock
  SELECT count(*) FILTER (WHERE (detail ->> 'dur_ms')::numeric >= 250), count(*)
    INTO v_n, v_tot FROM rmch_iso.worker_out
   WHERE scn = 'A' AND ((worker = 'cancel' AND detail ->> 'mode' = 'start_holds') OR (worker = 'start' AND detail ->> 'mode' = 'cancel_holds'));
  PERFORM pg_temp.chk('A', 'loser_blocked_on_row_lock', (v_tot - v_n), v_tot,
    v_n || '/' || v_tot || ' losers waited >=250ms on the winner''s uncommitted row lock (min/max dur_ms=' ||
    (SELECT min((detail ->> 'dur_ms')::numeric) || '/' || max((detail ->> 'dur_ms')::numeric) FROM rmch_iso.worker_out
      WHERE scn = 'A' AND ((worker = 'cancel' AND detail ->> 'mode' = 'start_holds') OR (worker = 'start' AND detail ->> 'mode' = 'cancel_holds'))) || ')');

  -- A.5 free-for-all coverage (informational)
  SELECT string_agg(mode || ':' || w, '  ' ORDER BY mode) INTO v_ev FROM (
    SELECT detail ->> 'mode' AS mode,
           'cancel=' || count(*) FILTER (WHERE outcome = 'cas_won') || '/start=' || count(*) FILTER (WHERE outcome = 'start_won') AS w
      FROM rmch_iso.worker_out WHERE scn = 'A' GROUP BY 1) q;
  PERFORM pg_temp.emit('A', 'winner_distribution', 'INFO', v_ev);

  -- A.6 production-ordering observation: revoke happens BEFORE the CAS (index.ts L195 vs L307)
  SELECT count(*) INTO v_n FROM rmch_iso.worker_out c
    JOIN rmch_iso.worker_out s ON s.scn = 'A' AND s.iter = c.iter AND s.worker = 'start' AND s.outcome = 'start_won'
   WHERE c.scn = 'A' AND c.worker = 'cancel' AND c.outcome = 'cas_miss' AND (c.detail ->> 'revoked')::int > 0;
  PERFORM pg_temp.emit('A', 'revoke_before_cas_window', 'INFO',
    v_n || ' race(s): Start won AFTER the cancel worker had already revoked D1''s accepted offer (Edge revokes offers in its own statement before the CAS; a CAS miss does not restore them). Trip stayed in_progress with driver D1.');

  -- A.7 real production start RPC probe
  DECLARE v_t uuid; v_res jsonb; v_err text;
  BEGIN
    v_t := rmch_iso.mk_trip(900, 'scheduled_arrived');
    BEGIN
      INSERT INTO public.trip_stops(trip_id, stop_index, type, address, lat, lng, status, arrived_at) VALUES
        (v_t, 0, 'pickup', 'TEST pickup', 52, 0, 'arrived', now() - interval '5 minutes'),
        (v_t, 1, 'dropoff', 'TEST dropoff', 52.1, 0.1, 'pending', NULL);
      v_res := public.finalize_pickup_waiting_and_start_trip(v_t, d1);
      RAISE EXCEPTION 'rmch_probe_rollback';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
    END;
    IF v_err = 'rmch_probe_rollback' THEN
      PERFORM pg_temp.emit('A', 'real_start_rpc', 'INFO', 'finalize_pickup_waiting_and_start_trip ran on the fixture: ' || v_res::text);
    ELSE
      PERFORM pg_temp.emit('A', 'real_start_rpc', 'SKIPPED',
        'BLOCKER finalize_pickup_waiting_and_start_trip cannot run on local DB: ' || replace(v_err, E'\n', ' ') ||
        ' — Start side is exercised with rmch_iso.start_mirror (same FOR UPDATE + driver_id/terminal/started_at guards + UPDATE started_at,status=in_progress)');
    END IF;
  END;

  -- ======================================================================= B
  WITH r AS (
    SELECT iter, count(*) FILTER (WHERE outcome = 'cas_won') AS wins,
           count(*) FILTER (WHERE outcome IN ('cas_miss', 'pre_idempotent')) AS losers,
           max(detail ->> 'mode') AS mode
    FROM rmch_iso.worker_out WHERE scn = 'B' GROUP BY iter)
  SELECT count(*) FILTER (WHERE wins <> 1 OR losers <> 1), count(*) INTO v_bad, v_tot FROM r;
  PERFORM pg_temp.chk('B', 'single_rematch_winner', v_bad, v_tot,
    'every duplicate cancel produced exactly 1 CAS winner and 1 loser (cas_miss=' ||
    (SELECT count(*) FROM rmch_iso.worker_out WHERE scn = 'B' AND outcome = 'cas_miss') || ', idempotent replay=' ||
    (SELECT count(*) FROM rmch_iso.worker_out WHERE scn = 'B' AND outcome = 'pre_idempotent') || ')');

  WITH r AS (
    SELECT iter, (array_agg(detail ->> 'searching_expires_at') FILTER (WHERE outcome = 'cas_won'))[1] AS win_exp
    FROM rmch_iso.worker_out WHERE scn = 'B' GROUP BY iter), j AS (
    SELECT r.*, t.* FROM r JOIN public.trips t ON t.id = rmch_iso.uid('t', 200 + r.iter))
  SELECT count(*) FILTER (WHERE NOT (
           status = 'searching_new_driver' AND confirmed_driver_id IS NULL AND driver_id IS NULL
       AND cardinality(cancelled_driver_ids) = 1 AND cancelled_driver_ids[1] = d1
       AND cardinality(excluded_driver_ids) = 1 AND excluded_driver_ids[1] = d1
       AND previous_driver_id = d1 AND current_broadcast_round = 3 AND cancelled_by = 'driver'
       AND searching_expires_at = win_exp::timestamptz)), count(*)
    INTO v_bad, v_tot FROM j;
  PERFORM pg_temp.chk('B', 'single_outcome_state', v_bad, v_tot,
    'searching_new_driver, D1 listed exactly once in cancelled+excluded, round=3, searching_expires_at == the WINNER''s value (loser never overwrote it)');

  WITH j AS (
    SELECT i AS iter, (SELECT count(*) FROM public.ride_offers o WHERE o.trip_id = rmch_iso.uid('t', 200 + i)) AS n_all,
           (SELECT count(*) FROM public.ride_offers o WHERE o.trip_id = rmch_iso.uid('t', 200 + i)
               AND o.status = 'revoked' AND o.revoked_reason = 'driver_cancelled_before_pickup' AND o.driver_id = d1) AS n_rev
    FROM generate_series(1, 11) i)
  SELECT count(*) FILTER (WHERE n_all <> 1 OR n_rev <> 1), count(*) INTO v_bad, v_tot FROM j;
  PERFORM pg_temp.chk('B', 'offers_revoked_once_no_phantom_offers', v_bad, v_tot,
    'D1''s accepted offer revoked exactly once; no replacement/duplicate offer rows created by the duplicate cancel');

  SELECT count(*) FILTER (WHERE rmch_iso.dc_precheck(rmch_iso.uid('t', 200 + i), d1) <> 'idempotent'), count(*)
    INTO v_bad, v_tot FROM generate_series(1, 11) i;
  PERFORM pg_temp.chk('B', 'third_request_is_idempotent_replay', v_bad, v_tot,
    'a later duplicate (isIdempotentDriverRematchReplay) short-circuits before revoke/CAS');

  SELECT count(*) FILTER (WHERE (detail ->> 'dur_ms')::numeric >= 250 AND outcome = 'cas_miss'), count(*)
    INTO v_n, v_tot FROM rmch_iso.worker_out WHERE scn = 'B' AND worker = 'c2' AND detail ->> 'mode' LIKE 'hold_%';
  PERFORM pg_temp.chk('B', 'loser_blocked_on_row_lock', (v_tot - v_n), v_tot,
    v_n || '/' || v_tot || ' hold-mode losers passed precheck, blocked >=250ms on the CAS row lock, then matched 0 rows');

  SELECT count(*) FILTER (WHERE t.dispatch_mode = 'instant'
                             AND ((o.mode LIKE '%scheduled%' AND t.scheduled_status = 'converted_to_instant')
                               OR (o.mode LIKE '%instant%' AND t.scheduled_status IS NULL))), count(*)
    INTO v_n, v_tot FROM (SELECT iter, max(detail ->> 'mode') AS mode FROM rmch_iso.worker_out WHERE scn = 'B' GROUP BY iter) o
    JOIN public.trips t ON t.id = rmch_iso.uid('t', 200 + o.iter);
  PERFORM pg_temp.chk('B', 'origin_branch_correct', (v_tot - v_n), v_tot,
    'scheduled-origin trips converted_to_instant once; instant-origin trips used the instant patch (7 scheduled + 4 instant)');

  -- ======================================================================= C
  WITH r AS (
    SELECT iter,
      count(*) FILTER (WHERE worker IN ('d2', 'd3') AND outcome = 'accepted') AS wins,
      count(*) FILTER (WHERE worker = 'd1' AND outcome = 'accepted') AS stale_d1_wins,
      max(outcome) FILTER (WHERE worker = 'd1') AS d1_out,
      max(outcome) FILTER (WHERE worker = 'd2') AS d2_out, max(outcome) FILTER (WHERE worker = 'd3') AS d3_out
    FROM rmch_iso.worker_out WHERE scn = 'C' GROUP BY iter)
  SELECT count(*) FILTER (WHERE wins <> 1 OR stale_d1_wins <> 0), count(*),
         'D1(revoked stale) outcomes=' || string_agg(DISTINCT d1_out, ',') INTO v_bad, v_tot, v_ev FROM r;
  PERFORM pg_temp.chk('C', 'one_assignment_stale_revoked_never_wins', v_bad, v_tot,
    'exactly 1 of {replacement D2, late stale D3} assigned per race; cancelled driver D1''s revoked stale offer never claimed (' || v_ev || ')');

  WITH r AS (
    SELECT iter,
      (array_agg(worker) FILTER (WHERE worker IN ('d2', 'd3') AND outcome = 'accepted'))[1] AS winner
    FROM rmch_iso.worker_out WHERE scn = 'C' GROUP BY iter), j AS (
    SELECT r.winner, t.status, t.confirmed_driver_id, t.driver_id, t.scheduled_at, t.final_fare_pence, t.payment_session_id, t.gross_fare_pence,
           s.scheduled_at AS s_sched, s.final_fare_pence AS s_fare, s.payment_session_id AS s_ps, s.gross_fare_pence AS s_gross,
           (SELECT count(*) FROM public.ride_offers o WHERE o.trip_id = t.id AND o.status = 'accepted') AS n_acc,
           (SELECT o.driver_id FROM public.ride_offers o WHERE o.trip_id = t.id AND o.status = 'accepted') AS acc_driver,
           (SELECT o.status FROM public.ride_offers o WHERE o.trip_id = t.id AND o.driver_id = d1) AS d1_offer
      FROM r JOIN public.trips t ON t.id = rmch_iso.uid('t', 300 + r.iter) JOIN rmch_iso.snap s ON s.trip_id = t.id)
  SELECT count(*) FILTER (WHERE NOT (
           confirmed_driver_id = driver_id AND confirmed_driver_id = CASE winner WHEN 'd2' THEN d2 ELSE d3 END
       AND status = 'driver_assigned' AND n_acc = 1 AND acc_driver = confirmed_driver_id AND d1_offer = 'revoked'
       AND scheduled_at = s_sched AND final_fare_pence = s_fare AND gross_fare_pence = s_gross AND payment_session_id = s_ps)), count(*)
    INTO v_bad, v_tot FROM j;
  PERFORM pg_temp.chk('C', 'winner_consistent_and_preserved', v_bad, v_tot,
    'trip.confirmed_driver_id=driver_id=winner, status driver_assigned, exactly 1 accepted offer (the winner''s), D1 offer still revoked, scheduled_at/fare/payment_session_id preserved');

  SELECT string_agg(outcome || coalesce('[' || sqlstate || ']', '') || 'x' || n, ', ') INTO v_ev FROM (
    SELECT o.outcome, o.detail ->> 'sqlstate' AS sqlstate, count(*) n FROM rmch_iso.worker_out o
     WHERE o.scn = 'C' AND o.worker IN ('d2', 'd3') AND o.outcome <> 'accepted' GROUP BY 1, 2) q;
  SELECT count(*) FILTER (WHERE o.outcome NOT IN ('TRIP_NOT_AVAILABLE', 'OFFER_NOT_PENDING')), count(*)
    INTO v_bad, v_tot FROM rmch_iso.worker_out o WHERE o.scn = 'C' AND o.worker IN ('d2', 'd3') AND o.outcome <> 'accepted';
  PERFORM pg_temp.chk('C', 'loser_gets_clean_rejection', v_bad, v_tot, 'losers rejected with: ' || coalesce(v_ev, 'n/a'), coalesce(v_ev, 'n/a') || ' — pg_get_functiondef(accept_ride_offer): offer row FOR UPDATE (line 31) -> trip row FOR UPDATE (line 87) -> UPDATE sibling offers status=revoked (line 202). A sibling holding its own offer lock while queued on the trip lock deadlocks with the winner (lock-order inversion); exactly-one-assignment still holds, but the loser gets a raw 40P01 instead of TRIP_NOT_AVAILABLE.');

  SELECT count(*) FILTER (WHERE (detail ->> 'dur_ms')::numeric >= 250), count(*) INTO v_n, v_tot FROM rmch_iso.worker_out o
   WHERE o.scn = 'C' AND o.detail ->> 'mode' <> 'free' AND o.outcome <> 'accepted' AND o.worker IN ('d2', 'd3');
  PERFORM pg_temp.chk('C', 'loser_blocked_on_trip_lock', (v_tot - v_n), v_tot,
    v_n || '/' || v_tot || ' hold-mode losers blocked >=250ms on the winner''s trip/offer lock then saw TRIP_NOT_AVAILABLE');

  SELECT count(*) FILTER (WHERE outcome = 'accepted' AND worker = 'd3'), count(*) FILTER (WHERE worker = 'd3')
    INTO v_n, v_tot FROM rmch_iso.worker_out WHERE scn = 'C';
  PERFORM pg_temp.emit('C', 'stale_prior_cycle_pending_offer_can_win', 'INFO',
    v_n || '/' || v_tot || ' races were WON by D3''s still-pending prior-cycle offer (round 2 < current_broadcast_round 3). accept_ride_offer does not compare offer.broadcast_round with trips.current_broadcast_round; production defence is cancel-time revoke + driver_is_excluded_from_trip, not a round check.');

  -- ======================================================================= D
  SELECT count(*) FILTER (WHERE rows_hit > 1), count(*),
         '[' || string_agg(rows_hit::text, ',' ORDER BY iter) || ']'
    INTO v_bad, v_tot, v_ev FROM rmch_iso.worker_out WHERE scn = 'D' AND worker = 'probe_raw';
  IF v_bad = 0 THEN
    PERFORM pg_temp.emit('D', 'raw_no_overlapping_open_segments', 'PASS', 'open rows per trip after 4 parallel openers = ' || v_ev);
  ELSE
    PERFORM pg_temp.emit('D', 'raw_no_overlapping_open_segments', 'FAIL',
      v_bad || '/' || v_tot || ' trips ended up with >1 OPEN pickup segment after 4 concurrent opens; open rows per trip=' || v_ev ||
      '. trip_waiting_segments has only NON-unique idx_trip_waiting_segments_open; syncWaitingGeofenceClock does SELECT-open then INSERT with no lock, so concurrent opens overlap until the next sync heals them.');
  END IF;

  SELECT count(*) FILTER (WHERE rows_hit <> 1), count(*) INTO v_bad, v_tot
    FROM rmch_iso.worker_out WHERE scn = 'D' AND worker = 'probe_healed';
  PERFORM pg_temp.chk('D', 'heal_leaves_exactly_one_open', v_bad, v_tot,
    'after 2 parallel planOpenWaitingSegments heals every trip has exactly 1 open pickup segment');

  WITH j AS (
    SELECT i, rmch_iso.uid('t', 400 + i) AS t FROM generate_series(1, 6) i)
  SELECT count(*) FILTER (WHERE NOT (
           (SELECT started_at FROM public.trip_waiting_segments WHERE trip_id = j.t AND ended_at IS NULL)
         = (SELECT min(started_at) FROM public.trip_waiting_segments WHERE trip_id = j.t))), count(*)
    INTO v_bad, v_tot FROM j;
  PERFORM pg_temp.chk('D', 'heal_keeps_earliest_segment', v_bad, v_tot, 'the surviving open segment is always the earliest started_at');

  WITH j AS (
    SELECT i, rmch_iso.uid('t', 400 + i) AS t, clock_timestamp() + interval '60 seconds' AS at FROM generate_series(1, 6) i), m AS (
    SELECT j.i,
      rmch_iso.wseg_union_seconds(j.t, j.at) AS uni,
      extract(epoch FROM (j.at - (SELECT min(started_at) FROM public.trip_waiting_segments WHERE trip_id = j.t))) AS expect_union,
      (SELECT sum(extract(epoch FROM (least(coalesce(ended_at, j.at), j.at) - started_at))) FROM public.trip_waiting_segments WHERE trip_id = j.t) AS naive
    FROM j)
  SELECT count(*) FILTER (WHERE abs(uni - expect_union) > 0.5), count(*),
         'union_s=' || round(avg(uni), 2) || ' naive_sum_s=' || round(avg(naive), 2) INTO v_bad, v_tot, v_ev FROM m;
  PERFORM pg_temp.chk('D', 'no_double_counted_seconds', v_bad, v_tot,
    'overlapping segments are merged: counted seconds == [earliest start, now] (' || v_ev || ' avg; naive sum would over-count)', v_ev);

  SELECT count(*) FILTER (WHERE rows_hit <> 1), count(*) INTO v_bad, v_tot FROM rmch_iso.worker_out WHERE scn = 'D' AND worker = 'probe_reopen';
  SELECT v_bad + count(*) FILTER (WHERE outcome = 'opened') INTO v_bad FROM rmch_iso.worker_out WHERE scn = 'D' AND detail ->> 'mode' = 'reopen';
  PERFORM pg_temp.chk('D', 'open_when_already_open_is_noop', v_bad, v_tot,
    '4 parallel openers against an already-open segment all returned already_open; still exactly 1 open row');

  -- ======================================================================= E
  WITH st AS (SELECT * FROM rmch_iso.state WHERE scn = 'E' AND label = 'after_rematch'),
  c AS (SELECT iter, outcome, t_start, detail FROM rmch_iso.worker_out WHERE scn = 'E' AND worker = 'cancel')
  SELECT count(*) FILTER (WHERE NOT (c.outcome = 'cas_won' AND c.detail ->> 'branch' = 'scheduled_origin'
           AND st.trip ->> 'dispatch_mode' = 'instant' AND st.trip ->> 'scheduled_status' = 'converted_to_instant'
           AND st.trip ->> 'status' = 'searching_new_driver' AND st.trip ->> 'dispatch_status' = 'broadcasting'
           AND (st.trip ->> 'broadcast_enabled')::boolean AND st.trip ->> 'cancelled_by' = 'driver'
           AND st.trip ->> 'scheduled_ack_status' = 'cancelled'
           AND st.trip ->> 'scheduled_ack_resolution_reason' = 'driver_cancel_after_heading_to_pickup')), count(*)
    INTO v_bad, v_tot FROM st JOIN c USING (iter);
  PERFORM pg_temp.chk('E', 'scheduled_cancel_converts_to_searching_new_driver', v_bad, v_tot,
    'dispatch_mode=instant, scheduled_status=converted_to_instant, status=searching_new_driver, dispatch_status=broadcasting, ack=cancelled/driver_cancel_after_heading_to_pickup');

  WITH st AS (SELECT * FROM rmch_iso.state WHERE scn = 'E' AND label = 'after_rematch'), j AS (
    SELECT st.trip AS t, to_jsonb(s) AS s FROM st JOIN rmch_iso.snap s ON s.trip_id = (st.trip ->> 'id')::uuid)
  SELECT count(*) FILTER (WHERE NOT (
           (t ->> 'scheduled_at')::timestamptz = (s ->> 'scheduled_at')::timestamptz
       AND (t ->> 'is_scheduled')::boolean = (s ->> 'is_scheduled')::boolean
       AND t ->> 'final_fare_pence' = s ->> 'final_fare_pence' AND t ->> 'gross_fare_pence' = s ->> 'gross_fare_pence'
       AND t ->> 'estimated_total_pence' = s ->> 'estimated_total_pence' AND t ->> 'base_fare_pence' = s ->> 'base_fare_pence'
       AND (t ->> 'estimated_fare')::numeric = (s ->> 'estimated_fare')::numeric
       AND t ->> 'payment_session_id' = s ->> 'payment_session_id'
       AND t ->> 'payment_state' = s ->> 'payment_state' AND t ->> 'payment_method' = s ->> 'payment_method')), count(*)
    INTO v_bad, v_tot FROM j;
  PERFORM pg_temp.chk('E', 'scheduled_at_fare_payment_session_preserved', v_bad, v_tot,
    'scheduled_at, is_scheduled, final/gross/estimated/base fare, payment_state, payment_method and payment_session_id identical to pre-cancel snapshot');

  WITH st AS (SELECT * FROM rmch_iso.state WHERE scn = 'E' AND label = 'after_rematch'),
  c AS (SELECT iter, t_start FROM rmch_iso.worker_out WHERE scn = 'E' AND worker = 'cancel')
  SELECT count(*) FILTER (WHERE NOT (
           (st.trip ->> 'searching_expires_at')::timestamptz - c.t_start BETWEEN make_interval(mins => v_find) AND make_interval(mins => v_find) + interval '10 seconds'
       AND (st.trip ->> 'searching_expires_at')::timestamptz > (SELECT scheduled_at FROM rmch_iso.snap WHERE trip_id = (st.trip ->> 'id')::uuid) - interval '3 hours 1 minute'
       AND (st.trip ->> 'current_broadcast_round')::int = 3 AND (st.trip ->> 'max_broadcast_rounds')::int >= 9)), count(*),
         'window=' || to_char(min((st.trip ->> 'searching_expires_at')::timestamptz - c.t_start), 'MI:SS.MS') || '..' || to_char(max((st.trip ->> 'searching_expires_at')::timestamptz - c.t_start), 'MI:SS.MS')
    INTO v_bad, v_tot, v_ev FROM st JOIN c USING (iter);
  PERFORM pg_temp.chk('E', 'fresh_find_window', v_bad, v_tot,
    'searching_expires_at = cancel time + ' || v_find || ' min (' || v_ev || '), current_broadcast_round=3, max_broadcast_rounds>=9', v_ev);

  WITH st AS (SELECT * FROM rmch_iso.state WHERE scn = 'E' AND label = 'after_rematch')
  SELECT count(*) FILTER (WHERE NOT (
           st.trip ->> 'confirmed_driver_id' IS NULL AND st.trip ->> 'driver_id' IS NULL
       AND st.trip ->> 'previous_driver_id' = d1::text
       AND st.trip -> 'excluded_driver_ids' = to_jsonb(ARRAY[d1::text]) AND st.trip -> 'cancelled_driver_ids' = to_jsonb(ARRAY[d1::text])
       AND st.trip ->> 'scheduled_accepted_at' IS NULL AND st.trip ->> 'commitment_time' IS NULL AND st.trip ->> 'scheduled_committed_at' IS NULL
       AND (st.extra ->> 'd1_excluded')::boolean AND NOT (st.extra ->> 'd2_excluded')::boolean AND NOT (st.extra ->> 'd4_excluded')::boolean)), count(*)
    INTO v_bad, v_tot FROM st;
  PERFORM pg_temp.chk('E', 'assignment_cleared_d1_excluded', v_bad, v_tot,
    'driver_id/confirmed_driver_id NULL, previous_driver_id=D1, D1 in excluded+cancelled lists, driver_is_excluded_from_trip(D1)=true, D2/D4=false');

  WITH st AS (SELECT * FROM rmch_iso.state WHERE scn = 'E' AND label = 'after_rematch')
  SELECT count(*) FILTER (WHERE NOT (
           st.trip ->> 'arrived_at' IS NULL AND st.trip ->> 'pickup_waiting_started_at' IS NULL
       AND (st.trip ->> 'pickup_waiting_counted_seconds')::int = 0 AND st.trip ->> 'waiting_geofence_status' = 'not_started'
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(st.segs) g WHERE g ->> 'ended_at' IS NULL)
       AND jsonb_array_length(st.segs) = 1)), count(*)
    INTO v_bad, v_tot FROM st;
  PERFORM pg_temp.chk('E', 'previous_driver_waiting_clock_reset', v_bad, v_tot,
    'arrived_at/pickup_waiting_started_at cleared, counted=0, geofence not_started, the cancelled driver''s open segment closed (0 open, 1 closed)');

  WITH st AS (SELECT * FROM rmch_iso.state WHERE scn = 'E' AND label = 'after_offers'), j AS (
    SELECT st.*, (st.trip ->> 'searching_expires_at')::timestamptz AS se,
      (SELECT count(*) FROM jsonb_array_elements(st.offers) o WHERE o ->> 'driver_id' = d2::text AND (o ->> 'broadcast_round')::int = 4) AS n_d2,
      (SELECT count(*) FROM jsonb_array_elements(st.offers) o WHERE o ->> 'driver_id' = d4::text AND (o ->> 'broadcast_round')::int = 4) AS n_d4,
      (SELECT count(*) FROM jsonb_array_elements(st.offers) o WHERE o ->> 'driver_id' = d1::text AND o ->> 'status' = 'pending') AS d1_pending,
      (SELECT count(*) FROM jsonb_array_elements(st.offers) o WHERE o ->> 'driver_id' = d1::text AND o ->> 'status' = 'revoked') AS d1_revoked,
      (SELECT bool_and((o ->> 'expires_at')::timestamptz <= (st.trip ->> 'searching_expires_at')::timestamptz AND (o ->> 'expires_at')::timestamptz > now())
         FROM jsonb_array_elements(st.offers) o WHERE o ->> 'status' = 'pending') AS exp_ok
    FROM st)
  SELECT count(*) FILTER (WHERE NOT (n_d2 = 1 AND n_d4 = 1 AND d1_pending = 0 AND d1_revoked = 1 AND exp_ok)), count(*) INTO v_bad, v_tot FROM j;
  PERFORM pg_temp.chk('E', 'replacement_offers_fresh_window', v_bad, v_tot,
    'replacement offers (round 4) for D2 and D4 each exist exactly once, expire inside the fresh find window; D1 has no pending offer (old one revoked)');

  SELECT count(*) FILTER (WHERE n_ins <> 1 OR n_conf <> 1), count(*) INTO v_bad, v_tot FROM (
    SELECT iter, count(*) FILTER (WHERE outcome = 'inserted') AS n_ins, count(*) FILTER (WHERE outcome = 'conflict_ignored') AS n_conf
      FROM rmch_iso.worker_out WHERE scn = 'E' AND worker IN ('ins_d2_a', 'ins_d2_b') GROUP BY iter) q;
  PERFORM pg_temp.chk('E', 'concurrent_dispatch_insert_dedup', v_bad, v_tot,
    'two dispatchers inserting the same (trip, driver, round) replacement offer: 1 inserted + 1 conflict_ignored via UNIQUE(trip_id,driver_id,broadcast_round)');

  -- ======================================================================= F
  WITH r AS (
    SELECT iter, count(*) FILTER (WHERE worker IN ('d2', 'd4') AND outcome = 'accepted') AS wins,
           count(*) FILTER (WHERE worker = 'd1' AND outcome = 'accepted') AS d1_wins,
           string_agg(DISTINCT outcome, ',') FILTER (WHERE worker = 'd1') AS d1_out
    FROM rmch_iso.worker_out WHERE scn = 'F' GROUP BY iter)
  SELECT count(*) FILTER (WHERE wins <> 1 OR d1_wins <> 0), count(*), string_agg(DISTINCT d1_out, ',') INTO v_bad, v_tot, v_ev FROM r;
  PERFORM pg_temp.chk('F', 'exactly_one_replacement_accepted', v_bad, v_tot,
    'D2 vs D4 raced: exactly 1 accepted per trip; excluded D1 rejected with ' || v_ev);

  WITH r AS (
    SELECT iter, (array_agg(worker) FILTER (WHERE worker IN ('d2', 'd4') AND outcome = 'accepted'))[1] AS winner
    FROM rmch_iso.worker_out WHERE scn = 'F' GROUP BY iter), j AS (
    SELECT r.winner, t.status, t.confirmed_driver_id, t.driver_id, t.scheduled_at, t.final_fare_pence, t.gross_fare_pence, t.payment_session_id,
           t.dispatch_mode, t.scheduled_status,
           s.scheduled_at AS s_sched, s.final_fare_pence AS s_fare, s.gross_fare_pence AS s_gross, s.payment_session_id AS s_ps,
           (SELECT count(*) FROM public.ride_offers o WHERE o.trip_id = t.id AND o.status = 'accepted') AS n_acc,
           (SELECT o.driver_id FROM public.ride_offers o WHERE o.trip_id = t.id AND o.status = 'accepted') AS acc_driver
      FROM r JOIN public.trips t ON t.id = rmch_iso.uid('t', 500 + r.iter) JOIN rmch_iso.snap s ON s.trip_id = t.id)
  SELECT count(*) FILTER (WHERE NOT (
           confirmed_driver_id = driver_id AND confirmed_driver_id = CASE winner WHEN 'd2' THEN d2 ELSE d4 END
       AND status = 'driver_assigned' AND n_acc = 1 AND acc_driver = confirmed_driver_id
       AND scheduled_at = s_sched AND final_fare_pence = s_fare AND gross_fare_pence = s_gross AND payment_session_id = s_ps)), count(*),
         string_agg(DISTINCT dispatch_mode || '/' || scheduled_status, ',') INTO v_bad, v_tot, v_ev FROM j;
  PERFORM pg_temp.chk('F', 'assignment_consistent_and_preserved', v_bad, v_tot,
    'confirmed_driver_id=driver_id=winner, driver_assigned, exactly 1 accepted offer; scheduled_at, fare and payment_session_id still the original (post-accept dispatch_mode/scheduled_status = ' || v_ev || ')');

  SELECT count(*) FILTER (WHERE o.outcome NOT IN ('TRIP_NOT_AVAILABLE', 'OFFER_NOT_PENDING')), count(*), string_agg(DISTINCT o.outcome, ',')
    INTO v_bad, v_tot, v_ev FROM rmch_iso.worker_out o WHERE o.scn = 'F' AND o.worker IN ('d2', 'd4') AND o.outcome <> 'accepted';
  SELECT string_agg(outcome || coalesce('[' || sqlstate || ']', '') || 'x' || n, ', ') INTO v_ev FROM (
    SELECT o.outcome, o.detail ->> 'sqlstate' AS sqlstate, count(*) n FROM rmch_iso.worker_out o
     WHERE o.scn = 'F' AND o.worker IN ('d2', 'd4') AND o.outcome <> 'accepted' GROUP BY 1, 2) q;
  PERFORM pg_temp.chk('F', 'loser_gets_clean_rejection', v_bad, v_tot, 'losing replacement rejected with: ' || coalesce(v_ev, 'n/a'), coalesce(v_ev, 'n/a') || ' — pg_get_functiondef(accept_ride_offer): offer row FOR UPDATE (line 31) -> trip row FOR UPDATE (line 87) -> UPDATE sibling offers status=revoked (line 202). A sibling holding its own offer lock while queued on the trip lock deadlocks with the winner (lock-order inversion); exactly-one-assignment still holds, but the loser gets a raw 40P01 instead of TRIP_NOT_AVAILABLE.');

  SELECT count(*) FILTER (WHERE (o.detail ->> 'dur_ms')::numeric >= 250), count(*) INTO v_n, v_tot
    FROM rmch_iso.worker_out o WHERE o.scn = 'F' AND o.detail ->> 'mode' = 'd2_holds' AND o.worker = 'd4';
  PERFORM pg_temp.chk('F', 'losers_blocked_on_trip_lock', (v_tot - v_n), v_tot,
    v_n || '/' || v_tot || ' competing replacement claims blocked >=250ms behind the holder of the trip lock (excluded D1 is rejected before the trip lock, so it is not counted)');

  PERFORM pg_temp.emit('F', 'excluded_driver_claim', 'INFO',
    'D1 claim outcomes: ' || (SELECT string_agg(outcome || 'x' || n, ', ') FROM (SELECT outcome, count(*) n FROM rmch_iso.worker_out WHERE scn = 'F' AND worker = 'd1' GROUP BY outcome) q));

  -- Raw DB errors surfaced to a losing worker (digest).
  SELECT string_agg(scn || ' [' || coalesce(sqlstate, '?') || '] "' || coalesce(msg, '') || '" x' || n || coalesce(' :: ' || ex, ''), E'\n          ')
    INTO v_ev FROM (
    SELECT scn, detail ->> 'sqlstate' AS sqlstate, detail ->> 'message' AS msg, count(*) AS n,
           left(replace(min(detail ->> 'pg_detail'), E'\n', ' | '), 420) AS ex
      FROM rmch_iso.worker_out WHERE outcome = 'EXCEPTION' GROUP BY scn, detail ->> 'sqlstate', detail ->> 'message') q;
  IF v_ev IS NOT NULL THEN
    PERFORM pg_temp.emit('X', 'raw_exceptions_seen_by_workers', 'INFO', E'\n          ' || v_ev);
  END IF;
END
$verify$;

-- ------------------------------------------------------------------ report (stdout)
SELECT rpad(verdict, 8) || scenario || '.' || check_name || ' — ' || evidence FROM rmch_iso.verdict ORDER BY seq;
\echo
\echo '--- scenario summary ---------------------------------------------------------'
SELECT 'SCENARIO ' || scn || ' => ' ||
       CASE WHEN f > 0 THEN 'FAIL' WHEN p = 0 AND s > 0 THEN 'SKIPPED' ELSE 'PASS' END ||
       '   (pass=' || p || ' fail=' || f || ' skipped=' || s || ' info=' || i || ')'
  FROM (SELECT substr(scenario, 1, 1) AS scn,
               count(*) FILTER (WHERE verdict = 'PASS') AS p, count(*) FILTER (WHERE verdict = 'FAIL') AS f,
               count(*) FILTER (WHERE verdict = 'SKIPPED') AS s, count(*) FILTER (WHERE verdict = 'INFO') AS i
          FROM rmch_iso.verdict GROUP BY 1) q ORDER BY scn;
SELECT 'TOTAL fail=' || count(*) FILTER (WHERE verdict = 'FAIL') || ' pass=' || count(*) FILTER (WHERE verdict = 'PASS')
       || ' skipped=' || count(*) FILTER (WHERE verdict = 'SKIPPED') FROM rmch_iso.verdict;

DO $final$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM rmch_iso.verdict WHERE verdict = 'FAIL';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'CONCURRENCY_HARNESS_FAILED: % assertion(s) failed', v_n;
  END IF;
END
$final$;
