-- After booking_received_miss / ack_timeout clears the current offer pointer,
-- re-enter auto-dispatch so trips do not sit in broadcasting with zero pending offers.
CREATE OR REPLACE FUNCTION public.process_ride_offer_ack_timeouts()
 RETURNS TABLE(offer_id uuid, trip_id uuid, driver_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD;
  v_offer_id uuid;
  v_trip_id uuid;
  v_driver_id uuid;
  v_now timestamptz := now();
  v_url text := 'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/auto-dispatch';
  v_token text := public.cron_edge_auth_token();
BEGIN
  FOR r IN
    SELECT ro.id AS oid, ro.trip_id AS tid, ro.driver_id AS did
    FROM public.ride_offers ro
    WHERE ro.status = 'pending'
      AND ro.ack_at IS NULL
      AND COALESCE(ro.delivery_first_dispatched_at, ro.offered_at) <= v_now - INTERVAL '20 seconds'
    ORDER BY COALESCE(ro.delivery_first_dispatched_at, ro.offered_at) ASC
    LIMIT 120
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.ride_offers o
    SET
      status = 'expired',
      delivery_phase = 'ack_timeout',
      responded_at = v_now,
      delivery_trace = COALESCE(delivery_trace, '{}'::jsonb) || jsonb_build_object(
        'ack_timeout_at', v_now,
        'reassigned_at', v_now,
        'reassigned_reason', 'booking_received_miss'
      ),
      updated_at = v_now
    WHERE o.id = r.oid
      AND o.status = 'pending'
      AND o.ack_at IS NULL
    RETURNING o.id, o.trip_id, o.driver_id INTO v_offer_id, v_trip_id, v_driver_id;

    IF NOT FOUND THEN
      RAISE LOG '[booking_delivery] ack_timeout_skip offer_id=% booking_id=% reason=no_row_updated_concurrent_booking_received_or_terminal',
        r.oid, r.tid;
      CONTINUE;
    END IF;

    RAISE LOG '[delivery] ack_timeout_sweep booking_id=% offer_id=% driver_id=% timeout_at=% reassigned_at=% phase=offer_expired',
      v_trip_id, v_offer_id, v_driver_id, v_now, v_now;

    PERFORM public.record_booking_delivery(
      v_trip_id,
      'ack_timeout',
      v_driver_id,
      v_offer_id,
      'postgres',
      jsonb_build_object('timeout_at', v_now)
    );

    UPDATE public.trips t
    SET
      current_offer_driver_id = CASE WHEN t.current_offer_driver_id = v_driver_id THEN NULL ELSE t.current_offer_driver_id END,
      current_offer_expires_at = CASE WHEN t.current_offer_driver_id = v_driver_id THEN NULL ELSE t.current_offer_expires_at END,
      updated_at = v_now
    WHERE t.id = v_trip_id;

    RAISE LOG '[booking_delivery] reassigned booking_id=% offer_id=% prior_driver_id=% reassigned_at=% phase=trip_pointer_cleared',
      v_trip_id, v_offer_id, v_driver_id, v_now;

    PERFORM public.record_booking_delivery(
      v_trip_id,
      'reassigned',
      v_driver_id,
      v_offer_id,
      'postgres',
      jsonb_strip_nulls(jsonb_build_object(
        'note', 'trip_pointer_cleared',
        'prior_driver_id', v_driver_id,
        'reassigned_at', v_now
      ))
    );

    BEGIN
      PERFORM net.http_post(
        url := v_url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_token,
          'apikey', v_token
        ),
        body := jsonb_build_object(
          'trip_id', v_trip_id,
          'force_rebroadcast', true,
          'source', 'ack_timeout_reassign'
        ),
        timeout_milliseconds := 8000
      );
      RAISE LOG '[booking_delivery] ack_timeout_redispatch_enqueued booking_id=% offer_id=%',
        v_trip_id, v_offer_id;
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG '[booking_delivery] ack_timeout_redispatch_failed booking_id=% sqlerrm=%',
        v_trip_id, SQLERRM;
    END;

    offer_id := v_offer_id;
    trip_id := v_trip_id;
    driver_id := v_driver_id;
    RETURN NEXT;
  END LOOP;
  RETURN;
END;
$function$;
