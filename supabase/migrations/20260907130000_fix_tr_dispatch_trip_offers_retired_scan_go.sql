-- P0: create-trip-after-payment trip insert fails after scan_go column drop.
--
-- Live evidence (2026-07-30 Samsung booking / Revolut AUTHORISED hold):
--   admin_payment_audit action=hold_orphan_detected
--   terminal_reason = 'Trip insert failed: record "new" has no field "scan_go"'
--   client_action_id = 6a0e8674-f592-464c-9601-5df129800b02
--   provider_order_id = 6a6bbf6d-0995-abf0-9d6d-2bda034dfc14
--
-- Root cause: migration 20260903121500 dropped public.trips.scan_go (and
-- locked_driver_id), but several dispatch helpers still referenced those fields.
-- public.tr_dispatch_trip_offers() (AFTER INSERT trigger
-- tr_trips_dispatch_after_insert) evaluating COALESCE(NEW.scan_go, false)
-- aborts every searching/pending trip insert — including Revolut
-- create-trip-after-payment after a successful hold.
--
-- This migration:
--   1) Rewrites tr_dispatch_trip_offers without Scan & Go
--   2) Strips remaining scan_go / locked_driver_id references from:
--        expire_offers_sweep_has_work
--        expire_trip_when_search_exhausted
--        finalize_negotiation_failure
--        maybe_advance_dispatch_after_offer_resolution
--        sweep_stale_searching_trips
--
-- Deploy required: apply to live (db query / migrate). JS reload alone cannot
-- fix. Edge redeploy alone cannot fix (failure is DB trigger, not Edge code).

-- ---------------------------------------------------------------------------
-- 1) AFTER INSERT dispatch trigger — unblock CTAP trip insert
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tr_dispatch_trip_offers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Scan and Go retired (column dropped). Do not reference the retired flag.

  -- Corporate immediate booking: uses the same dispatcher directly.
  IF NEW.corporate_account_id IS NOT NULL
     AND COALESCE(NEW.is_scheduled, false) = false
     AND NEW.driver_id IS NULL
     AND NEW.status IN ('pending','searching') THEN
    BEGIN
      PERFORM public.dispatch_trip_offers(NEW.id, true);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[tr_dispatch_trip_offers] corporate dispatch failed for trip %: % (%)',
        NEW.id, SQLERRM, SQLSTATE;
    END;
    RETURN NEW;
  END IF;

  -- Regular customer trips (digital/paid, non-scheduled): dispatch inline
  -- so the driver receives the offer immediately instead of waiting for the
  -- 3-second sweep. Scheduled trips are intentionally skipped — they belong
  -- to schedule-dispatch (urgent-lead-time trigger).
  IF NEW.driver_id IS NULL
     AND COALESCE(NEW.is_scheduled, false) = false
     AND NEW.status IN ('pending','searching') THEN
    BEGIN
      PERFORM public.dispatch_trip_offers(NEW.id, true);
    EXCEPTION WHEN OTHERS THEN
      -- Never block the booking; the 3s sweep will retry.
      RAISE WARNING '[tr_dispatch_trip_offers] inline dispatch failed for trip %: % (%)',
        NEW.id, SQLERRM, SQLSTATE;
    END;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.tr_dispatch_trip_offers() IS
  'AFTER INSERT on trips — inline/corporate SQL dispatch. Scan & Go branch removed after trips.scan_go drop (fixes CTAP trip insert).';

