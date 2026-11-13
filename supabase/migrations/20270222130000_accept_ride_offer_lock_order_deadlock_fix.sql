-- ============================================================================
-- accept_ride_offer / accept_stacked_ride — consistent lock order (deadlock fix)
--
-- Defect (harness scenarios C and F, two drivers racing for the same trip):
--   accept_ride_offer locked   offer row (own)  FOR UPDATE   -- line ~31
--                    then      trip row         FOR UPDATE   -- line ~87
--                    then      UPDATE sibling offers (revoke) -- line ~202
--   Driver X (winner) holds the trip lock and wants Driver Y's offer row (revoke);
--   Driver Y holds its own offer row and wants the trip lock => 40P01 deadlock.
--   Exactly-one-assignment held, but the loser received a raw 40P01.
--
-- Fix (single canonical order for every assignment path):
--   advisory driver lock -> TRIP row FOR UPDATE -> own OFFER row FOR UPDATE
--   -> sibling offers (revoke) -> trip UPDATE.
--   * The trip id is read from the offer WITHOUT a lock (ride_offers.trip_id is
--     immutable), the trip row is locked first, then the offer row, then every
--     later guard re-reads under both locks (READ COMMITTED sees the winner).
--   * accept_stacked_ride gets the same trip-first lock.
--
-- Defence in depth for the public RPC:
--   public.accept_ride_offer is now a thin wrapper around
--   public.accept_ride_offer_core (the previous body + new lock order). If a lock
--   conflict with an UNRELATED path (negotiation RPCs still lock offer -> trip)
--   still raises 40P01 / 40001, the sub-transaction is rolled back (so nothing is
--   half-applied) and the call is retried up to 3 times. The core is idempotent
--   (accepted + confirmed offer short-circuits to success). After the retries the
--   caller gets a DOMAIN response (OFFER_NOT_PENDING / TRIP_NOT_AVAILABLE) — never
--   a raw SQLSTATE.
--
-- Single-winner assignment, payment gate, fare finalisation, commission snapshot,
-- Gap B commitment gate and all response shapes are unchanged. The body is patched
-- from the live pg_get_functiondef (same pattern as 20270218120000) so no historical
-- logic is re-typed. No Revolut / financial change.
--
-- Admin reassignment (admin-trip-action "reassign") issues independent autocommit
-- statements (offer revoke, trip update, driver update); it never holds an offer
-- lock while waiting on a trip lock, so it cannot form a cycle with this order.
-- driver_cancel_before_start_rematch / admin_cancel_trip_negotiation already lock
-- the trip FOR UPDATE before touching offers (the same order).
-- ============================================================================

BEGIN;

-- ── 1) accept_ride_offer_core: previous body + trip-first lock order ──────────
DO $patch$
DECLARE
  v_def text;
  v_decl_marker text := E'  v_now timestamptz := now();\nBEGIN\n';
  v_decl_inject text := E'  v_now timestamptz := now();\n  v_lock_trip_id uuid;\nBEGIN\n';
  v_lock_marker text :=
    E'  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;\n';
  v_lock_inject text :=
$inj$
  -- Lock order (deadlock fix): TRIP row FOR UPDATE first, then the offer row.
  -- trip_id is immutable, so reading it unlocked is safe; every guard below
  -- re-reads under both locks.
  SELECT o.trip_id INTO v_lock_trip_id FROM public.ride_offers o WHERE o.id = p_offer_id;
  IF v_lock_trip_id IS NOT NULL THEN
    PERFORM 1 FROM public.trips t WHERE t.id = v_lock_trip_id FOR UPDATE;
  END IF;

  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;
$inj$;
BEGIN
  -- Prefer an already-created core (re-run safe); otherwise derive it from the live function.
  IF to_regprocedure('public.accept_ride_offer_core(uuid,uuid,boolean)') IS NOT NULL THEN
    SELECT pg_get_functiondef('public.accept_ride_offer_core(uuid,uuid,boolean)'::regprocedure) INTO v_def;
    IF position('v_lock_trip_id' in v_def) > 0 THEN
      RAISE NOTICE 'accept_ride_offer_core already carries trip-first lock order';
      RETURN;
    END IF;
  ELSE
    SELECT pg_get_functiondef('public.accept_ride_offer(uuid,uuid,boolean)'::regprocedure) INTO v_def;
    IF v_def IS NULL THEN
      RAISE EXCEPTION 'accept_ride_offer(uuid,uuid,boolean) missing';
    END IF;
    IF position('v_lock_trip_id' in v_def) > 0 THEN
      -- A previous partial run patched the public function in place; rename only.
      v_def := replace(v_def, 'FUNCTION public.accept_ride_offer(', 'FUNCTION public.accept_ride_offer_core(');
      EXECUTE v_def;
      RETURN;
    END IF;
    v_def := replace(v_def, 'FUNCTION public.accept_ride_offer(', 'FUNCTION public.accept_ride_offer_core(');
  END IF;

  IF position(v_decl_marker in v_def) = 0 OR position(v_lock_marker in v_def) = 0 THEN
    RAISE EXCEPTION 'accept_ride_offer lock-order patch marker not found — abort';
  END IF;
  v_def := replace(v_def, v_decl_marker, v_decl_inject);
  v_def := replace(v_def, v_lock_marker, v_lock_inject);
  EXECUTE v_def;
END
$patch$;

