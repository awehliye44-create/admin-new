-- Release candidate. Not applied. NO prod deploy from this change set.
--
-- Negotiation RPCs: consistent lock order (TRIP row first, then OFFER row) + bounded retry.
--
-- Defect (same class as 20270222130000 for accept_ride_offer):
--   customer_counter_ride_offer, driver_send_preset_offer, driver_cancel_negotiation,
--   expire_negotiation_offer, decline_ride_offer and apply_customer_decline_grace all did
--       SELECT ... FROM ride_offers WHERE id = p_offer_id FOR UPDATE      -- offer first
--       ... then the trip row (FOR UPDATE / UPDATE trips / finalize_negotiation_failure)
--   while accept_ride_offer_core, accept_stacked_ride, finalize_negotiation_failure,
--   admin_cancel_trip_negotiation, driver_cancel_before_start_rematch and
--   maybe_advance_dispatch_after_offer_resolution lock the TRIP first. Two sessions
--   (e.g. a counter-offer vs a competing acceptance / cancellation / reassignment)
--   could therefore form an offer<->trip cycle and one received a raw 40P01.
--
-- Fix
--   * Every listed RPC body is renamed to <name>_core (derived from the LIVE
--     pg_get_functiondef - no historical logic is re-typed) and gets ONE injected statement
--     directly before its offer lock:
--         PERFORM 1 FROM public.trips t
--          WHERE t.id = (SELECT o.trip_id FROM public.ride_offers o WHERE o.id = p_offer_id)
--            FOR UPDATE;
--     ride_offers.trip_id is immutable, so the unlocked read is safe; every guard below
--     already re-reads under both locks (READ COMMITTED sees the winner).
--   * The public name is a thin wrapper with the SAME signature / defaults / grants.
--     deadlock_detected | serialization_failure | lock_not_available => the sub-transaction is
--     rolled back (nothing half-applied) and the core is retried up to 3 times with jitter.
--     After the budget the caller gets a DOMAIN outcome - never a raw SQLSTATE:
--       raising RPCs (customer_counter_ride_offer, driver_send_preset_offer) RAISE one of
--         not_waiting_customer | offer_not_found | offer_not_pending | trip_already_assigned
--         | negotiation_contention        (the messages callers already map)
--       jsonb RPCs return {success:false, error:'OFFER_NOT_PENDING'|'OFFER_NOT_FOUND'|
--         'TRIP_ALREADY_ASSIGNED'|'NEGOTIATION_CONTENTION', ...}
--   * Business exceptions raised by the core (invalid_fare, forbidden_customer, ...) are NOT
--     caught and propagate unchanged.
--
-- Related integrity fix found by the counter-vs-reassignment race (supabase/tests/negotiation_lock_order_*):
--   driver_cancel_before_start_rematch / admin cancel REVOKE the offer but leave
--   negotiation_status = 'waiting_customer'. customer_counter_ride_offer and
--   apply_customer_decline_grace only checked negotiation_status, so a late customer tap on the
--   stale card RESURRECTED the revoked offer (status -> countered) and flipped the reassigned trip
--   back to 'negotiating'. Both cores now also refuse a TERMINAL offer
--   (revoked | expired | declined | accepted) with the error they already return for a non-waiting
--   offer (not_waiting_customer / INVALID_STATE); customer_counter_ride_offer additionally refuses a
--   trip that already has an assigned driver. A live waiting_customer offer is always
--   status 'countered' (driver_send_preset_offer), so the normal workflow is unchanged.
--
-- Not changed: preset chips, customer counter workflow, timers (negotiation_expires_at etc.),
-- fare commit (commit_negotiation_fare), financial rules, notifications, any offer / trip row.
-- No payment / Revolut change.
--
-- Rollback: supabase/migrations/rollback/rollback_20270222180000_negotiation_rpc_trip_first_lock_order.sql

BEGIN;

