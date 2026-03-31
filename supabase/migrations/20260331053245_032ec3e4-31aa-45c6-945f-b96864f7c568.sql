
-- =============================================================
-- PHASE 2 COMPLETION: ALL MISSING DETECTION FUNCTIONS
-- =============================================================

-- =============================================
-- 1. GUEST BOOKING DETECTIONS
-- =============================================

-- 1a. Guest quote failures: trips from guest source that got cancelled/failed quickly
CREATE OR REPLACE FUNCTION public.ops_detect_guest_quote_failures()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT t.id as trip_id, t.service_area_id, t.passenger_name,
           t.created_at as trip_created
    FROM public.trips t
    WHERE t.booking_source = 'guest'
      AND t.status IN ('cancelled', 'failed')
      AND t.created_at > now() - interval '1 hour'
      AND (t.driver_id IS NULL) -- never got a driver = quote/early stage failure
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_events oe
        WHERE oe.trip_id = t.id AND oe.event_type = 'guest_quote_failure' AND oe.resolved = false
      )
  LOOP
    PERFORM public.ops_record_event(
      'guest_quote_failure', 'guest_booking', 'warning', 'guest',
      r.trip_id, NULL, NULL, NULL, NULL, r.service_area_id,
      NULL, NULL,
      'Guest booking failed at quote/early stage for ' || COALESCE(r.passenger_name, 'unknown guest'),
      jsonb_build_object('passenger_name', r.passenger_name, 'created_at', r.trip_created)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 1b. Guest checkout failures: guest trips with payment failures
CREATE OR REPLACE FUNCTION public.ops_detect_guest_checkout_failures()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT t.id as trip_id, t.service_area_id, t.passenger_name,
           p.id as payment_id, p.last_error, p.amount_pence, p.currency
    FROM public.trips t
    JOIN public.payments p ON p.trip_id = t.id
    WHERE t.booking_source = 'guest'
      AND p.status IN ('failed', 'canceled')
      AND p.updated_at > now() - interval '1 hour'
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_events oe
        WHERE oe.payment_id = p.id AND oe.event_type = 'guest_checkout_failure' AND oe.resolved = false
      )
  LOOP
    PERFORM public.ops_record_event(
      'guest_checkout_failure', 'guest_booking', 'critical', 'guest',
      r.trip_id, NULL, NULL, r.payment_id, NULL, r.service_area_id,
      r.amount_pence, r.currency,
      'Guest checkout failed: ' || COALESCE(r.last_error, 'Unknown') || ' for ' || COALESCE(r.passenger_name, 'unknown'),
      jsonb_build_object('last_error', r.last_error, 'passenger_name', r.passenger_name)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 1c. Guest booking not confirmed: guest trips stuck in pending >10min
CREATE OR REPLACE FUNCTION public.ops_detect_guest_booking_not_confirmed()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT t.id as trip_id, t.service_area_id, t.passenger_name,
           EXTRACT(EPOCH FROM (now() - t.created_at))/60 as minutes_pending
    FROM public.trips t
    WHERE t.booking_source = 'guest'
      AND t.status = 'pending'
      AND t.created_at < now() - interval '10 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_events oe
        WHERE oe.trip_id = t.id AND oe.event_type = 'guest_booking_not_confirmed' AND oe.resolved = false
      )
  LOOP
    PERFORM public.ops_record_event(
      'guest_booking_not_confirmed', 'guest_booking', 'warning', 'guest',
      r.trip_id, NULL, NULL, NULL, NULL, r.service_area_id,
      NULL, NULL,
      'Guest booking pending for ' || round(r.minutes_pending) || ' min without confirmation',
      jsonb_build_object('minutes_pending', round(r.minutes_pending), 'passenger_name', r.passenger_name)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 1d. Guest booking drop-offs: guest trips created but cancelled by customer within 2 min
CREATE OR REPLACE FUNCTION public.ops_detect_guest_dropoffs()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; v_dropoff_count int;
BEGIN
  SELECT count(*) INTO v_dropoff_count
  FROM public.trips t
  WHERE t.booking_source = 'guest'
    AND t.status = 'cancelled'
    AND t.created_at > now() - interval '1 hour'
    AND EXTRACT(EPOCH FROM (COALESCE(t.updated_at, t.created_at) - t.created_at)) < 120;

  IF v_dropoff_count >= 3 THEN
    PERFORM public.ops_upsert_alert(
      'guest_dropoff_spike:' || date_trunc('hour', now())::text,
      'guest_booking', 'warning', 'system', 'guest',
      'Guest Booking Drop-off Spike',
      v_dropoff_count || ' guest bookings abandoned within 2 minutes in the last hour',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('dropoff_count', v_dropoff_count, 'window', '1 hour')
    );
    v_count := 1;
  END IF;
  RETURN v_count;
END;
$$;

-- 1e. Guest slow pages / API latency: ops_logs from guest app with high duration
CREATE OR REPLACE FUNCTION public.ops_detect_guest_latency()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; v_slow_count int; v_avg_ms numeric;
BEGIN
  SELECT count(*), COALESCE(avg(duration_ms), 0)
  INTO v_slow_count, v_avg_ms
  FROM public.ops_logs
  WHERE app = 'guest'
    AND duration_ms > 3000
    AND created_at > now() - interval '15 minutes';

  IF v_slow_count >= 5 THEN
    PERFORM public.ops_upsert_alert(
      'guest_latency_spike:' || date_trunc('hour', now())::text,
      'guest_booking', 'warning', 'system', 'guest',
      'Guest Web Latency Spike',
      v_slow_count || ' slow requests (>' || round(v_avg_ms) || 'ms avg) on guest.onecab.net in last 15 min',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('slow_count', v_slow_count, 'avg_ms', round(v_avg_ms), 'threshold_ms', 3000)
    );
    v_count := 1;
  END IF;
  RETURN v_count;
END;
$$;


-- =============================================
-- 2. LOG-BASED DETECTIONS
-- =============================================

-- 2a. Repeated errors: cluster of error/fatal logs from same source in short window
CREATE OR REPLACE FUNCTION public.ops_detect_error_spikes()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT source, app, count(*) as error_count
    FROM public.ops_logs
    WHERE level IN ('error', 'fatal')
      AND created_at > now() - interval '15 minutes'
    GROUP BY source, app
    HAVING count(*) >= 5
  LOOP
    PERFORM public.ops_upsert_alert(
      'error_spike:' || r.source || ':' || COALESCE(r.app, '') || ':' || date_trunc('hour', now())::text,
      'logs', 'critical', 'system', r.app,
      'Error Spike: ' || r.source,
      r.error_count || ' errors from ' || r.source || ' in last 15 minutes',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('source', r.source, 'error_count', r.error_count, 'window_minutes', 15)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 2b. Fatal logs: any fatal log triggers immediate alert
CREATE OR REPLACE FUNCTION public.ops_detect_fatal_logs()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT id, source, app, message, error_code, trip_id, driver_id, created_at
    FROM public.ops_logs
    WHERE level = 'fatal'
      AND created_at > now() - interval '30 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_alerts oa
        WHERE oa.fingerprint = 'fatal_log:' || source || ':' || COALESCE(error_code, 'none')
          AND oa.status IN ('open', 'acknowledged')
          AND oa.last_detected_at > now() - interval '30 minutes'
      )
  LOOP
    PERFORM public.ops_upsert_alert(
      'fatal_log:' || r.source || ':' || COALESCE(r.error_code, 'none'),
      'logs', 'fatal', 'system', r.app,
      'Fatal Error: ' || r.source,
      r.message,
      r.trip_id, r.driver_id, NULL, NULL,
      'ops_log', r.id::text,
      jsonb_build_object('error_code', r.error_code, 'log_id', r.id)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 2c. API 5xx spikes: cluster of http_status >= 500 in ops_logs
CREATE OR REPLACE FUNCTION public.ops_detect_5xx_spikes()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT source, app, count(*) as error_count,
           avg(duration_ms) as avg_duration
    FROM public.ops_logs
    WHERE http_status >= 500
      AND created_at > now() - interval '10 minutes'
    GROUP BY source, app
    HAVING count(*) >= 3
  LOOP
    PERFORM public.ops_upsert_alert(
      '5xx_spike:' || r.source || ':' || COALESCE(r.app, '') || ':' || date_trunc('hour', now())::text,
      'backend', 'critical', 'system', r.app,
      'API 5xx Spike: ' || r.source,
      r.error_count || ' server errors from ' || r.source || ' in 10 minutes (avg ' || round(COALESCE(r.avg_duration, 0)) || 'ms)',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('source', r.source, 'error_count', r.error_count, 'avg_duration_ms', round(COALESCE(r.avg_duration, 0)))
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 2d. Latency spikes: requests with duration_ms > threshold clustered
CREATE OR REPLACE FUNCTION public.ops_detect_latency_spikes()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT source, app, count(*) as slow_count,
           avg(duration_ms) as avg_ms, max(duration_ms) as max_ms
    FROM public.ops_logs
    WHERE duration_ms > 5000
      AND created_at > now() - interval '15 minutes'
    GROUP BY source, app
    HAVING count(*) >= 3
  LOOP
    PERFORM public.ops_upsert_alert(
      'latency_spike:' || r.source || ':' || COALESCE(r.app, '') || ':' || date_trunc('hour', now())::text,
      'backend', 'warning', 'system', r.app,
      'Latency Spike: ' || r.source,
      r.slow_count || ' slow requests (avg ' || round(r.avg_ms) || 'ms, max ' || r.max_ms || 'ms)',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('source', r.source, 'slow_count', r.slow_count, 'avg_ms', round(r.avg_ms), 'max_ms', r.max_ms)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 2e. Edge Function failures: errors from edge function sources
CREATE OR REPLACE FUNCTION public.ops_detect_edge_function_failures()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT source, count(*) as fail_count
    FROM public.ops_logs
    WHERE level IN ('error', 'fatal')
      AND created_at > now() - interval '30 minutes'
      AND (source LIKE '%-trip' OR source LIKE '%dispatch%' OR source LIKE '%payment%'
           OR source LIKE '%payout%' OR source LIKE '%commission%' OR source LIKE '%driver-%'
           OR source LIKE '%estimate-%' OR source LIKE '%calculate-%' OR source LIKE '%capture-%'
           OR source LIKE '%cancel-%' OR source LIKE '%complete-%' OR source LIKE '%accept-%'
           OR source LIKE '%decline-%' OR source LIKE '%find-%' OR source LIKE '%resolve-%'
           OR source LIKE '%schedule-%' OR source LIKE '%upsert-%' OR source LIKE '%validate-%'
           OR source LIKE '%stripe-%' OR source LIKE '%document-%' OR source LIKE '%ops-%'
           OR source LIKE '%qr-%' OR source LIKE '%public-%' OR source LIKE '%handle-%')
    GROUP BY source
    HAVING count(*) >= 3
  LOOP
    PERFORM public.ops_upsert_alert(
      'edge_fn_failure:' || r.source || ':' || date_trunc('hour', now())::text,
      'backend', 'critical', 'system', 'backend',
      'Edge Function Failures: ' || r.source,
      r.fail_count || ' failures from edge function ' || r.source || ' in last 30 min',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('function_name', r.source, 'fail_count', r.fail_count)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 2f. Webhook failures: errors from webhook-related sources
CREATE OR REPLACE FUNCTION public.ops_detect_webhook_failures()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT source, app, count(*) as fail_count
    FROM public.ops_logs
    WHERE level IN ('error', 'fatal')
      AND created_at > now() - interval '1 hour'
      AND (source ILIKE '%webhook%' OR source ILIKE '%stripe-webhook%' OR error_code ILIKE '%webhook%')
    GROUP BY source, app
    HAVING count(*) >= 2
  LOOP
    PERFORM public.ops_upsert_alert(
      'webhook_failure:' || r.source || ':' || date_trunc('hour', now())::text,
      'backend', 'critical', 'system', COALESCE(r.app, 'backend'),
      'Webhook Failures: ' || r.source,
      r.fail_count || ' webhook processing failures in last hour',
      NULL, NULL, NULL, NULL, NULL, NULL,
      jsonb_build_object('source', r.source, 'fail_count', r.fail_count)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;


-- =============================================
-- 3. DUPLICATION DETECTIONS (FULL COVERAGE)
-- =============================================

-- 3a. Duplicate bookings: same passenger + pickup + dropoff within 5 min
CREATE OR REPLACE FUNCTION public.ops_detect_duplicate_bookings()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT t1.id as trip1_id, t2.id as trip2_id, t1.passenger_name,
           t1.pickup_address, t1.service_area_id,
           EXTRACT(EPOCH FROM (t2.created_at - t1.created_at)) as seconds_apart
    FROM public.trips t1
    JOIN public.trips t2 ON t1.id < t2.id
      AND t1.passenger_name = t2.passenger_name
      AND t1.pickup_address = t2.pickup_address
      AND t1.dropoff_address = t2.dropoff_address
      AND ABS(EXTRACT(EPOCH FROM (t2.created_at - t1.created_at))) < 300
    WHERE t1.created_at > now() - interval '2 hours'
      AND t1.status NOT IN ('cancelled')
      AND t2.status NOT IN ('cancelled')
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_alerts oa
        WHERE oa.fingerprint = 'dup_booking:' || t1.id::text || ':' || t2.id::text
          AND oa.status IN ('open', 'acknowledged')
      )
  LOOP
    PERFORM public.ops_upsert_alert(
      'dup_booking:' || r.trip1_id::text || ':' || r.trip2_id::text,
      'duplication', 'critical', 'system', NULL,
      'Duplicate Booking Detected',
      'Same passenger (' || COALESCE(r.passenger_name, '?') || ') booked identical trips ' || round(r.seconds_apart) || 's apart',
      r.trip1_id, NULL, NULL, NULL, 'trip', r.trip2_id::text,
      jsonb_build_object('trip1_id', r.trip1_id, 'trip2_id', r.trip2_id, 'seconds_apart', round(r.seconds_apart))
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 3b. Duplicate payouts: same driver paid twice in same batch or overlapping batches
CREATE OR REPLACE FUNCTION public.ops_detect_duplicate_payouts()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT pi1.driver_id, pi1.trip_id, pi1.id as item1_id, pi2.id as item2_id,
           pi1.amount_pence, pi1.batch_id as batch1, pi2.batch_id as batch2
    FROM public.payout_items pi1
    JOIN public.payout_items pi2 ON pi1.id < pi2.id
      AND pi1.driver_id = pi2.driver_id
      AND pi1.trip_id = pi2.trip_id
      AND pi1.trip_id IS NOT NULL
    WHERE pi1.status IN ('completed', 'pending')
      AND pi2.status IN ('completed', 'pending')
      AND pi1.created_at > now() - interval '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_alerts oa
        WHERE oa.fingerprint = 'dup_payout:' || pi1.driver_id::text || ':' || pi1.trip_id::text
          AND oa.status IN ('open', 'acknowledged')
      )
  LOOP
    PERFORM public.ops_upsert_alert(
      'dup_payout:' || r.driver_id::text || ':' || r.trip_id::text,
      'duplication', 'critical', 'system', 'backend',
      'Duplicate Payout Detected',
      'Driver paid twice for same trip. Amount: ' || r.amount_pence || ' pence',
      r.trip_id, r.driver_id, NULL, r.batch1, 'payout_item', r.item2_id::text,
      jsonb_build_object('item1_id', r.item1_id, 'item2_id', r.item2_id, 'amount_pence', r.amount_pence)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 3c. Duplicate driver earnings: same trip_id in driver_ledger with same entry_type
CREATE OR REPLACE FUNCTION public.ops_detect_duplicate_earnings()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT dl.driver_id, dl.trip_id, dl.entry_type, count(*) as dup_count,
           sum(dl.amount_pence) as total_pence
    FROM public.driver_ledger dl
    WHERE dl.trip_id IS NOT NULL
      AND dl.created_at > now() - interval '24 hours'
      AND dl.entry_type IN ('TRIP_EARNING_NET', 'TRIP_EARNING_GROSS')
    GROUP BY dl.driver_id, dl.trip_id, dl.entry_type
    HAVING count(*) > 1
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.ops_alerts oa
      WHERE oa.fingerprint = 'dup_earning:' || r.driver_id::text || ':' || r.trip_id::text || ':' || r.entry_type
        AND oa.status IN ('open', 'acknowledged')
    ) THEN
      PERFORM public.ops_upsert_alert(
        'dup_earning:' || r.driver_id::text || ':' || r.trip_id::text || ':' || r.entry_type,
        'duplication', 'critical', 'system', 'backend',
        'Duplicate Driver Earning',
        r.dup_count || 'x ' || r.entry_type || ' entries for same trip. Total: ' || r.total_pence || ' pence',
        r.trip_id, r.driver_id, NULL, NULL, 'driver_ledger', NULL,
        jsonb_build_object('entry_type', r.entry_type, 'dup_count', r.dup_count, 'total_pence', r.total_pence)
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 3d. Duplicate dispatch requests: same trip offered to same driver multiple times
CREATE OR REPLACE FUNCTION public.ops_detect_duplicate_dispatches()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT to1.trip_id, to1.driver_id, count(*) as offer_count
    FROM public.trip_offers to1
    WHERE to1.created_at > now() - interval '2 hours'
    GROUP BY to1.trip_id, to1.driver_id
    HAVING count(*) > 1
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.ops_alerts oa
      WHERE oa.fingerprint = 'dup_dispatch:' || r.trip_id::text || ':' || r.driver_id::text
        AND oa.status IN ('open', 'acknowledged')
    ) THEN
      PERFORM public.ops_upsert_alert(
        'dup_dispatch:' || r.trip_id::text || ':' || r.driver_id::text,
        'duplication', 'warning', 'system', 'backend',
        'Duplicate Dispatch Offer',
        'Same trip offered to same driver ' || r.offer_count || ' times',
        r.trip_id, r.driver_id, NULL, NULL, NULL, NULL,
        jsonb_build_object('offer_count', r.offer_count)
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 3e. Repeated webhook processing: duplicate stripe_payment_intent_id in payments
CREATE OR REPLACE FUNCTION public.ops_detect_repeated_webhooks()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT p.stripe_payment_intent_id, count(*) as dup_count,
           array_agg(p.id) as payment_ids
    FROM public.payments p
    WHERE p.stripe_payment_intent_id IS NOT NULL
      AND p.created_at > now() - interval '24 hours'
    GROUP BY p.stripe_payment_intent_id
    HAVING count(*) > 1
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.ops_alerts oa
      WHERE oa.fingerprint = 'dup_webhook:' || r.stripe_payment_intent_id
        AND oa.status IN ('open', 'acknowledged')
    ) THEN
      PERFORM public.ops_upsert_alert(
        'dup_webhook:' || r.stripe_payment_intent_id,
        'duplication', 'warning', 'system', 'backend',
        'Repeated Webhook Processing',
        'Payment intent ' || r.stripe_payment_intent_id || ' processed ' || r.dup_count || ' times',
        NULL, NULL, (r.payment_ids)[1], NULL, 'stripe_pi', r.stripe_payment_intent_id,
        jsonb_build_object('stripe_pi', r.stripe_payment_intent_id, 'dup_count', r.dup_count)
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 3f. Repeated guest booking submissions: same guest submitting multiple times quickly
CREATE OR REPLACE FUNCTION public.ops_detect_repeated_guest_submissions()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_count int := 0; r record;
BEGIN
  FOR r IN
    SELECT t.passenger_phone, t.passenger_name, count(*) as submission_count,
           min(t.id) as first_trip_id, t.service_area_id
    FROM public.trips t
    WHERE t.booking_source = 'guest'
      AND t.created_at > now() - interval '30 minutes'
      AND t.passenger_phone IS NOT NULL
    GROUP BY t.passenger_phone, t.passenger_name, t.service_area_id
    HAVING count(*) >= 3
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.ops_alerts oa
      WHERE oa.fingerprint = 'dup_guest_submit:' || COALESCE(r.passenger_phone, '') || ':' || date_trunc('hour', now())::text
        AND oa.status IN ('open', 'acknowledged')
    ) THEN
      PERFORM public.ops_upsert_alert(
        'dup_guest_submit:' || COALESCE(r.passenger_phone, '') || ':' || date_trunc('hour', now())::text,
        'duplication', 'warning', 'system', 'guest',
        'Repeated Guest Submissions',
        COALESCE(r.passenger_name, 'Unknown') || ' submitted ' || r.submission_count || ' bookings in 30 minutes',
        r.first_trip_id, NULL, NULL, NULL, NULL, NULL,
        jsonb_build_object('passenger_phone', r.passenger_phone, 'submission_count', r.submission_count)
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;


-- =============================================
-- 4. UPDATE ops_run_all_detections to include ALL functions
-- =============================================

CREATE OR REPLACE FUNCTION public.ops_run_all_detections()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_results jsonb := '{}'::jsonb;
BEGIN
  -- Financial detections (existing)
  v_results := v_results || jsonb_build_object('missing_commissions', public.ops_detect_missing_commissions());
  v_results := v_results || jsonb_build_object('missing_earnings', public.ops_detect_missing_earnings());
  v_results := v_results || jsonb_build_object('failed_payments', public.ops_detect_failed_payments());
  v_results := v_results || jsonb_build_object('failed_payouts', public.ops_detect_failed_payouts());
  v_results := v_results || jsonb_build_object('stuck_dispatch', public.ops_detect_stuck_dispatch());

  -- Duplication detections (existing + new)
  v_results := v_results || jsonb_build_object('duplicate_payments', public.ops_detect_duplicate_payments());
  v_results := v_results || jsonb_build_object('duplicate_commissions', public.ops_detect_duplicate_commissions());
  v_results := v_results || jsonb_build_object('duplicate_bookings', public.ops_detect_duplicate_bookings());
  v_results := v_results || jsonb_build_object('duplicate_payouts', public.ops_detect_duplicate_payouts());
  v_results := v_results || jsonb_build_object('duplicate_earnings', public.ops_detect_duplicate_earnings());
  v_results := v_results || jsonb_build_object('duplicate_dispatches', public.ops_detect_duplicate_dispatches());
  v_results := v_results || jsonb_build_object('repeated_webhooks', public.ops_detect_repeated_webhooks());
  v_results := v_results || jsonb_build_object('repeated_guest_submissions', public.ops_detect_repeated_guest_submissions());

  -- Guest booking detections (new)
  v_results := v_results || jsonb_build_object('guest_quote_failures', public.ops_detect_guest_quote_failures());
  v_results := v_results || jsonb_build_object('guest_checkout_failures', public.ops_detect_guest_checkout_failures());
  v_results := v_results || jsonb_build_object('guest_booking_not_confirmed', public.ops_detect_guest_booking_not_confirmed());
  v_results := v_results || jsonb_build_object('guest_dropoffs', public.ops_detect_guest_dropoffs());
  v_results := v_results || jsonb_build_object('guest_latency', public.ops_detect_guest_latency());

  -- Log-based detections (new)
  v_results := v_results || jsonb_build_object('error_spikes', public.ops_detect_error_spikes());
  v_results := v_results || jsonb_build_object('fatal_logs', public.ops_detect_fatal_logs());
  v_results := v_results || jsonb_build_object('5xx_spikes', public.ops_detect_5xx_spikes());
  v_results := v_results || jsonb_build_object('latency_spikes', public.ops_detect_latency_spikes());
  v_results := v_results || jsonb_build_object('edge_function_failures', public.ops_detect_edge_function_failures());
  v_results := v_results || jsonb_build_object('webhook_failures', public.ops_detect_webhook_failures());

  RETURN v_results;
END;
$$;