-- ---------------------------------------------------------------------------
-- 2) expire_offers_sweep_has_work — drop scan_go predicates
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_offers_sweep_has_work()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    EXISTS (
      SELECT 1
      FROM public.ride_offers ro
      WHERE ro.status = 'pending'
        AND ro.negotiation_status IS NULL
        AND ro.expires_at IS NOT NULL
        AND ro.expires_at <= now()
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM public.ride_offers ro
      WHERE ro.negotiation_status = 'waiting_customer'
        AND (
          (ro.negotiation_expires_at IS NOT NULL AND ro.negotiation_expires_at <= now())
          OR (
            ro.negotiation_expires_at IS NULL
            AND ro.customer_respond_by IS NOT NULL
            AND ro.customer_respond_by <= now()
          )
        )
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM public.ride_offers ro
      WHERE ro.negotiation_status = 'waiting_driver_final'
        AND (
          (ro.negotiation_expires_at IS NOT NULL AND ro.negotiation_expires_at <= now())
          OR (
            ro.negotiation_expires_at IS NULL
            AND ro.driver_respond_by IS NOT NULL
            AND ro.driver_respond_by <= now()
          )
        )
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM public.ride_offers ro
      WHERE ro.negotiation_status = 'declined_customer_awaiting_driver'
        AND (
          (ro.negotiation_expires_at IS NOT NULL AND ro.negotiation_expires_at <= now())
          OR (
            ro.grace_window_expires_at IS NOT NULL
            AND ro.grace_window_expires_at <= now()
          )
        )
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM public.trips t
      WHERE t.driver_id IS NULL
        AND t.confirmed_driver_id IS NULL
        AND COALESCE(t.broadcast_enabled, true) = true
        AND t.status IN (
          'pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver'
        )
        AND COALESCE(t.dispatch_status, '') NOT IN ('expired', 'cancelled')
        AND (
          (t.searching_expires_at IS NOT NULL AND t.searching_expires_at <= now())
          OR (
            t.searching_expires_at IS NULL
            AND t.created_at <= now() - make_interval(mins => public.dispatch_max_driver_find_minutes(t.service_area_id))
          )
        )
      LIMIT 1
    )
    OR EXISTS (
      SELECT 1
      FROM public.trips t
      WHERE COALESCE(t.broadcast_enabled, true) = true
        AND t.status IN (
          'pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver'
        )
        AND COALESCE(t.dispatch_status, '') NOT IN ('expired', 'cancelled', 'assigned')
        AND NOT EXISTS (
          SELECT 1
          FROM public.ride_offers ro
          WHERE ro.trip_id = t.id
            AND ro.status = 'pending'
        )
      LIMIT 1
    );
$function$;

COMMENT ON FUNCTION public.expire_offers_sweep_has_work() IS
  'Cheap predicate for expire-offers cron. Scan & Go trip filters removed after trips.scan_go drop.';

