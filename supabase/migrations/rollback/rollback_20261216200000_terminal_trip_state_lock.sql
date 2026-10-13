-- Rollback for 20261216200000_terminal_trip_state_lock.sql
-- Restores the production definitions captured on 2026-10-13 before the lock.

BEGIN;

DROP TRIGGER IF EXISTS zz_enforce_trip_terminal_state_lock ON public.trips;
DROP FUNCTION IF EXISTS public.enforce_trip_terminal_state_lock();
DROP FUNCTION IF EXISTS public.trip_terminal_transition_violation(text, text, timestamptz, timestamptz, text, text);
DROP FUNCTION IF EXISTS public.trip_terminal_state_override_reason();

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
    special_instructions = CASE
      WHEN v_reason IS NOT NULL AND lower(p_cancelled_by) = 'admin' THEN 'Cancelled by admin: ' || v_reason
      WHEN lower(p_cancelled_by) = 'admin' THEN 'Cancelled by admin'
      ELSE special_instructions
    END,
    updated_at = v_now
  WHERE id = p_trip_id;

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
BEGIN
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
    updated_at = v_now
  WHERE id = p_trip_id;

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
