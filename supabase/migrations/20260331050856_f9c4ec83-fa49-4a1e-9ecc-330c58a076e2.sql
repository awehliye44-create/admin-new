
-- ============================================================
-- ONECAB Ops Intelligence - Phase 2: Detection & Alert Engine
-- ============================================================

-- 1. Core function: Upsert an alert with fingerprint dedup
CREATE OR REPLACE FUNCTION public.ops_upsert_alert(
  p_fingerprint text,
  p_category text,
  p_severity text,
  p_source text,
  p_app text,
  p_title text,
  p_description text DEFAULT NULL,
  p_related_trip_id uuid DEFAULT NULL,
  p_related_driver_id uuid DEFAULT NULL,
  p_related_payment_id uuid DEFAULT NULL,
  p_related_payout_batch_id uuid DEFAULT NULL,
  p_related_entity_type text DEFAULT NULL,
  p_related_entity_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_alert_id uuid;
BEGIN
  -- Try to update existing open/acknowledged alert with same fingerprint
  UPDATE public.ops_alerts
  SET
    fingerprint_count = fingerprint_count + 1,
    last_detected_at = now(),
    severity = CASE WHEN p_severity = 'fatal' THEN 'fatal'
                    WHEN p_severity = 'critical' AND severity != 'fatal' THEN 'critical'
                    ELSE severity END,
    metadata = metadata || p_metadata,
    updated_at = now()
  WHERE fingerprint = p_fingerprint
    AND status IN ('open', 'acknowledged')
  RETURNING id INTO v_alert_id;

  IF v_alert_id IS NULL THEN
    INSERT INTO public.ops_alerts (
      fingerprint, category, severity, source, app, title, description,
      related_trip_id, related_driver_id, related_payment_id, related_payout_batch_id,
      related_entity_type, related_entity_id, metadata
    ) VALUES (
      p_fingerprint, p_category, p_severity, p_source, p_app, p_title, p_description,
      p_related_trip_id, p_related_driver_id, p_related_payment_id, p_related_payout_batch_id,
      p_related_entity_type, p_related_entity_id, p_metadata
    )
    RETURNING id INTO v_alert_id;
  END IF;

  RETURN v_alert_id;
END;
$$;

-- 2. Record an ops event and optionally create an alert
CREATE OR REPLACE FUNCTION public.ops_record_event(
  p_event_type text,
  p_category text,
  p_severity text DEFAULT 'warning',
  p_app text DEFAULT NULL,
  p_trip_id uuid DEFAULT NULL,
  p_driver_id uuid DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_payment_id uuid DEFAULT NULL,
  p_payout_batch_id uuid DEFAULT NULL,
  p_service_area_id uuid DEFAULT NULL,
  p_amount_pence int DEFAULT NULL,
  p_currency_code text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_create_alert boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_event_id uuid;
  v_alert_id uuid;
  v_fingerprint text;
BEGIN
  INSERT INTO public.ops_events (
    event_type, category, severity, app, trip_id, driver_id, customer_id,
    payment_id, payout_batch_id, service_area_id, amount_pence, currency_code,
    description, metadata
  ) VALUES (
    p_event_type, p_category, p_severity, p_app, p_trip_id, p_driver_id, p_customer_id,
    p_payment_id, p_payout_batch_id, p_service_area_id, p_amount_pence, p_currency_code,
    p_description, p_metadata
  )
  RETURNING id INTO v_event_id;

  IF p_create_alert THEN
    -- Build fingerprint from event type + relevant IDs
    v_fingerprint := p_event_type || ':' || COALESCE(p_trip_id::text, '') || ':' || COALESCE(p_driver_id::text, '') || ':' || COALESCE(p_payment_id::text, '');

    v_alert_id := public.ops_upsert_alert(
      p_fingerprint := v_fingerprint,
      p_category := p_category,
      p_severity := p_severity,
      p_source := 'system',
      p_app := p_app,
      p_title := INITCAP(REPLACE(p_event_type, '_', ' ')),
      p_description := p_description,
      p_related_trip_id := p_trip_id,
      p_related_driver_id := p_driver_id,
      p_related_payment_id := p_payment_id,
      p_related_payout_batch_id := p_payout_batch_id,
      p_metadata := p_metadata
    );

    UPDATE public.ops_events SET alert_id = v_alert_id WHERE id = v_event_id;
  END IF;

  RETURN v_event_id;
END;
$$;

-- 3. Alert actions: acknowledge, resolve, suppress
CREATE OR REPLACE FUNCTION public.ops_acknowledge_alert(p_alert_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  UPDATE public.ops_alerts
  SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = p_user_id, updated_at = now()
  WHERE id = p_alert_id AND status = 'open';
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_resolve_alert(p_alert_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  UPDATE public.ops_alerts
  SET status = 'resolved', resolved_at = now(), resolved_by = p_user_id, updated_at = now()
  WHERE id = p_alert_id AND status IN ('open', 'acknowledged');
  
  -- Mark related events as resolved
  UPDATE public.ops_events
  SET resolved = true, resolved_at = now()
  WHERE alert_id = p_alert_id AND resolved = false;
END;
$$;

CREATE OR REPLACE FUNCTION public.ops_suppress_alert(p_alert_id uuid, p_until timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  UPDATE public.ops_alerts
  SET status = 'suppressed', suppressed_until = p_until, updated_at = now()
  WHERE id = p_alert_id;
END;
$$;

-- 4. Detection: Scan for missing commissions on completed trips
CREATE OR REPLACE FUNCTION public.ops_detect_missing_commissions()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_count int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT t.id as trip_id, t.driver_id, t.service_area_id, t.gross_fare_pence
    FROM public.trips t
    LEFT JOIN public.trip_finance tf ON tf.trip_id = t.id
    WHERE t.status = 'completed'
      AND t.completed_at > now() - interval '24 hours'
      AND t.gross_fare_pence > 0
      AND (tf.id IS NULL OR tf.platform_commission_pence IS NULL OR tf.platform_commission_pence = 0)
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_events oe
        WHERE oe.trip_id = t.id AND oe.event_type = 'commission_missing' AND oe.resolved = false
      )
  LOOP
    PERFORM public.ops_record_event(
      'commission_missing', 'commission', 'critical', 'backend',
      r.trip_id, r.driver_id, NULL, NULL, NULL, r.service_area_id,
      r.gross_fare_pence, NULL,
      'Completed trip has no commission recorded in trip_finance',
      jsonb_build_object('gross_fare_pence', r.gross_fare_pence)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 5. Detection: Scan for missing driver earnings
CREATE OR REPLACE FUNCTION public.ops_detect_missing_earnings()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_count int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT t.id as trip_id, t.driver_id, t.gross_fare_pence
    FROM public.trips t
    WHERE t.status = 'completed'
      AND t.completed_at > now() - interval '24 hours'
      AND t.driver_id IS NOT NULL
      AND t.gross_fare_pence > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.driver_ledger dl
        WHERE dl.trip_id = t.id AND dl.entry_type IN ('TRIP_EARNING_NET', 'CASH_COMMISSION_DEBT')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_events oe
        WHERE oe.trip_id = t.id AND oe.event_type = 'earning_missing' AND oe.resolved = false
      )
  LOOP
    PERFORM public.ops_record_event(
      'earning_missing', 'earning', 'critical', 'backend',
      r.trip_id, r.driver_id, NULL, NULL, NULL, NULL,
      r.gross_fare_pence, NULL,
      'Completed trip has no driver ledger entry'
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 6. Detection: Failed payments
CREATE OR REPLACE FUNCTION public.ops_detect_failed_payments()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_count int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT p.id as payment_id, p.trip_id, p.driver_id, p.amount_pence, p.currency, p.last_error
    FROM public.payments p
    WHERE p.status IN ('failed', 'canceled')
      AND p.updated_at > now() - interval '1 hour'
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_events oe
        WHERE oe.payment_id = p.id AND oe.event_type = 'payment_failed' AND oe.resolved = false
      )
  LOOP
    PERFORM public.ops_record_event(
      'payment_failed', 'payment', 'critical', 'backend',
      r.trip_id, r.driver_id, NULL, r.payment_id, NULL, NULL,
      r.amount_pence, r.currency,
      'Payment failed: ' || COALESCE(r.last_error, 'Unknown error'),
      jsonb_build_object('last_error', r.last_error)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 7. Detection: Failed payouts
CREATE OR REPLACE FUNCTION public.ops_detect_failed_payouts()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_count int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT pb.id, pb.total_amount_pence, pb.failed_payouts, pb.notes
    FROM public.payout_batches pb
    WHERE pb.status = 'failed'
      AND pb.updated_at > now() - interval '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_events oe
        WHERE oe.payout_batch_id = pb.id AND oe.event_type = 'payout_failed' AND oe.resolved = false
      )
  LOOP
    PERFORM public.ops_record_event(
      'payout_failed', 'payout', 'critical', 'backend',
      NULL, NULL, NULL, NULL, r.id, NULL,
      r.total_amount_pence, NULL,
      'Payout batch failed: ' || COALESCE(r.notes, 'No details'),
      jsonb_build_object('failed_count', r.failed_payouts)
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 8. Detection: Stuck dispatch (trips searching for > 15 min)
CREATE OR REPLACE FUNCTION public.ops_detect_stuck_dispatch()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_count int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT t.id as trip_id, t.service_area_id,
           EXTRACT(EPOCH FROM (now() - t.created_at))/60 as minutes_waiting
    FROM public.trips t
    WHERE t.status IN ('pending', 'searching', 'offered')
      AND t.created_at < now() - interval '15 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM public.ops_events oe
        WHERE oe.trip_id = t.id AND oe.event_type = 'dispatch_stuck' AND oe.resolved = false
      )
  LOOP
    PERFORM public.ops_record_event(
      'dispatch_stuck', 'dispatch', 'warning', 'backend',
      r.trip_id, NULL, NULL, NULL, NULL, r.service_area_id,
      NULL, NULL,
      'Trip stuck in dispatch for ' || round(r.minutes_waiting) || ' minutes',
      jsonb_build_object('minutes_waiting', round(r.minutes_waiting))
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 9. Detection: Duplicate payments (same trip, multiple successful payments)
CREATE OR REPLACE FUNCTION public.ops_detect_duplicate_payments()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_count int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT p.trip_id, COUNT(*) as payment_count, SUM(p.amount_pence) as total_pence
    FROM public.payments p
    WHERE p.status IN ('succeeded', 'captured')
      AND p.created_at > now() - interval '24 hours'
      AND p.trip_id IS NOT NULL
    GROUP BY p.trip_id
    HAVING COUNT(*) > 1
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.ops_events oe
      WHERE oe.trip_id = r.trip_id AND oe.event_type = 'duplicate_payment' AND oe.resolved = false
    ) THEN
      PERFORM public.ops_record_event(
        'duplicate_payment', 'duplication', 'critical', 'backend',
        r.trip_id, NULL, NULL, NULL, NULL, NULL,
        r.total_pence, NULL,
        'Trip has ' || r.payment_count || ' successful payments',
        jsonb_build_object('payment_count', r.payment_count, 'total_pence', r.total_pence)
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 10. Detection: Duplicate commissions (same trip, multiple commission ledger entries)
CREATE OR REPLACE FUNCTION public.ops_detect_duplicate_commissions()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_count int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT dl.trip_id, dl.driver_id, COUNT(*) as entry_count
    FROM public.driver_ledger dl
    WHERE dl.entry_type = 'COMPANY_COMMISSION'
      AND dl.created_at > now() - interval '24 hours'
      AND dl.trip_id IS NOT NULL
    GROUP BY dl.trip_id, dl.driver_id
    HAVING COUNT(*) > 1
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.ops_events oe
      WHERE oe.trip_id = r.trip_id AND oe.event_type = 'duplicate_commission' AND oe.resolved = false
    ) THEN
      PERFORM public.ops_record_event(
        'duplicate_commission', 'duplication', 'warning', 'backend',
        r.trip_id, r.driver_id, NULL, NULL, NULL, NULL,
        NULL, NULL,
        'Trip has ' || r.entry_count || ' commission entries'
      );
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 11. Master scan function that runs all detections
CREATE OR REPLACE FUNCTION public.ops_run_all_detections()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_results jsonb := '{}'::jsonb;
BEGIN
  v_results := v_results || jsonb_build_object('missing_commissions', public.ops_detect_missing_commissions());
  v_results := v_results || jsonb_build_object('missing_earnings', public.ops_detect_missing_earnings());
  v_results := v_results || jsonb_build_object('failed_payments', public.ops_detect_failed_payments());
  v_results := v_results || jsonb_build_object('failed_payouts', public.ops_detect_failed_payouts());
  v_results := v_results || jsonb_build_object('stuck_dispatch', public.ops_detect_stuck_dispatch());
  v_results := v_results || jsonb_build_object('duplicate_payments', public.ops_detect_duplicate_payments());
  v_results := v_results || jsonb_build_object('duplicate_commissions', public.ops_detect_duplicate_commissions());
  RETURN v_results;
END;
$$;

-- 12. Summary view for dashboard health cards
CREATE OR REPLACE VIEW public.ops_health_summary AS
SELECT
  category,
  COUNT(*) FILTER (WHERE status = 'open') as open_count,
  COUNT(*) FILTER (WHERE status = 'acknowledged') as acknowledged_count,
  COUNT(*) FILTER (WHERE status = 'resolved') as resolved_count,
  COUNT(*) FILTER (WHERE severity = 'critical' AND status IN ('open', 'acknowledged')) as critical_count,
  COUNT(*) FILTER (WHERE severity = 'fatal' AND status IN ('open', 'acknowledged')) as fatal_count,
  MAX(last_detected_at) FILTER (WHERE status IN ('open', 'acknowledged')) as latest_alert_at
FROM public.ops_alerts
WHERE created_at > now() - interval '24 hours'
GROUP BY category;