-- ---------------------------------------------------------------------------
-- 3) expire_trip_when_search_exhausted — drop scan_go early-return
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_trip_when_search_exhausted(p_trip_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_settings public.dispatch_settings;
  v_now timestamptz := now();
  v_search_deadline timestamptz;
  v_find_minutes integer;
  v_live_offer_count int := 0;
  v_round int := 0;
  v_max_rounds int := 3;
BEGIN
  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_trip.driver_id IS NOT NULL OR v_trip.confirmed_driver_id IS NOT NULL THEN
    RETURN false;
  END IF;

  IF v_trip.status IN (
      'completed', 'cancelled', 'customer_cancelled', 'expired', 'expired_no_driver'
    )
    OR v_trip.dispatch_status IN ('expired', 'cancelled')
    OR v_trip.scheduled_status IN ('cancelled', 'expired', 'no_driver_found') THEN
    RETURN true;
  END IF;

  -- Scan & Go retired; only skip when broadcast is explicitly disabled.
  IF COALESCE(v_trip.broadcast_enabled, true) = false THEN
    RETURN false;
  END IF;

  v_settings := public.get_dispatch_settings(v_trip.service_area_id);
  v_find_minutes := COALESCE(
    v_settings.max_driver_find_time_minutes,
    v_settings.global_timeout_minutes,
    3
  );

  v_search_deadline := COALESCE(
    v_trip.searching_expires_at,
    v_trip.created_at + make_interval(mins => v_find_minutes),
    v_now + make_interval(mins => v_find_minutes)
  );

  -- Search window elapsed: terminal immediately (do not wait for remaining broadcast rounds).
  IF v_search_deadline <= v_now THEN
    UPDATE public.ride_offers
    SET
      status = 'revoked',
      revoked_reason = 'trip_expired_no_driver',
      updated_at = v_now
    WHERE trip_id = p_trip_id
      AND status IN ('pending', 'countered');

    UPDATE public.trips
    SET
      status = 'expired',
      dispatch_status = 'expired',
      scheduled_status = CASE
        WHEN v_trip.scheduled_status IS NOT NULL
          OR v_trip.dispatch_mode = 'scheduled'
          OR COALESCE(v_trip.is_scheduled, false) = true
        THEN 'no_driver_found'
        ELSE scheduled_status
      END,
      broadcast_enabled = false,
      updated_at = v_now
    WHERE id = p_trip_id
      AND status NOT IN (
        'completed', 'cancelled', 'customer_cancelled', 'expired', 'expired_no_driver'
      );

    RETURN true;
  END IF;

  SELECT COUNT(*)::int INTO v_live_offer_count
  FROM public.ride_offers ro
  WHERE ro.trip_id = p_trip_id
    AND ro.status IN ('pending', 'countered', 'accepted')
    AND (ro.expires_at IS NULL OR ro.expires_at > v_now);

  v_round := COALESCE(v_trip.current_broadcast_round, 0);
  v_max_rounds := public.dispatch_max_broadcast_rounds(v_settings, v_trip.max_broadcast_rounds);

  IF v_live_offer_count > 0 THEN
    UPDATE public.trips
    SET
      status = 'offered',
      dispatch_status = 'broadcasting',
      searching_expires_at = COALESCE(searching_expires_at, v_search_deadline),
      updated_at = v_now
    WHERE id = p_trip_id
      AND status IN ('pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver');
    RETURN false;
  END IF;

  IF v_round < v_max_rounds THEN
    UPDATE public.trips
    SET
      status = 'searching',
      dispatch_status = 'broadcasting',
      searching_expires_at = COALESCE(searching_expires_at, v_search_deadline),
      updated_at = v_now
    WHERE id = p_trip_id
      AND status IN ('pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver');
    RETURN false;
  END IF;

  UPDATE public.trips
  SET
    status = 'searching',
    dispatch_status = 'broadcasting',
    searching_expires_at = COALESCE(searching_expires_at, v_search_deadline),
    updated_at = v_now
  WHERE id = p_trip_id
    AND status IN ('pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver');

  RETURN false;
END;
$function$;

COMMENT ON FUNCTION public.expire_trip_when_search_exhausted(uuid) IS
  'Expire searching trip when find window elapsed. Scan & Go early-return removed after trips.scan_go drop.';

-- ---------------------------------------------------------------------------
-- 4) finalize_negotiation_failure — drop scan_go / locked_driver_id writes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_negotiation_failure(p_trip_id uuid, p_failed_driver_id uuid, p_offer_id uuid DEFAULT NULL::uuid, p_offer_terminal_status text DEFAULT 'expired'::text, p_offer_negotiation_status text DEFAULT 'failed'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_now timestamptz := now();
  v_excluded uuid[];
  v_searching_expires timestamptz;
  v_exclusion_reason text;
  v_resolved jsonb;
  v_official_fare_pence integer;
  v_counter_binding boolean;
  v_fare_source text;
  v_commit jsonb;
  v_find_minutes integer;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  IF v_trip.driver_id IS NOT NULL
     AND v_trip.status IN ('accepted', 'confirmed', 'driver_assigned', 'arrived_pickup', 'arrived', 'in_progress', 'completed') THEN
    RETURN jsonb_build_object('success', true, 'trip_id', p_trip_id, 'skipped', true, 'reason', 'already_assigned');
  END IF;

  v_resolved := public.resolve_negotiation_rebroadcast_fare(p_trip_id);
  v_official_fare_pence := COALESCE((v_resolved->>'fare_pence')::integer, 0);
  v_counter_binding := COALESCE((v_resolved->>'counter_binding')::boolean, false);
  v_fare_source := COALESCE(v_resolved->>'fare_source', 'original_fare');

  v_excluded := COALESCE(v_trip.excluded_driver_ids, '{}'::uuid[]);
  IF p_failed_driver_id IS NOT NULL AND NOT (p_failed_driver_id = ANY (v_excluded)) THEN
    v_excluded := array_append(v_excluded, p_failed_driver_id);
  END IF;

  v_exclusion_reason := CASE
    WHEN p_offer_negotiation_status IN ('declined_driver', 'failed') AND p_offer_terminal_status = 'declined'
      THEN 'declined_negotiation'
    WHEN p_offer_negotiation_status IN ('timeout_driver', 'timeout_driver_final')
      THEN 'timeout_negotiation'
    WHEN p_offer_terminal_status = 'revoked' THEN 'cancelled_negotiation'
    ELSE 'negotiation_failed'
  END;

  IF p_failed_driver_id IS NOT NULL THEN
    INSERT INTO public.trip_driver_exclusions (trip_id, driver_id, reason, offer_id)
    VALUES (p_trip_id, p_failed_driver_id, v_exclusion_reason, p_offer_id)
    ON CONFLICT (trip_id, driver_id) DO UPDATE SET
      reason = EXCLUDED.reason,
      offer_id = COALESCE(EXCLUDED.offer_id, public.trip_driver_exclusions.offer_id);
  END IF;

  v_find_minutes := public.dispatch_max_driver_find_minutes(v_trip.service_area_id);
  v_searching_expires := COALESCE(
    v_trip.searching_expires_at,
    v_now + make_interval(mins => v_find_minutes)
  );
  IF v_trip.searching_expires_at IS NOT NULL AND v_trip.searching_expires_at < v_now THEN
    v_searching_expires := v_now + make_interval(mins => v_find_minutes);
  END IF;

  IF p_offer_id IS NOT NULL THEN
    UPDATE public.ride_offers
    SET
      status = p_offer_terminal_status,
      negotiation_status = p_offer_negotiation_status,
      decline_reason = CASE WHEN p_offer_terminal_status = 'declined' THEN v_exclusion_reason ELSE decline_reason END,
      driver_offer_fare = NULL,
      customer_counter_fare = NULL,
      customer_respond_by = NULL,
      driver_respond_by = NULL,
      grace_window_expires_at = NULL,
      negotiation_expires_at = NULL,
      responded_at = COALESCE(responded_at, v_now),
      updated_at = v_now
    WHERE id = p_offer_id;
  END IF;

  UPDATE public.ride_offers
  SET
    status = CASE WHEN status IN ('accepted') THEN status ELSE 'expired' END,
    negotiation_status = CASE WHEN status IN ('accepted') THEN negotiation_status ELSE 'failed' END,
    driver_offer_fare = NULL,
    customer_counter_fare = NULL,
    customer_respond_by = NULL,
    driver_respond_by = NULL,
    grace_window_expires_at = NULL,
    negotiation_expires_at = NULL,
    updated_at = v_now
  WHERE trip_id = p_trip_id
    AND status IN ('pending', 'countered')
    AND (p_offer_id IS NULL OR id IS DISTINCT FROM p_offer_id);

  IF COALESCE(v_official_fare_pence, 0) > 0 THEN
    v_commit := public.commit_negotiation_fare(
      p_trip_id,
      v_official_fare_pence,
      v_fare_source,
      p_offer_id,
      NULL
    );
    IF COALESCE(v_commit->>'success', 'false') <> 'true' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'FARE_COMMIT_FAILED',
        'trip_id', p_trip_id,
        'commit', v_commit
      );
    END IF;
  END IF;

  -- Scan & Go retired: always re-enable broadcast; locked_driver_id column dropped.
  UPDATE public.trips
  SET
    status = 'searching_new_driver',
    dispatch_status = 'broadcasting',
    driver_id = NULL,
    confirmed_driver_id = NULL,
    current_offer_driver_id = NULL,
    negotiation_owner_driver_id = NULL,
    negotiation_locked_until = NULL,
    negotiation_disabled = true,
    negotiation_allowed = false,
    negotiation_status = 'failed',
    current_negotiation_id = NULL,
    excluded_driver_ids = v_excluded,
    searching_expires_at = v_searching_expires,
    broadcast_enabled = true,
    updated_at = v_now
  WHERE id = p_trip_id;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', p_trip_id,
    'excluded_driver_ids', v_excluded,
    'excluded_driver_id', p_failed_driver_id,
    'exclusion_reason', v_exclusion_reason,
    'negotiation_disabled', true,
    'negotiation_allowed', false,
    'official_fare_pence', v_official_fare_pence,
    'counter_binding', v_counter_binding,
    'fare_source', v_fare_source,
    'fare_commit', v_commit
  );
