-- ============================================================
-- Phase A8B5B2-SQL: Vault internal-notification header bridge
-- NOT APPLIED until explicitly approved.
--
-- Pre-deploy ops (not this migration):
--   1) Create Vault secret name: onecab_internal_notification_token
--   2) Set Edge secret ONECAB_INTERNAL_NOTIFICATION_TOKEN to the SAME value
--   3) Keep send-driver-notification v513 public until this SQL is live
--
-- This migration:
--   - Adds postgres-only helper onecab_internal_notification_http_headers()
--   - Rewrites ONLY http auth headers on proven SQL SDN callers
--   - Does NOT embed any secret/JWT value
--   - Does NOT change verify_jwt / Edge code
--   - Fails closed if Vault extension/view/secret is absent/duplicated/too short
--   - SQL Vault bridge is a security prerequisite: ordinary Edge rollback KEEPS it
--
-- Rollback levels (see rollback/*.sql + ROLLBACK_A8B5B2.md):
--   A) Edge: redeploy v513; leave SQL Vault bridge + secrets installed
--   B) DB: restore business bodies if needed; KEEP Vault helper/header; never anon JWT
--
-- Proposed body hashes (from linked BEGIN/ROLLBACK simulation; helper md5 081cb5b2292bf0e79829331460a09156):

--   notify_driver_lost_property: 2c6d3f0c3879b2521ce62a8eee5d0a00 -> b52d209c5895922861ccccc4e457dfc5
--   notify_driver_on_trip_cancelled: d8a3f4da3d003ed57e6d1ce0fe73f64b -> 8ba90beb3e1ec481429da11b1b6f4dfc
--   notify_driver_trip_change_request: 00a3a3afb4d87c08f70b41759912c1ff -> 5e8568cfe63e711319b5ed3ae2922add
--   notify_drivers_trip_cancelled: 0c923cde1a7b60f5c9f136bb6b0c2453 -> ca0d8b71d751e29a9a0259c3dc678180
--   notify_offer_drivers_on_trip_terminal: 3864756d3cd121844aa5bd3d9f310adb -> f4ccda04dd2893f5e5c0a68b8a8791f0
--   ride_offer_dispatch_push_delivery: 2a150da9b91fdc8c6f9086b3545a805d -> 659c1732319068fe4ffe92e0714c3bc4
--   tg_driver_alerts_push_on_raise: 6ce130fed9e28c57e385c62fa3f521b0 -> 0de55487c56452d3d715fcf549009279
-- ============================================================

BEGIN;

-- ============================================================
-- Preconditions (ALL before any caller CREATE OR REPLACE)
-- ============================================================
DO $pre$
DECLARE
  v_count integer;
  v_ok boolean;
  v_headers jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'supabase_vault') THEN
    RAISE EXCEPTION 'A8B5B2: extension supabase_vault is unavailable';
  END IF;

  IF to_regclass('vault.decrypted_secrets') IS NULL THEN
    RAISE EXCEPTION 'A8B5B2: vault.decrypted_secrets is unavailable';
  END IF;

  IF NOT has_table_privilege('postgres', 'vault.decrypted_secrets', 'SELECT') THEN
    RAISE EXCEPTION 'A8B5B2: postgres cannot SELECT vault.decrypted_secrets';
  END IF;

  SELECT count(*)::integer INTO v_count
  FROM vault.decrypted_secrets ds
  WHERE ds.name = 'onecab_internal_notification_token';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'A8B5B2: Vault secret onecab_internal_notification_token is absent. Provision before apply.';
  ELSIF v_count > 1 THEN
    RAISE EXCEPTION 'A8B5B2: Vault secret onecab_internal_notification_token is duplicated (count=%).', v_count;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM vault.decrypted_secrets ds
    WHERE ds.name = 'onecab_internal_notification_token'
      AND nullif(btrim(ds.decrypted_secret), '') IS NOT NULL
      AND length(btrim(ds.decrypted_secret)) >= 32
  ) INTO v_ok;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'A8B5B2: Vault secret onecab_internal_notification_token is empty or shorter than 32 chars.';
  END IF;
END;
$pre$;


CREATE OR REPLACE FUNCTION public.onecab_internal_notification_http_headers()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, vault
AS $fn$
DECLARE
  v_count integer;
  v_token text;
BEGIN
  SELECT count(*)::integer INTO v_count
  FROM vault.decrypted_secrets ds
  WHERE ds.name = 'onecab_internal_notification_token';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'ONECAB_INTERNAL_NOTIFICATION_TOKEN_NOT_CONFIGURED'
      USING ERRCODE = 'P0001';
  ELSIF v_count > 1 THEN
    RAISE EXCEPTION 'ONECAB_INTERNAL_NOTIFICATION_TOKEN_DUPLICATE'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT nullif(btrim(ds.decrypted_secret), '') INTO v_token
  FROM vault.decrypted_secrets ds
  WHERE ds.name = 'onecab_internal_notification_token';

  IF v_token IS NULL OR length(v_token) < 32 THEN
    RAISE EXCEPTION 'ONECAB_INTERNAL_NOTIFICATION_TOKEN_INVALID'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'Content-Type', 'application/json',
    'X-ONECAB-INTERNAL-NOTIFICATION-TOKEN', v_token
  );
END;
$fn$;

COMMENT ON FUNCTION public.onecab_internal_notification_http_headers() IS
  'A8B5B2 temporary bridge: returns pg_net headers for send-driver-notification. Postgres-only. Reads Vault secret onecab_internal_notification_token. Never falls back to anon or service_role GUC.';

REVOKE ALL ON FUNCTION public.onecab_internal_notification_http_headers() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.onecab_internal_notification_http_headers() FROM anon;
REVOKE ALL ON FUNCTION public.onecab_internal_notification_http_headers() FROM authenticated;
REVOKE ALL ON FUNCTION public.onecab_internal_notification_http_headers() FROM service_role;



-- Prove postgres can resolve helper headers structurally (never log token).
DO $resolve$
DECLARE
  h jsonb;
BEGIN
  h := public.onecab_internal_notification_http_headers();
  IF jsonb_typeof(h) IS DISTINCT FROM 'object'
     OR NOT (h ? 'Content-Type')
     OR NOT (h ? 'X-ONECAB-INTERNAL-NOTIFICATION-TOKEN')
     OR (h->>'Content-Type') IS DISTINCT FROM 'application/json'
     OR length(h->>'X-ONECAB-INTERNAL-NOTIFICATION-TOKEN') < 32
  THEN
    RAISE EXCEPTION 'A8B5B2: postgres cannot resolve onecab_internal_notification_http_headers()';
  END IF;
END;
$resolve$;

-- notify_driver_lost_property: 2c6d3f0c3879b2521ce62a8eee5d0a00 -> b52d209c5895922861ccccc4e457dfc5
CREATE OR REPLACE FUNCTION public.notify_driver_lost_property()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $body$

DECLARE
  v_driver_id UUID;
  v_case_number TEXT;
  v_item TEXT;
  v_supabase_url TEXT := 'https://thazislrdkjpvvghtvzo.supabase.co';
BEGIN
  IF NEW.status = 'sent_to_driver' AND (OLD.status IS NULL OR OLD.status != 'sent_to_driver') THEN
    v_driver_id := NEW.driver_id;
    v_case_number := NEW.case_number;
    v_item := COALESCE(NEW.item_description, 'an item');

    IF v_driver_id IS NULL THEN
      RETURN NEW;
    END IF;

    PERFORM net.http_post(
      url := v_supabase_url || '/functions/v1/send-driver-notification',
      headers := public.onecab_internal_notification_http_headers(),
      body := jsonb_build_object(
        'driverId', v_driver_id,
        'type', 'SYSTEM_ALERT',
        'title', '📦 Lost Property Report (' || v_case_number || ')',
        'body', 'A passenger reported losing ' || v_item || ' in your vehicle. Please check and respond.',
        'data', jsonb_build_object(
          'case_id', NEW.id::text,
          'case_number', v_case_number,
          'action', 'LOST_PROPERTY'
        )
      )
    );
  END IF;

  RETURN NEW;
END;
$body$;

-- notify_driver_on_trip_cancelled: d8a3f4da3d003ed57e6d1ce0fe73f64b -> 8ba90beb3e1ec481429da11b1b6f4dfc
CREATE OR REPLACE FUNCTION public.notify_driver_on_trip_cancelled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $body$

DECLARE
  v_driver_id uuid;
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.send_driver_notification_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/send-driver-notification'
  );
  v_terminal text[] := ARRAY['cancelled', 'canceled', 'expired', 'declined', 'no_show', 'no-show'];
  v_stop_reason text;
  v_push_body text;
BEGIN
  IF TG_OP <> 'UPDATE' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (NEW.status = ANY (v_terminal)) OR OLD.status = ANY (v_terminal) THEN
    RETURN NEW;
  END IF;

  v_driver_id := COALESCE(NEW.driver_id, NEW.confirmed_driver_id, OLD.driver_id, OLD.confirmed_driver_id);
  v_stop_reason := public.canonical_trip_terminal_stop_reason(
    NEW.status,
    NEW.cancelled_by,
    NEW.cancel_reason
  );
  v_push_body := CASE v_stop_reason
    WHEN 'customer_cancelled' THEN 'The customer cancelled this ride'
    WHEN 'offer_expired' THEN 'This offer timed out'
    ELSE 'Trip no longer available'
  END;

  IF v_driver_id IS NULL OR v_url IS NULL OR length(trim(v_url)) < 20 THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := public.onecab_internal_notification_http_headers(),
      body := jsonb_build_object(
        'driverId', v_driver_id::text,
        'type', 'RIDE_STOP',
        'title', 'Ride no longer available',
        'body', v_push_body,
        'data', jsonb_build_object(
          'type', 'RIDE_STOP',
          'event', 'trip_cancelled',
          'stopReason', v_stop_reason,
          'stop_reason', v_stop_reason,
          'trip_status', NEW.status,
          'trip_id', NEW.id::text,
          'tripId', NEW.id::text,
          'booking_id', NEW.id::text,
          'bookingId', NEW.id::text
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE LOG '[notify_driver_on_trip_cancelled] RIDE_STOP failed trip=%: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$body$;

-- notify_driver_trip_change_request: 00a3a3afb4d87c08f70b41759912c1ff -> 5e8568cfe63e711319b5ed3ae2922add
CREATE OR REPLACE FUNCTION public.notify_driver_trip_change_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $body$

DECLARE
  v_driver_id UUID;
  v_title TEXT;
  v_body TEXT;
  v_supabase_url TEXT := 'https://thazislrdkjpvvghtvzo.supabase.co';
BEGIN
  -- Only notify driver for pending approval or auto-applied updates (not payment_required).
  IF NEW.status NOT IN ('pending_driver_approval', 'approved', 'applied') THEN
    RETURN NEW;
  END IF;

  -- Never show approval UI path for non-nav changes.
  IF NEW.status = 'pending_driver_approval' AND COALESCE(NEW.navigation_impacted, false) = false THEN
    RETURN NEW;
  END IF;

  SELECT driver_id INTO v_driver_id
  FROM trips
  WHERE id = NEW.trip_id;

  IF v_driver_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('approved', 'applied') THEN
    v_title := 'Trip updated';
    v_body := 'Booking updated';
  ELSE
    v_title := 'Trip update pending approval';
    v_body := 'Booking updated';
  END IF;

  PERFORM net.http_post(
    url := v_supabase_url || '/functions/v1/send-driver-notification',
    headers := public.onecab_internal_notification_http_headers(),
    body := jsonb_build_object(
      'driverId', v_driver_id,
      'type', 'TRIP_UPDATE',
      'title', v_title,
      'body', v_body,
      'data', jsonb_build_object(
        'trip_id', NEW.trip_id::text,
        'change_request_id', NEW.id::text,
        'action', 'TRIP_CHANGE_REQUEST'
      )
    )
  );

  RETURN NEW;
END;
$body$;

-- notify_drivers_trip_cancelled: 0c923cde1a7b60f5c9f136bb6b0c2453 -> ca0d8b71d751e29a9a0259c3dc678180
CREATE OR REPLACE FUNCTION public.notify_drivers_trip_cancelled(p_trip_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $body$

DECLARE
  v_offer RECORD;
  v_trip RECORD;
  v_url TEXT := coalesce(nullif(trim(current_setting('app.settings.edge_send_notification_url', true)), ''),
                         'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/send-driver-notification');
  v_count INT := 0;
BEGIN
  SELECT id, trip_code FROM public.trips WHERE id = p_trip_id INTO v_trip;
  IF NOT FOUND THEN RETURN; END IF;

  FOR v_offer IN
    SELECT id, driver_id
    FROM public.ride_offers
    WHERE trip_id = p_trip_id
      AND status IN ('pending', 'offered', 'negotiating')
  LOOP
    -- Revoke the offer so dispatchable logic agrees with the stop signal
    UPDATE public.ride_offers
       SET status = 'revoked', updated_at = now()
     WHERE id = v_offer.id;

    -- Fire-and-forget RIDE_STOP push
    BEGIN
      PERFORM net.http_post(
        url := v_url,
        body := jsonb_build_object(
          'driverId', v_offer.driver_id,
          'type', 'RIDE_STOP',
          'title', 'Ride cancelled',
          'body', 'The customer cancelled this ride',
          'data', jsonb_build_object(
            'type', 'RIDE_STOP',
            'reason', coalesce(p_reason, 'customer_cancelled'),
            'stopReason', coalesce(p_reason, 'customer_cancelled'),
            'offerId', v_offer.id::text,
            'offer_id', v_offer.id::text,
            'tripId', p_trip_id::text,
            'trip_id', p_trip_id::text,
            'booking_id', p_trip_id::text,
            'trip_reference', coalesce(v_trip.trip_code, p_trip_id::text)
          )
        ),
        headers := public.onecab_internal_notification_http_headers()
      );
      v_count := v_count + 1;
      RAISE LOG '[trip_cancel_stop] ride_stop_push_dispatched trip=% offer=% driver=% reason=%',
        p_trip_id, v_offer.id, v_offer.driver_id, p_reason;
    EXCEPTION WHEN OTHERS THEN
      RAISE LOG '[trip_cancel_stop] ride_stop_push_failed trip=% offer=% driver=% sqlstate=% sqlerrm=%',
        p_trip_id, v_offer.id, v_offer.driver_id, SQLSTATE, SQLERRM;
    END;
  END LOOP;

  RAISE LOG '[trip_cancel_stop] fanout_complete trip=% reason=% drivers_notified=%',
    p_trip_id, p_reason, v_count;
END;
$body$;

-- notify_offer_drivers_on_trip_terminal: 3864756d3cd121844aa5bd3d9f310adb -> f4ccda04dd2893f5e5c0a68b8a8791f0
CREATE OR REPLACE FUNCTION public.notify_offer_drivers_on_trip_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $body$

DECLARE
  v_terminal text[] := ARRAY['cancelled', 'canceled', 'expired', 'declined', 'no_show', 'no-show'];
  v_stop_reason text;
  v_push_body text;
  v_url text := coalesce(
    nullif(trim(current_setting('app.settings.send_driver_notification_url', true)), ''),
    'https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/send-driver-notification'
  );
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

  v_push_body := CASE v_stop_reason
    WHEN 'customer_cancelled' THEN 'The customer cancelled this ride'
    WHEN 'offer_expired' THEN 'This offer timed out'
    WHEN 'reassigned' THEN 'This ride was reassigned'
    ELSE 'Ride no longer available'
  END;

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
    AND ro.status IN ('pending', 'countered');

  IF v_url IS NULL OR length(trim(v_url)) < 20 THEN
    RETURN NEW;
  END IF;

  FOR v_row IN
    SELECT DISTINCT ro.driver_id, ro.id AS offer_id
    FROM public.ride_offers ro
    WHERE ro.trip_id = NEW.id
      AND ro.driver_id IS NOT NULL
  LOOP
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
            'stopReason', v_stop_reason,
            'stop_reason', v_stop_reason,
            'trip_status', NEW.status,
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

-- ride_offer_dispatch_push_delivery: 2a150da9b91fdc8c6f9086b3545a805d -> 659c1732319068fe4ffe92e0714c3bc4
CREATE OR REPLACE FUNCTION public.ride_offer_dispatch_push_delivery(p_offer_id uuid, p_skip_notifications_insert boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $body$

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

  BEGIN
    PERFORM net.http_post(
      url := v_url,
      headers := public.onecab_internal_notification_http_headers(),
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
$body$;

-- tg_driver_alerts_push_on_raise: 6ce130fed9e28c57e385c62fa3f521b0 -> 0de55487c56452d3d715fcf549009279
CREATE OR REPLACE FUNCTION public.tg_driver_alerts_push_on_raise()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $body$

DECLARE
  v_url  TEXT := 'https://thazislrdkjpvvghtvzo.supabase.co';
  v_title TEXT;
  v_body  TEXT;
BEGIN
  IF NEW.status <> 'active' OR NEW.severity <> 'critical' THEN
    RETURN NEW;
  END IF;

  -- Temporary safety: NEVER push heartbeat/FGS-loss copy — breaks on healthy iOS
  -- backgrounds (heartbeat RPC lags CoreLocation/WebView). Banner + cron still record row.
  IF NEW.alert_type IN ('heartbeat_missing', 'tracking_service_stopped') THEN
    RAISE WARNING 'TRACKING_RESTORE_PUSH_SUPPRESSED driver_id=% alert_type=% severity=% msg=no_apn_tracking_restore',
      NEW.driver_id::text, NEW.alert_type, NEW.severity::text;
    RETURN NEW;
  END IF;

  CASE NEW.alert_type
    WHEN 'heartbeat_missing' THEN
      v_title := 'Reconnecting…';
      v_body  := 'Restoring tracking in the background.';
    WHEN 'location_stale' THEN
      v_title := 'Looking for GPS…';
      v_body  := 'Waiting for a fresh location update.';
    WHEN 'gps_accuracy_poor' THEN
      v_title := 'Poor GPS signal';
      v_body  := 'Move to an open area for better accuracy.';
    WHEN 'tracking_service_stopped' THEN
      v_title := 'Reconnecting tracking…';
      v_body  := 'Restoring location service in the background.';
    WHEN 'socket_disconnected' THEN
      v_title := 'Poor connection';
      v_body  := 'Updates may be delayed. Retrying automatically.';
    WHEN 'booking_ack_missing' THEN
      v_title := 'Confirming booking…';
      v_body  := 'Re-sending acknowledgement.';
    WHEN 'driver_not_moving' THEN
      v_title := 'Are you moving?';
      v_body  := 'You appear stationary during an active trip.';
    WHEN 'pickup_eta_exceeded' THEN
      v_title := 'Pickup running late';
      v_body  := 'You are past the expected arrival time.';
    ELSE
      v_title := 'Driver app alert';
      v_body  := COALESCE(NEW.message, NEW.alert_type);
  END CASE;

  PERFORM net.http_post(
    url := v_url || '/functions/v1/send-driver-notification',
    headers := public.onecab_internal_notification_http_headers(),
    body := jsonb_build_object(
      'driverId', NEW.driver_id::text,
      'type', 'SYSTEM_ALERT',
      'title', v_title,
      'body',  v_body,
      'data', jsonb_build_object(
        'alert_id', NEW.id::text,
        'alert_type', NEW.alert_type,
        'severity', NEW.severity::text,
        'booking_id', COALESCE(NEW.booking_id::text, '')
      )
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'tg_driver_alerts_push_on_raise: % / %', SQLERRM, SQLSTATE;
  RETURN NEW;
END;
$body$;

-- Preserve A8B5A ACL on cancel notify child (CREATE OR REPLACE keeps ACLs on PG,
-- but re-assert explicitly).
REVOKE ALL ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.notify_drivers_trip_cancelled(uuid, text) FROM service_role;

-- ride_offer_dispatch_push_delivery currently grants authenticated+service_role; leave as-is.

COMMIT;

