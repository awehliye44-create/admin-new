-- HISTORY PARITY ONLY. Already applied on linked production.
-- Restored so local migration list matches remote. Do not re-apply via db push.
-- Terminal trip state lock (security release P1).
--
-- 1. A completed trip can never leave 'completed' and completed_at can never be
--    cleared (MK-260923-017: Admin cancel moved a captured, completed trip to
--    cancelled).
-- 2. A cancelled / expired / no-show trip can never be reopened, except the two
--    product flows in customer-resume-driver-search (both to 'searching_new_driver'):
--      - rematch after the driver cancelled before pickup,
--      - customer retry of an expired search.
--    (MK-260916-029/030 and MK-261003-003: dispatch writers resurrected
--    cancelled trips.)
-- 3. Approved historical reconciliation may bypass the lock only as service_role
--    or postgres, inside a transaction that sets
--    onecab.terminal_state_override = '<reason>'. Every bypass is written to
--    audit_logs as TERMINAL_STATE_OVERRIDE.
-- 4. apply_terminal_trip_cancellation and admin_cancel_trip_negotiation refuse
--    completed trips and terminalise scheduled_status like cancel-trip does.
--
-- Rollback: supabase/migrations/rollback/rollback_20261216200000_terminal_trip_state_lock.sql

BEGIN;

CREATE OR REPLACE FUNCTION public.trip_terminal_state_override_reason()
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(trim(COALESCE(current_setting('onecab.terminal_state_override', true), '')), '');
BEGIN
  IF v_reason IS NULL THEN
    RETURN NULL;
  END IF;
  IF current_user IN ('service_role', 'postgres', 'supabase_admin')
     OR session_user IN ('postgres', 'supabase_admin') THEN
    RETURN v_reason;
  END IF;
  RETURN NULL;
END;
$function$;

-- Invoked with caller rights from the trips trigger, so every role that may
-- update trips must keep EXECUTE. It only yields a reason for privileged roles.