-- Internal only: reachable through the wrapper (SECURITY DEFINER owner), never by clients.
REVOKE ALL ON FUNCTION public.accept_ride_offer_core(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_ride_offer_core(uuid, uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.accept_ride_offer_core(uuid, uuid, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public.accept_ride_offer_core(uuid, uuid, boolean) FROM service_role;

COMMENT ON FUNCTION public.accept_ride_offer_core(uuid, uuid, boolean) IS
  'Internal body of accept_ride_offer. Lock order: driver advisory -> trip FOR UPDATE -> offer FOR UPDATE -> sibling offers -> trip UPDATE. Call only via accept_ride_offer().';

-- Domain outcome used when lock contention outlives the retry budget.
CREATE OR REPLACE FUNCTION public.accept_ride_offer_contention_result(
  p_offer_id uuid,
  p_driver_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_offer public.ride_offers%ROWTYPE;
  v_trip public.trips%ROWTYPE;
BEGIN
  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_FOUND', 'message', 'Offer not found');
  END IF;
  IF v_offer.driver_id IS DISTINCT FROM p_driver_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'DRIVER_MISMATCH', 'message', 'Offer not yours');
  END IF;
  IF v_offer.status = 'accepted' AND v_offer.negotiation_status = 'confirmed' THEN
    -- The other attempt actually committed this driver's acceptance.
    SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id;
    IF v_trip.driver_id = p_driver_id OR v_trip.confirmed_driver_id = p_driver_id THEN
      RETURN public.accept_ride_offer_core(p_offer_id, p_driver_id, false);
    END IF;
  END IF;
  IF v_offer.status NOT IN ('pending', 'countered') THEN
    RETURN jsonb_build_object('success', false, 'error', 'OFFER_NOT_PENDING',
      'message', 'Offer already ' || COALESCE(v_offer.status, 'handled'));
  END IF;
  RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_AVAILABLE',
    'message', 'Ride already taken');
END;
$$;

REVOKE ALL ON FUNCTION public.accept_ride_offer_contention_result(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_ride_offer_contention_result(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.accept_ride_offer_contention_result(uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.accept_ride_offer_contention_result(uuid, uuid) FROM service_role;

-- ── 2) Public RPC: bounded, safe retry + domain response (never raw 40P01) ───
CREATE OR REPLACE FUNCTION public.accept_ride_offer(
  p_offer_id uuid,
  p_driver_id uuid,
  p_allow_customer_counter boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_attempt integer := 0;
  v_max_attempts constant integer := 3;
BEGIN
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      -- Sub-transaction: a deadlock / serialization victim rolls back completely
      -- (no half-applied assignment) and the idempotent core is simply retried.
      RETURN public.accept_ride_offer_core(p_offer_id, p_driver_id, p_allow_customer_counter);
    EXCEPTION
      WHEN deadlock_detected OR serialization_failure THEN
        IF v_attempt >= v_max_attempts THEN
          RETURN public.accept_ride_offer_contention_result(p_offer_id, p_driver_id);
        END IF;
        PERFORM pg_sleep(0.02 * v_attempt + random() * 0.03);
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) TO service_role;

COMMENT ON FUNCTION public.accept_ride_offer(uuid, uuid, boolean) IS
  'Single-winner offer acceptance (wrapper). Retries deadlock/serialization victims up to 3x and returns a domain error (OFFER_NOT_PENDING / TRIP_NOT_AVAILABLE) instead of raw 40P01. Body: accept_ride_offer_core (trip-first FOR UPDATE order).';

-- ── 3) accept_stacked_ride: same trip-first lock ──────────────────────────────
DO $patch$
DECLARE
  v_def text;
  v_decl_marker text := E'  v_next_position      integer;\n  v_driver_net         integer;\nBEGIN\n';
  v_decl_inject text :=
    E'  v_next_position      integer;\n  v_driver_net         integer;\n  v_lock_trip_id       uuid;\nBEGIN\n';
  v_lock_marker text :=
    E'  SELECT * INTO v_offer\n  FROM public.ride_offers\n  WHERE id = p_offer_id\n  FOR UPDATE;\n';
  v_lock_inject text :=
$inj$
  -- Lock order (deadlock fix): TRIP row FOR UPDATE before the offer row, same as
  -- accept_ride_offer_core. trip_id is immutable so the unlocked read is safe.
  SELECT o.trip_id INTO v_lock_trip_id FROM public.ride_offers o WHERE o.id = p_offer_id;
  IF v_lock_trip_id IS NOT NULL THEN
    PERFORM 1 FROM public.trips t WHERE t.id = v_lock_trip_id FOR UPDATE;
  END IF;

  SELECT * INTO v_offer
  FROM public.ride_offers
  WHERE id = p_offer_id
  FOR UPDATE;
$inj$;
BEGIN
  SELECT pg_get_functiondef('public.accept_stacked_ride(uuid,uuid,uuid)'::regprocedure) INTO v_def;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'accept_stacked_ride(uuid,uuid,uuid) missing';
  END IF;
  IF position('v_lock_trip_id' in v_def) > 0 THEN
    RAISE NOTICE 'accept_stacked_ride already carries trip-first lock order';
    RETURN;
  END IF;
  IF position(v_decl_marker in v_def) = 0 OR position(v_lock_marker in v_def) = 0 THEN
    RAISE EXCEPTION 'accept_stacked_ride lock-order patch marker not found — abort';
  END IF;
  v_def := replace(v_def, v_decl_marker, v_decl_inject);
  v_def := replace(v_def, v_lock_marker, v_lock_inject);
  EXECUTE v_def;
END
$patch$;

COMMIT;
