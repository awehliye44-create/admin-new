-- Trip-terminal offer fan-out: notify only drivers whose offer was still live,
-- and never with cancellation-flavoured data.
--
-- Defect: notify_offer_drivers_on_trip_terminal pushed RIDE_STOP with
-- stopReason=customer_cancelled and trip_status=cancelled to EVERY driver who
-- ever held an offer on the trip (declined, expired, previously revoked). The
-- Driver app classifies that as a trip cancellation, so a driver who had
-- declined the booking saw the Trip Cancelled banner/audio for a trip that was
-- never theirs (trip ccf3c09f…, MK0006 declined 19:11:20, cancel push 19:11:46).
--
-- Rule: only the driver who had the trip receives a cancellation
-- (notify_driver_on_trip_cancelled / cancel-trip → notifyDriverTripStopped).
-- Drivers whose offer was still pending/countered at trip terminal receive a
-- silent offer revoke so the ringing card clears. Declined/expired/revoked
-- offer holders receive nothing (decline-offer / expire-offers already stopped
-- their card).

CREATE OR REPLACE FUNCTION public.notify_offer_drivers_on_trip_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $body$
DECLARE
  v_terminal text[] := ARRAY['cancelled', 'canceled', 'expired', 'declined', 'no_show', 'no-show'];
  v_stop_reason text;
  v_offer_stop_reason text;
  v_push_body text;
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.send_driver_notification_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/send-driver-notification'
  );
  v_url_ok boolean;
  v_assigned_driver_id uuid;
  v_row record;
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (NEW.status = ANY (v_terminal)) OR OLD.status = ANY (v_terminal) THEN
    RETURN NEW;
  END IF;

  v_stop_reason := public.canonical_trip_terminal_stop_reason(
    NEW.status,
    NEW.cancelled_by,
    NEW.cancel_reason
  );

  -- A live offer holder never had the trip: revoke, never "customer cancelled".
  v_offer_stop_reason := CASE
    WHEN v_stop_reason = 'customer_cancelled' THEN 'revoked'
    ELSE v_stop_reason
  END;

  v_push_body := CASE v_offer_stop_reason
    WHEN 'offer_expired' THEN 'This offer timed out'
    WHEN 'reassigned' THEN 'This ride was reassigned'
    ELSE 'This ride is no longer available'
  END;

  v_assigned_driver_id := COALESCE(
    NEW.driver_id, NEW.confirmed_driver_id, OLD.driver_id, OLD.confirmed_driver_id
  );
  v_url_ok := v_url IS NOT NULL AND length(trim(v_url)) >= 20;

  FOR v_row IN
    UPDATE public.ride_offers ro
    SET
      status = 'revoked',
      revoked_reason = CASE
        WHEN NEW.status = 'expired' THEN 'trip_expired'
        WHEN NEW.status IN ('cancelled', 'canceled') THEN coalesce(nullif(trim(NEW.cancel_reason), ''), 'trip_cancelled')
        ELSE coalesce(ro.revoked_reason, 'trip_terminal')
      END,
      updated_at = now()
    WHERE ro.trip_id = NEW.id
      AND ro.status IN ('pending', 'countered')
    RETURNING ro.id AS offer_id, ro.driver_id
  LOOP
    CONTINUE WHEN NOT v_url_ok
      OR v_row.driver_id IS NULL
      OR v_row.driver_id IS NOT DISTINCT FROM v_assigned_driver_id;

    BEGIN
      PERFORM net.http_post(
        url := v_url,
        headers := public.onecab_internal_notification_http_headers(),
        body := jsonb_build_object(
          'driverId', v_row.driver_id::text,
          'type', 'RIDE_STOP',
          'title', 'Ride no longer available',
          'body', v_push_body,
          'data', jsonb_build_object(
            'type', 'RIDE_STOP',
            'event', 'trip_terminal',
            'stopReason', v_offer_stop_reason,
            'stop_reason', v_offer_stop_reason,
            'offer_status', 'revoked',
            'trip_id', NEW.id::text,
            'tripId', NEW.id::text,
            'booking_id', NEW.id::text,
            'bookingId', NEW.id::text,
            'offer_id', v_row.offer_id::text,
            'offerId', v_row.offer_id::text
          )
        )
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG '[notify_offer_drivers_on_trip_terminal] RIDE_STOP failed trip=% driver=%: %',
        NEW.id, v_row.driver_id, SQLERRM;
    END;
  END LOOP;

  RETURN NEW;
END;
$body$;