END;
$function$;

COMMENT ON FUNCTION public.finalize_negotiation_failure(uuid, uuid, uuid, text, text) IS
  'Finalize failed negotiation and rebroadcast. Scan & Go / locked_driver_id writes removed after column drop.';

-- ---------------------------------------------------------------------------
-- 5) maybe_advance_dispatch_after_offer_resolution — drop scan_go early-return
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.maybe_advance_dispatch_after_offer_resolution(p_trip_id uuid, p_resolved_driver_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_settings public.dispatch_settings;
  v_now timestamptz := now();
  v_cancelled uuid[];
  v_excluded uuid[];
  v_pending_count int;
  v_round int;
  v_max_rounds int;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF v_trip.driver_id IS NOT NULL OR v_trip.confirmed_driver_id IS NOT NULL THEN
    RETURN;
  END IF;

  -- Scan & Go retired; only skip when broadcast is explicitly disabled.
  IF COALESCE(v_trip.broadcast_enabled, true) = false THEN
    RETURN;
  END IF;

  IF v_trip.status IN ('completed', 'cancelled', 'declined') THEN
    RETURN;
  END IF;

  IF v_trip.negotiation_owner_driver_id IS NOT NULL AND v_trip.status = 'negotiating' THEN
    RETURN;
  END IF;

  v_cancelled := COALESCE(v_trip.cancelled_driver_ids, '{}'::uuid[]);
  v_excluded := COALESCE(v_trip.excluded_driver_ids, '{}'::uuid[]);

  IF p_resolved_driver_id IS NOT NULL THEN
    IF NOT (p_resolved_driver_id = ANY (v_cancelled)) THEN
      v_cancelled := array_append(v_cancelled, p_resolved_driver_id);
    END IF;
    IF NOT (p_resolved_driver_id = ANY (v_excluded)) THEN
      v_excluded := array_append(v_excluded, p_resolved_driver_id);
    END IF;

    UPDATE public.trips
    SET
      cancelled_driver_ids = v_cancelled,
      excluded_driver_ids = v_excluded,
      updated_at = v_now
    WHERE id = p_trip_id;
  END IF;

  SELECT count(*)::int INTO v_pending_count
  FROM public.ride_offers ro
  WHERE ro.trip_id = p_trip_id
    AND ro.status IN ('pending', 'countered')
    AND (
      ro.negotiation_status IN ('waiting_customer', 'waiting_driver', 'waiting_driver_final')
      OR ro.expires_at IS NULL
      OR ro.expires_at > v_now
    );

  IF v_pending_count > 0 THEN
    UPDATE public.trips
    SET
      status = 'offered',
      dispatch_status = 'broadcasting',
      driver_id = NULL,
      confirmed_driver_id = NULL,
      negotiation_owner_driver_id = NULL,
      negotiation_locked_until = NULL,
      updated_at = v_now
    WHERE id = p_trip_id
      AND status IN (
        'pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver'
      );
    RETURN;
  END IF;

  v_settings := public.get_dispatch_settings(v_trip.service_area_id);
  v_round := COALESCE(v_trip.current_broadcast_round, 0);
  v_max_rounds := public.dispatch_max_broadcast_rounds(v_settings, v_trip.max_broadcast_rounds);

  IF v_round >= v_max_rounds THEN
    PERFORM public.expire_trip_when_search_exhausted(p_trip_id);
    RETURN;
  END IF;

  -- Phase 5: no PERFORM dispatch_trip_offers — expire-offers cron invokes auto-dispatch edge.
  UPDATE public.trips
  SET
    status = 'searching',
    dispatch_status = 'broadcasting',
    updated_at = v_now
  WHERE id = p_trip_id
    AND status IN (
      'pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver'
    );
END;
$function$;

COMMENT ON FUNCTION public.maybe_advance_dispatch_after_offer_resolution(uuid, uuid) IS
  'Advance dispatch after offer resolution. Scan & Go early-return removed after trips.scan_go drop.';

-- ---------------------------------------------------------------------------
-- 6) sweep_stale_searching_trips — drop scan_go predicate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sweep_stale_searching_trips()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip record;
  v_expired_count int := 0;
  v_expired_ids uuid[] := '{}';
  v_now timestamptz := now();
