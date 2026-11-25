-- #92J / MK-261125-005 — Terminal cancel must close open waiting clocks.
-- Admin cancel via apply_terminal_trip_cancellation left pickup segments open
-- (ended_at NULL) with accrued waiting still on the trip row. cancel-trip
-- already finalised via Edge; the RPC path (admin-trip-actions, scheduled
-- marketplace cancel) did not. Close segments inside the RPC so every
-- terminal cancel path is covered. NO_FEE_FULL_RELEASE disposition unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.apply_terminal_trip_cancellation(
  p_trip_id uuid,
  p_cancelled_by text DEFAULT 'admin'::text,
  p_reason text DEFAULT NULL::text
)
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
  v_close_at timestamptz;
  v_closed_segments int := 0;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  -- Always close open waiting clocks (including already_terminal replays).
  v_close_at := COALESCE(v_trip.cancelled_at, v_now);
  UPDATE public.trip_waiting_segments s
  SET ended_at = GREATEST(s.started_at, v_close_at)
  WHERE s.trip_id = p_trip_id
    AND s.ended_at IS NULL;
  GET DIAGNOSTICS v_closed_segments = ROW_COUNT;

  IF public.is_trip_terminal_cancel_status(v_trip.status) THEN
    RETURN jsonb_build_object(
      'success', true,
      'trip_id', p_trip_id,
      'already_terminal', true,
      'waiting_segments_closed', v_closed_segments
    );
  END IF;

  IF lower(COALESCE(v_trip.status, '')) = 'completed' OR v_trip.completed_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'trip_id', p_trip_id,
      'error', 'COMPLETED_TRIP_NOT_CANCELLABLE',
      'waiting_segments_closed', v_closed_segments
    );
  END IF;

  v_terminal_neg := CASE
    WHEN lower(COALESCE(p_cancelled_by, '')) IN ('customer','passenger','rider') THEN 'cancelled_by_customer'
    WHEN lower(COALESCE(p_cancelled_by, '')) = 'driver' THEN 'cancelled_by_driver'
    ELSE 'cancelled_by_admin'
  END;

  -- NOTE: driver_id / confirmed_driver_id are intentionally PRESERVED.
  UPDATE public.trips
  SET
    status = CASE
      WHEN lower(COALESCE(p_cancelled_by, '')) IN ('customer','passenger','rider')
        THEN 'customer_cancelled'
      ELSE 'cancelled'
    END,
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

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', p_trip_id,
    'cancelled_by', p_cancelled_by,
    'negotiation_status', v_terminal_neg,
    'waiting_segments_closed', v_closed_segments
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_terminal_trip_cancellation(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_terminal_trip_cancellation(uuid, text, text)
  TO service_role;

COMMIT;
