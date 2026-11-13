-- ============================================================================
-- process_ride_offer_ack_timeouts lock-order / concurrency harness  --  SETUP (extra helpers)
--   migration under test: 20270222220000_ack_timeout_sweep_trip_first_lock_order.sql
--
-- Runs AFTER negotiation_lock_order_isolated.setup.sql (reuses its neg_iso schema, synthetic ids
-- 00000000-0000-4000-{8100,9100,a100,b100}-*, TEST-NEG-* client_action_id and cleanup).
-- LOCAL DB ONLY. No Edge, no Revolut, no push.
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on

DO $pre$
DECLARE v_missing text;
BEGIN
  IF to_regclass('neg_iso.worker_out') IS NULL THEN
    RAISE EXCEPTION 'BLOCKER: neg_iso schema missing (run negotiation_lock_order_isolated.setup.sql first)';
  END IF;
  SELECT string_agg(x, ', ') INTO v_missing FROM unnest(ARRAY[
    'public.process_ride_offer_ack_timeouts()',
    'public.accept_ride_offer(uuid,uuid,boolean)',
    'public.decline_ride_offer(uuid,uuid,text)',
    'public.driver_send_preset_offer(uuid,integer,integer[],integer)',
    'public.apply_terminal_trip_cancellation(uuid,text,text)'
  ]) AS x WHERE to_regprocedure(x) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'BLOCKER: required RPC(s) missing: %', v_missing;
  END IF;
END
$pre$;

-- Ack-timeout fixture: the PRE-MIGRATION shape of a stuck delivery.
--   O1 (D1) pending, un-acked, expires_at = p_expires ; O2 (D2) pending, NOT due (+10 min)
--   trips.current_offer_driver_id = D1 (the pointer the sweep must clear)
CREATE FUNCTION neg_iso.mk_ack_trip(p_n bigint, p_scn text, p_iter int, p_expires timestamptz) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_trip uuid := neg_iso.mk_trip(p_n, 'preset_pending', p_scn, p_iter);
  d1 uuid := neg_iso.uid('d', 1);
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  EXECUTE 'SET LOCAL session_replication_role = replica';
  UPDATE public.ride_offers SET expires_at = p_expires, ack_at = NULL, responded_at = NULL
   WHERE trip_id = v_trip AND driver_id = d1;
  UPDATE public.trips SET current_offer_driver_id = d1, current_offer_expires_at = p_expires WHERE id = v_trip;
  EXECUTE 'SET LOCAL session_replication_role = origin';
  RETURN v_trip;
END $$;

-- One action through the REAL RPC / sweep. Never throws: records SQLSTATE.
--   sweep : process_ride_offer_ack_timeouts() ; reports whether OUR offer was expired by it and the
--           offer status seen at the end of the call. Other actions delegate to neg_iso.act.
CREATE FUNCTION neg_iso.ack_act(p_action text, p_trip uuid, p_offer uuid, p_driver uuid, p_hold_ms int DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_n int; v_ours boolean; v_status text;
BEGIN
  IF p_action <> 'sweep' THEN
    RETURN neg_iso.act(p_action, p_trip, p_offer, p_driver, 570, p_hold_ms);
  END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  SELECT count(*), coalesce(bool_or(s.offer_id = p_offer), false) INTO v_n, v_ours
    FROM public.process_ride_offer_ack_timeouts() s;
  SELECT status INTO v_status FROM public.ride_offers WHERE id = p_offer;
  IF p_hold_ms > 0 THEN PERFORM pg_sleep(p_hold_ms / 1000.0); END IF;
  RETURN jsonb_build_object('threw', false, 'ok', true, 'swept', v_n, 'ours', v_ours, 'offer_status_after', v_status);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('threw', true, 'ok', false, 'sqlstate', SQLSTATE, 'message', SQLERRM,
    'raw_contention', SQLSTATE IN ('40P01', '40001', '55P03'));
END $$;

\echo 'ACK_SETUP_OK'