BEGIN
  FOR v_trip IN
    SELECT t.id, t.trip_code, t.status, t.searching_expires_at, t.created_at, t.service_area_id
    FROM public.trips t
    WHERE t.driver_id IS NULL
      AND t.confirmed_driver_id IS NULL
      AND COALESCE(t.broadcast_enabled, true) = true
      AND t.status IN (
        'pending', 'searching', 'offered', 'offering', 'broadcasting', 'searching_new_driver'
      )
      AND t.dispatch_status NOT IN ('expired', 'cancelled')
      AND (
        (t.searching_expires_at IS NOT NULL AND t.searching_expires_at <= v_now)
        OR (
          t.searching_expires_at IS NULL
          AND t.created_at <= v_now - make_interval(mins => public.dispatch_max_driver_find_minutes(t.service_area_id))
        )
      )
    FOR UPDATE OF t SKIP LOCKED
  LOOP
    IF public.expire_trip_when_search_exhausted(v_trip.id) THEN
      v_expired_count := v_expired_count + 1;
      v_expired_ids := array_append(v_expired_ids, v_trip.id);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'expired_count', v_expired_count,
    'expired_trip_ids', to_jsonb(v_expired_ids)
  );
END;
$function$;

COMMENT ON FUNCTION public.sweep_stale_searching_trips() IS
  'Sweep stale searching trips past find window. Scan & Go trip filter removed after trips.scan_go drop.';