CREATE OR REPLACE FUNCTION public.trip_terminal_transition_violation(
  p_old_status text,
  p_new_status text,
  p_old_completed_at timestamptz,
  p_new_completed_at timestamptz,
  p_old_cancelled_by text,
  p_old_cancel_reason text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_old text := lower(COALESCE(p_old_status, ''));
  v_new text := lower(COALESCE(p_new_status, ''));
BEGIN
  IF v_old = 'completed' AND v_new <> 'completed' THEN
    RETURN 'COMPLETED_TRIP_STATUS_CHANGE';
  END IF;
  IF p_old_completed_at IS NOT NULL AND p_new_completed_at IS NULL THEN
    RETURN 'COMPLETED_AT_CLEARED';
  END IF;
  IF NOT public.is_trip_terminal_cancel_status(v_old) OR public.is_trip_terminal_cancel_status(v_new) THEN
    RETURN NULL;
  END IF;
  IF v_new = 'searching_new_driver' AND p_old_completed_at IS NULL THEN
    IF v_old IN ('cancelled', 'canceled')
       AND (lower(COALESCE(p_old_cancelled_by, '')) = 'driver'
            OR lower(COALESCE(p_old_cancel_reason, '')) = 'driver_cancelled') THEN
      RETURN NULL;
    END IF;
    IF v_old IN ('expired', 'expired_no_driver') THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN 'TERMINAL_TRIP_REOPENED';
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_trip_terminal_state_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_violation text;
  v_override text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at THEN
    RETURN NEW;
  END IF;

  v_violation := public.trip_terminal_transition_violation(
    OLD.status, NEW.status, OLD.completed_at, NEW.completed_at, OLD.cancelled_by, OLD.cancel_reason
  );
  IF v_violation IS NULL THEN
    RETURN NEW;
  END IF;

  v_override := public.trip_terminal_state_override_reason();
  IF v_override IS NULL THEN
    RAISE EXCEPTION 'TERMINAL_STATE_LOCKED: % (trip %, % -> %)',
      v_violation, OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.audit_logs (event_type, trip_id, details)
  VALUES (
    'TERMINAL_STATE_OVERRIDE',
    OLD.id,
    jsonb_build_object(
      'violation', v_violation,
      'from_status', OLD.status,
      'to_status', NEW.status,
      'from_completed_at', OLD.completed_at,
      'to_completed_at', NEW.completed_at,
      'reason', v_override,
      'db_current_user', current_user,
      'db_session_user', session_user
    )
  );
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS zz_enforce_trip_terminal_state_lock ON public.trips;
-- Named to fire after every other BEFORE UPDATE trigger on trips (alphabetical
-- order) and not column-scoped, so it validates the row that will be written
-- even when an earlier trigger rewrites status or completed_at.
CREATE TRIGGER zz_enforce_trip_terminal_state_lock
  BEFORE UPDATE ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_trip_terminal_state_lock();

CREATE OR REPLACE FUNCTION public.apply_terminal_trip_cancellation(p_trip_id uuid, p_cancelled_by text DEFAULT 'admin'::text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_now timestamptz := now();
  v_reason text := NULLIF(trim(COALESCE(p_reason, '')), '');
  v_terminal_neg text;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  IF public.is_trip_terminal_cancel_status(v_trip.status) THEN
    RETURN jsonb_build_object('success', true, 'trip_id', p_trip_id, 'already_terminal', true);
  END IF;

  IF lower(COALESCE(v_trip.status, '')) = 'completed' OR v_trip.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'trip_id', p_trip_id, 'error', 'COMPLETED_TRIP_NOT_CANCELLABLE');
  END IF;

  v_terminal_neg := CASE
    WHEN lower(COALESCE(p_cancelled_by, '')) IN ('customer','passenger','rider') THEN 'cancelled_by_customer'
    WHEN lower(COALESCE(p_cancelled_by, '')) = 'driver' THEN 'cancelled_by_driver'
    ELSE 'cancelled_by_admin'
  END;

  -- NOTE: driver_id / confirmed_driver_id are intentionally PRESERVED.
  -- Driver RLS on trips is driver_id/confirmed_driver_id based; nulling them here
  -- hid the realtime cancellation event from the assigned driver's device, so the
  -- active trip card never cleared until a manual refresh.
  UPDATE public.trips
  SET
    status = CASE WHEN lower(COALESCE(p_cancelled_by, '')) IN ('customer','passenger','rider') THEN 'customer_cancelled' ELSE 'cancelled' END,
    cancelled_at = v_now,
    cancelled_by = p_cancelled_by,
    cancel_reason = COALESCE(v_reason, 'cancelled_by_' || COALESCE(p_cancelled_by, 'admin')),
    cancellation_reason = v_reason,
    negotiation_owner_driver_id = NULL,
    current_offer_driver_id = NULL,
    negotiation_locked_until = NULL,
    current_offer_expires_at = NULL,
    searching_expires_at = NULL,
    dispatch_status = 'cancelled',
    negotiation_status = v_terminal_neg,
    scheduled_status = CASE
      WHEN v_trip.is_scheduled IS TRUE OR v_trip.scheduled_at IS NOT NULL THEN 'cancelled'
      ELSE scheduled_status
    END,
    special_instructions = CASE
      WHEN v_reason IS NOT NULL AND lower(p_cancelled_by) = 'admin' THEN 'Cancelled by admin: ' || v_reason
      WHEN lower(p_cancelled_by) = 'admin' THEN 'Cancelled by admin'
      ELSE special_instructions
    END,
    updated_at = v_now
  WHERE id = p_trip_id
    AND completed_at IS NULL;

  IF v_trip.confirmed_driver_id IS NOT NULL OR v_trip.driver_id IS NOT NULL THEN
    UPDATE public.drivers SET current_trip_id = NULL, updated_at = v_now
    WHERE id IN (v_trip.confirmed_driver_id, v_trip.driver_id) AND current_trip_id = p_trip_id;
  END IF;

  IF v_trip.passenger_id IS NOT NULL THEN
    UPDATE public.customers SET active_trip_id = NULL, updated_at = v_now
    WHERE id = v_trip.passenger_id AND active_trip_id = p_trip_id;
  END IF;

  UPDATE public.ride_offers
  SET status = 'revoked',
      revoked_reason = 'trip_terminal_cancel',
      negotiation_status = v_terminal_neg,
      updated_at = v_now
  WHERE trip_id = p_trip_id AND status IN ('pending', 'countered', 'accepted');

  RETURN jsonb_build_object('success', true, 'trip_id', p_trip_id, 'cancelled_by', p_cancelled_by, 'negotiation_status', v_terminal_neg);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_cancel_trip_negotiation(p_trip_id uuid, p_reason text DEFAULT 'admin_cancelled'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
  v_trip public.trips%ROWTYPE;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'trip_id', p_trip_id, 'error', 'TRIP_NOT_FOUND');
  END IF;
  IF lower(COALESCE(v_trip.status, '')) = 'completed' OR v_trip.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'trip_id', p_trip_id, 'error', 'COMPLETED_TRIP_NOT_CANCELLABLE');
  END IF;
  IF public.is_trip_terminal_cancel_status(v_trip.status) THEN
    RETURN jsonb_build_object('success', true, 'trip_id', p_trip_id, 'already_terminal', true);
  END IF;

  UPDATE public.ride_offers
  SET
    status = 'revoked',
    revoked_reason = p_reason,
    negotiation_status = NULL,
    updated_at = v_now
  WHERE trip_id = p_trip_id
    AND status IN ('pending', 'countered');

  UPDATE public.trips
  SET
    status = 'cancelled',
    cancelled_by_role = 'admin',
    negotiation_owner_driver_id = NULL,
    negotiation_locked_until = NULL,
    current_offer_driver_id = NULL,
    dispatch_status = NULL,
    driver_id = NULL,
    confirmed_driver_id = NULL,
    scheduled_status = CASE
      WHEN v_trip.is_scheduled IS TRUE OR v_trip.scheduled_at IS NOT NULL THEN 'cancelled'
      ELSE scheduled_status
    END,
    updated_at = v_now
  WHERE id = p_trip_id
    AND completed_at IS NULL;

  UPDATE public.customers SET active_trip_id = NULL
  WHERE active_trip_id = p_trip_id;

  RETURN jsonb_build_object('success', true, 'trip_id', p_trip_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_terminal_trip_cancellation(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_terminal_trip_cancellation(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_cancel_trip_negotiation(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cancel_trip_negotiation(uuid, text) TO service_role;

COMMIT;
