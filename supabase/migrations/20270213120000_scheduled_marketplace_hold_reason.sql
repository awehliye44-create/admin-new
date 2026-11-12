-- Phase 3 gap closure: authoritative scheduled marketplace hold reason +
-- database airport broadcast hold (cannot force broadcast_enabled=true while held).
-- DO NOT apply until Phase 3 production deployment approval.
-- Additive only — does not change Phase 1/2 financial or dispatch wave policy.

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS scheduled_hold_reason text;

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS scheduled_publish_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_scheduled_hold_reason_check;

ALTER TABLE public.trips
  ADD CONSTRAINT trips_scheduled_hold_reason_check
  CHECK (
    scheduled_hold_reason IS NULL
    OR scheduled_hold_reason = ANY (ARRAY[
      'publication_pending',
      'publication_retry',
      'airport_pricing',
      'payment_gate',
      'manual_trip',
      'admin_exceptional',
      'unknown_historical'
    ]::text[])
  );

COMMENT ON COLUMN public.trips.scheduled_hold_reason IS
  'Phase 3 authoritative hold: publication_pending|publication_retry|airport_pricing|payment_gate|manual_trip|admin_exceptional|unknown_historical. Auto-publish only pending/retry.';

COMMENT ON COLUMN public.trips.scheduled_publish_attempts IS
  'Bounded automatic marketplace publication retry counter (max 5).';

-- Fail-closed backfill: existing unpublished admin_held without reason → unknown_historical
UPDATE public.trips
SET scheduled_hold_reason = 'unknown_historical',
    updated_at = now()
WHERE dispatch_mode = 'scheduled'
  AND scheduled_status = 'admin_held'
  AND scheduled_broadcast_at IS NULL
  AND scheduled_hold_reason IS NULL
  AND driver_id IS NULL
  AND confirmed_driver_id IS NULL;

-- Prevent any path (Admin mutate, Edge bug, rematch) from clearing airport hold
-- by forcing broadcast_enabled=true while the hold is still active.
CREATE OR REPLACE FUNCTION public.trips_enforce_airport_broadcast_hold()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.broadcast_enabled IS FALSE
     AND NEW.broadcast_enabled IS DISTINCT FROM FALSE
  THEN
    -- Stay held until an authorised release clears scheduled_hold_reason away from
    -- airport_pricing AND leaves broadcast_enabled false→true only via explicit
    -- release helper (below). Default: refuse the reopen.
    IF COALESCE(NEW.scheduled_hold_reason, '') = 'airport_pricing'
       OR COALESCE(OLD.scheduled_hold_reason, '') = 'airport_pricing'
    THEN
      NEW.broadcast_enabled := FALSE;
      NEW.scheduled_hold_reason := 'airport_pricing';
    ELSIF current_setting('onecab.release_airport_broadcast_hold', true) = '1' THEN
      -- Explicit SECURITY DEFINER release path opted in for this transaction.
      NULL;
    ELSE
      NEW.broadcast_enabled := FALSE;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_trips_enforce_airport_broadcast_hold ON public.trips;
CREATE TRIGGER trg_trips_enforce_airport_broadcast_hold
  BEFORE UPDATE OF broadcast_enabled, scheduled_hold_reason
  ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trips_enforce_airport_broadcast_hold();

-- Authorised release after the EXISTING Custom Zones airport charge is persisted.
-- Does not calculate pricing. Does not require manual approval for normal bookings.
-- Refuse while airport_pricing hold remains and airport_charge_pence is still
-- missing/zero (genuine persist failure). Valid zero-charge routes never stamp
-- airport_pricing (see decideDispatchAfterFareEnrich airport_absent).
CREATE OR REPLACE FUNCTION public.release_scheduled_airport_broadcast_hold(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_hold text;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'TRIP_NOT_FOUND');
  END IF;

  v_hold := COALESCE(v_trip.scheduled_hold_reason, '');
  IF v_hold = 'airport_pricing'
     AND COALESCE(v_trip.airport_charge_pence, 0) <= 0
  THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'AIRPORT_PRICING_UNRESOLVED',
      'message', 'Existing mandatory airport charge has not been persisted yet'
    );
  END IF;

  PERFORM set_config('onecab.release_airport_broadcast_hold', '1', true);
  UPDATE public.trips
  SET broadcast_enabled = true,
      scheduled_hold_reason = CASE
        WHEN scheduled_hold_reason = 'airport_pricing'
             AND scheduled_status = 'admin_held'
          THEN 'publication_pending'
        WHEN scheduled_hold_reason = 'airport_pricing'
          THEN NULL
        ELSE scheduled_hold_reason
      END,
      updated_at = now()
  WHERE id = p_trip_id;

  RETURN jsonb_build_object('success', true, 'trip_id', p_trip_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.release_scheduled_airport_broadcast_hold(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_scheduled_airport_broadcast_hold(uuid) TO service_role;