-- ── 0) Domain outcome used when contention outlives the retry budget ──────────
CREATE OR REPLACE FUNCTION public.negotiation_contention_outcome(
  p_offer_id uuid,
  p_rpc text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_offer public.ride_offers%ROWTYPE;
  v_trip public.trips%ROWTYPE;
BEGIN
  SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id;
  IF NOT FOUND THEN RETURN 'offer_not_found'; END IF;

  IF p_rpc = 'customer_counter_ride_offer' THEN
    IF v_offer.negotiation_status IS DISTINCT FROM 'waiting_customer' THEN
      RETURN 'not_waiting_customer';
    END IF;
    RETURN 'negotiation_contention';
  END IF;

  IF v_offer.status NOT IN ('pending', 'countered') THEN RETURN 'offer_not_pending'; END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_offer.trip_id;
  IF FOUND AND v_trip.driver_id IS NOT NULL AND v_trip.status IN (
    'confirmed','accepted','driver_assigned','en_route','en_route_to_pickup',
    'driver_en_route','arrived','arrived_pickup','in_progress','completed'
  ) THEN
    RETURN 'trip_already_assigned';
  END IF;
  RETURN 'negotiation_contention';
END;
$$;

REVOKE ALL ON FUNCTION public.negotiation_contention_outcome(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.negotiation_contention_outcome(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.negotiation_contention_outcome(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.negotiation_contention_outcome(uuid, text) FROM service_role;

-- ── 1) Cores: live body + trip-first lock (derived, never re-typed) ──────────
DO $patch$
DECLARE
  v_spec text[];
  v_def text;
  v_marker constant text :=
    'SELECT * INTO v_offer FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;';
  v_inject constant text :=
    E'PERFORM 1 FROM public.trips t WHERE t.id = (SELECT o.trip_id FROM public.ride_offers o WHERE o.id = p_offer_id) FOR UPDATE; -- negotiation trip-first lock\n  ';
  v_waiting_check constant text :=
    E'IF v_offer.negotiation_status IS DISTINCT FROM ''waiting_customer'' THEN';
  v_waiting_check_terminal constant text :=
    E'IF v_offer.negotiation_status IS DISTINCT FROM ''waiting_customer''\n     OR v_offer.status IN (''revoked'', ''expired'', ''declined'', ''accepted'') THEN -- terminal offer guard';
  v_trip_nf constant text :=
    E'IF NOT FOUND THEN\n    RAISE EXCEPTION ''trip_not_found'';\n  END IF;\n';
  v_trip_assigned constant text :=
    E'\n  IF v_trip.driver_id IS NOT NULL AND v_trip.status IN (\n    ''confirmed'',''accepted'',''driver_assigned'',''en_route'',''en_route_to_pickup'',\n    ''driver_en_route'',''arrived'',''arrived_pickup'',''in_progress'',''completed''\n  ) THEN -- assigned-trip guard\n    RAISE EXCEPTION ''not_waiting_customer'';\n  END IF;\n';
  -- {public name, live signature (regprocedure text), core signature}
  v_specs constant text[][] := ARRAY[
    ARRAY['customer_counter_ride_offer', 'public.customer_counter_ride_offer(uuid,integer,uuid,uuid)',
          'public.customer_counter_ride_offer_core(uuid,integer,uuid,uuid)'],
    ARRAY['driver_send_preset_offer', 'public.driver_send_preset_offer(uuid,integer,integer[],integer)',
          'public.driver_send_preset_offer_core(uuid,integer,integer[],integer)'],
    ARRAY['driver_cancel_negotiation', 'public.driver_cancel_negotiation(uuid,uuid)',
          'public.driver_cancel_negotiation_core(uuid,uuid)'],
    ARRAY['expire_negotiation_offer', 'public.expire_negotiation_offer(uuid)',
          'public.expire_negotiation_offer_core(uuid)'],
    ARRAY['decline_ride_offer', 'public.decline_ride_offer(uuid,uuid,text)',
          'public.decline_ride_offer_core(uuid,uuid,text)'],
    ARRAY['apply_customer_decline_grace', 'public.apply_customer_decline_grace(uuid,text)',
          'public.apply_customer_decline_grace_core(uuid,text)']
  ];
  i integer;
BEGIN
  FOR i IN 1 .. array_length(v_specs, 1) LOOP
    v_spec := ARRAY[v_specs[i][1], v_specs[i][2], v_specs[i][3]];

    IF to_regprocedure(v_spec[3]) IS NOT NULL THEN
      SELECT pg_get_functiondef(to_regprocedure(v_spec[3])) INTO v_def;
      IF position('negotiation trip-first lock' in v_def) = 0 THEN
        RAISE EXCEPTION '% exists without the trip-first lock - abort', v_spec[3];
      END IF;
      RAISE NOTICE '% already carries trip-first lock order', v_spec[3];
      CONTINUE;
    END IF;

    IF to_regprocedure(v_spec[2]) IS NULL THEN
      RAISE EXCEPTION '% missing', v_spec[2];
    END IF;
    SELECT pg_get_functiondef(to_regprocedure(v_spec[2])) INTO v_def;
    IF position('_core(' in v_def) > 0 THEN
      RAISE EXCEPTION '% already looks like a wrapper but its core is missing - abort', v_spec[2];
    END IF;
    IF position(v_marker in v_def) = 0 THEN
      RAISE EXCEPTION '% offer-lock marker not found - abort', v_spec[2];
    END IF;
    IF length(v_def) - length(replace(v_def, v_marker, '')) <> length(v_marker) THEN
      RAISE EXCEPTION '% offer-lock marker is not unique - abort', v_spec[2];
    END IF;

    v_def := replace(v_def, 'FUNCTION public.' || v_spec[1] || '(', 'FUNCTION public.' || v_spec[1] || '_core(');
    v_def := replace(v_def, v_marker, v_inject || v_marker);

    -- Terminal-offer guard (never resurrect a revoked / expired / declined / accepted offer).
    IF v_spec[1] IN ('customer_counter_ride_offer', 'apply_customer_decline_grace') THEN
      IF length(v_def) - length(replace(v_def, v_waiting_check, '')) <> length(v_waiting_check) THEN
        RAISE EXCEPTION '% waiting_customer check not found / not unique - abort', v_spec[2];
      END IF;
      v_def := replace(v_def, v_waiting_check, v_waiting_check_terminal);
    END IF;
    IF v_spec[1] = 'customer_counter_ride_offer' THEN
      IF position(v_trip_nf in v_def) = 0 THEN
        RAISE EXCEPTION '% trip_not_found block not found - abort', v_spec[2];
      END IF;
      v_def := replace(v_def, v_trip_nf, v_trip_nf || v_trip_assigned);
    END IF;
    EXECUTE v_def;
  END LOOP;
END
$patch$;

-- Internal only: reachable through the wrapper (SECURITY DEFINER owner), never by clients.
REVOKE ALL ON FUNCTION public.customer_counter_ride_offer_core(uuid, integer, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.driver_send_preset_offer_core(uuid, integer, integer[], integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.driver_cancel_negotiation_core(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.expire_negotiation_offer_core(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.decline_ride_offer_core(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_customer_decline_grace_core(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- ── 2) Public wrappers: same signature / defaults; bounded retry + domain outcome ──
CREATE OR REPLACE FUNCTION public.customer_counter_ride_offer(
  p_offer_id uuid,
  p_selected_fare_pence integer,
  p_actor_user_id uuid DEFAULT NULL::uuid,
  p_customer_id uuid DEFAULT NULL::uuid
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
      RETURN public.customer_counter_ride_offer_core(p_offer_id, p_selected_fare_pence, p_actor_user_id, p_customer_id);
    EXCEPTION
      WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN
        IF v_attempt >= v_max_attempts THEN
          RAISE EXCEPTION '%', public.negotiation_contention_outcome(p_offer_id, 'customer_counter_ride_offer');
        END IF;
        PERFORM pg_sleep(0.02 * v_attempt + random() * 0.03);
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.driver_send_preset_offer(
  p_offer_id uuid,
  p_selected_total_fare_pence integer,
  p_allowed_total_fares_pence integer[],
  p_customer_respond_seconds integer
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
      RETURN public.driver_send_preset_offer_core(
        p_offer_id, p_selected_total_fare_pence, p_allowed_total_fares_pence, p_customer_respond_seconds);
    EXCEPTION
      WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN
        IF v_attempt >= v_max_attempts THEN
          RAISE EXCEPTION '%', public.negotiation_contention_outcome(p_offer_id, 'driver_send_preset_offer');
        END IF;
        PERFORM pg_sleep(0.02 * v_attempt + random() * 0.03);
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.driver_cancel_negotiation(p_offer_id uuid, p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_attempt integer := 0;
  v_max_attempts constant integer := 3;
  v_outcome text;
BEGIN
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      RETURN public.driver_cancel_negotiation_core(p_offer_id, p_driver_id);
    EXCEPTION
      WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN
        IF v_attempt >= v_max_attempts THEN
          v_outcome := public.negotiation_contention_outcome(p_offer_id, 'driver_cancel_negotiation');
          RETURN jsonb_build_object('success', false, 'error', upper(v_outcome), 'reason', v_outcome);
        END IF;
        PERFORM pg_sleep(0.02 * v_attempt + random() * 0.03);
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.expire_negotiation_offer(p_offer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_attempt integer := 0;
  v_max_attempts constant integer := 3;
  v_outcome text;
BEGIN
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      RETURN public.expire_negotiation_offer_core(p_offer_id);
    EXCEPTION
      WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN
        IF v_attempt >= v_max_attempts THEN
          v_outcome := public.negotiation_contention_outcome(p_offer_id, 'expire_negotiation_offer');
          RETURN jsonb_build_object('success', false, 'error', upper(v_outcome), 'reason', v_outcome);
        END IF;
        PERFORM pg_sleep(0.02 * v_attempt + random() * 0.03);
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.decline_ride_offer(
  p_offer_id uuid,
  p_driver_id uuid,
  p_reason text DEFAULT 'declined'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_attempt integer := 0;
  v_max_attempts constant integer := 3;
  v_outcome text;
BEGIN
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      RETURN public.decline_ride_offer_core(p_offer_id, p_driver_id, p_reason);
    EXCEPTION
      WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN
        IF v_attempt >= v_max_attempts THEN
          v_outcome := public.negotiation_contention_outcome(p_offer_id, 'decline_ride_offer');
          RETURN jsonb_build_object('success', false, 'error', upper(v_outcome),
            'message', 'Offer is being resolved by another action', 'reason', v_outcome);
        END IF;
        PERFORM pg_sleep(0.02 * v_attempt + random() * 0.03);
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_customer_decline_grace(
  p_offer_id uuid,
  p_reason text DEFAULT 'decline'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_attempt integer := 0;
  v_max_attempts constant integer := 3;
  v_outcome text;
BEGIN
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      RETURN public.apply_customer_decline_grace_core(p_offer_id, p_reason);
    EXCEPTION
      WHEN deadlock_detected OR serialization_failure OR lock_not_available THEN
        IF v_attempt >= v_max_attempts THEN
          v_outcome := public.negotiation_contention_outcome(p_offer_id, 'apply_customer_decline_grace');
          RETURN jsonb_build_object('success', false, 'error', upper(v_outcome), 'reason', v_outcome);
        END IF;
        PERFORM pg_sleep(0.02 * v_attempt + random() * 0.03);
    END;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.customer_counter_ride_offer(uuid, integer, uuid, uuid) IS
  'Customer counter-offer (wrapper). Body: customer_counter_ride_offer_core (trip FOR UPDATE -> offer FOR UPDATE). Retries deadlock/serialization up to 3x, then raises a domain error (never raw 40P01).';
COMMENT ON FUNCTION public.driver_send_preset_offer(uuid, integer, integer[], integer) IS
  'Driver preset offer (wrapper). Body: driver_send_preset_offer_core (trip-first lock). Bounded retry + domain error.';
COMMENT ON FUNCTION public.driver_cancel_negotiation(uuid, uuid) IS
  'Driver cancels negotiation (wrapper). Body: driver_cancel_negotiation_core (trip-first lock). Bounded retry + domain outcome.';
COMMENT ON FUNCTION public.expire_negotiation_offer(uuid) IS
  'Expire negotiation offer (wrapper). Body: expire_negotiation_offer_core (trip-first lock). Bounded retry + domain outcome.';
COMMENT ON FUNCTION public.decline_ride_offer(uuid, uuid, text) IS
  'Driver decline (wrapper). Body: decline_ride_offer_core (trip-first lock). Bounded retry + domain outcome.';
COMMENT ON FUNCTION public.apply_customer_decline_grace(uuid, text) IS
  'Customer decline grace (wrapper). Body: apply_customer_decline_grace_core (trip-first lock). Bounded retry + domain outcome.';

COMMIT;
