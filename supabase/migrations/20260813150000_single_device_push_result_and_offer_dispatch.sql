-- Close single-device gaps:
-- 1) record_push_send_result must never reactivate a replaced/inactive token
-- 2) ride_offer_dispatch_push_delivery token presence must use authoritative device

CREATE OR REPLACE FUNCTION public.record_push_send_result(
  p_token text,
  p_success boolean,
  p_error_code text DEFAULT NULL::text,
  p_error_classification text DEFAULT NULL::text,
  p_detail jsonb DEFAULT '{}'::jsonb
)
RETURNS push_tokens
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.push_tokens;
  v_should_deactivate BOOLEAN;
BEGIN
  IF p_token IS NULL OR length(p_token) = 0 THEN
    RAISE EXCEPTION 'p_token required';
  END IF;

  v_should_deactivate := p_error_classification IN (
    'invalid_token',
    'unregistered',
    'platform_mismatch',
    'session_signed_out'
  );

  IF p_success THEN
    -- Never reactivate a soft-deactivated / replaced token (single-device invariant).
    UPDATE public.push_tokens
    SET last_success_at = now(),
        last_seen_at = now(),
        failure_count = 0,
        last_failure_reason = NULL,
        updated_at = now()
    WHERE token = p_token
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.push_tokens
    SET last_failure_at = now(),
        last_failure_reason = COALESCE(p_error_classification, p_error_code, 'unknown'),
        failure_count = failure_count + 1,
        is_active = CASE
          WHEN v_should_deactivate THEN FALSE
          WHEN failure_count + 1 >= 5 THEN FALSE
          ELSE is_active
        END,
        updated_at = now()
    WHERE token = p_token
    RETURNING * INTO v_row;
  END IF;

  IF v_row.id IS NOT NULL THEN
    RAISE LOG '[push_token_result] token_id=% driver_id=% platform=% success=% classification=% code=% failure_count=% is_active=%',
      v_row.id, v_row.driver_id, v_row.platform, p_success, p_error_classification, p_error_code,
      v_row.failure_count, v_row.is_active;
  END IF;

  RETURN v_row;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ride_offer_dispatch_push_delivery(
  p_offer_id uuid,
  p_skip_notifications_insert boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  ro public.ride_offers%ROWTYPE;
  v_driver RECORD;
  v_trip RECORD;
  v_token TEXT;
  v_body jsonb;
  v_pickup_line TEXT;
  v_url TEXT := coalesce(
    nullif(trim(current_setting('app.settings.edge_send_notification_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/send-driver-notification'
  );
  v_auth TEXT := public.cron_edge_auth_token();
  v_active_device_id TEXT;
BEGIN
  SELECT * INTO ro FROM public.ride_offers WHERE id = p_offer_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF ro.status <> 'pending' THEN RETURN; END IF;
  IF ro.expires_at IS NOT NULL AND ro.expires_at <= now() THEN RETURN; END IF;

  SELECT id, user_id INTO v_driver FROM public.drivers WHERE id = ro.driver_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT id, pickup_address, dropoff_address, estimated_fare, currency_code
  INTO v_trip FROM public.trips WHERE id = ro.trip_id;
  IF NOT FOUND THEN RETURN; END IF;

  RAISE LOG '[booking_delivery] push_dispatch_entry_always booking_id=% offer_id=% driver_id=% note=enqueued_independent_of_realtime_socket',
    ro.trip_id, ro.id, ro.driver_id;

  PERFORM public.record_booking_delivery(
    ro.trip_id,
    'push_dispatch_entry',
    ro.driver_id,
    ro.id,
    'postgres',
    jsonb_strip_nulls(jsonb_build_object(
      'skip_notifications_insert', p_skip_notifications_insert,
      'edge', 'send_driver_notification_enqueue'
    ))
  );

  SELECT dad.device_id INTO v_active_device_id
  FROM public.driver_active_devices dad
  WHERE dad.driver_id = ro.driver_id;

  -- Authoritative token only (active device + is_active). No historical fan-out / presence hint alone.
  IF v_active_device_id IS NOT NULL THEN
    SELECT pt.token INTO v_token
    FROM public.push_tokens pt
    WHERE pt.driver_id = ro.driver_id
      AND pt.app_type = 'driver'
      AND pt.is_active = true
      AND pt.device_id = v_active_device_id
      AND coalesce(length(pt.token), 0) > 0
    ORDER BY pt.updated_at DESC
    LIMIT 1;
  END IF;

  v_pickup_line := concat(
    'Pickup: ',
    CASE
      WHEN v_trip.pickup_address IS NULL OR btrim(v_trip.pickup_address::text) = '' THEN 'Tap to view details'
      ELSE btrim(v_trip.pickup_address::text)
    END
  );

  IF NOT p_skip_notifications_insert THEN
    INSERT INTO public.notifications (
      target_audience, target_user_id, category, type, priority,
      title, message, metadata, is_read, is_dismissed
    ) VALUES (
      'user', v_driver.user_id, 'trip', 'new_trip_request', 'high',
      'New ride offer',
      v_pickup_line,
      jsonb_build_object(
        'event', 'ride_assigned',
        'offer_id', ro.id,
        'trip_id', ro.trip_id,
        'pickup', v_trip.pickup_address,
        'dropoff', v_trip.dropoff_address,
        'fare_label', CASE
          WHEN v_trip.estimated_fare IS NULL THEN NULL
          WHEN v_trip.currency_code IS NULL THEN v_trip.estimated_fare::TEXT
          ELSE v_trip.currency_code || ' ' || v_trip.estimated_fare::TEXT
        END,
        'offer_notification_type', 'new_ride_offer',
        'booking_id', v_trip.id,
        'push_token_present', v_token IS NOT NULL
      ),
      FALSE,
      FALSE
    );
  END IF;

  IF v_token IS NULL THEN
    UPDATE public.ride_offers SET
      delivery_push_attempts = LEAST(delivery_push_attempts + 1, 4),
      last_push_requested_at = now(),
      delivery_first_dispatched_at = COALESCE(delivery_first_dispatched_at, now()),
      delivery_phase = 'push_skipped_no_token',
      updated_at = now()
    WHERE id = ro.id;
    RAISE LOG '[delivery] push_skipped_no_token offer_id=% trip_id=% driver_id=%', ro.id, ro.trip_id, ro.driver_id;

    PERFORM public.record_booking_delivery(
      ro.trip_id,
      'push_enqueued_skip_no_token',
      ro.driver_id,
      ro.id,
      'postgres',
      '{"reason":"no_authoritative_push_token"}'::jsonb
    );

    RETURN;
  END IF;

  v_body := public.ride_offer_build_send_notification_body(ro.id);
  IF v_body IS NULL THEN
    RAISE LOG '[delivery] push_body_null offer_id=%', ro.id;
    RETURN;
  END IF;

  IF v_auth IS NULL OR length(trim(v_auth)) < 20 THEN
    RAISE LOG '[delivery] push_aborted_missing_service_token offer_id=%', ro.id;
    RETURN;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_auth,
        'apikey', v_auth
      ),
      body := v_body,
      timeout_milliseconds := 15000
    );

    UPDATE public.ride_offers SET
      delivery_push_attempts = LEAST(delivery_push_attempts + 1, 4),
      last_push_requested_at = now(),
      delivery_first_dispatched_at = COALESCE(delivery_first_dispatched_at, now()),
      delivery_phase = CASE WHEN delivery_phase = 'driver_received' THEN delivery_phase ELSE 'push_sent' END,
      updated_at = now()
    WHERE id = ro.id;

    PERFORM public.record_booking_delivery(
      ro.trip_id,
      'push_enqueued',
      ro.driver_id,
      ro.id,
      'postgres',
      '{"edge":"send-driver-notification"}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[delivery] push_enqueue_failed offer_id=% sqlerrm=%', ro.id, SQLERRM;
  END;
END;
$function$;
